//! The model adapter: one streaming call to the messages API, SSE events
//! mapped onto the wire's delta stream. `content_block_start` becomes the
//! `block` marker, every chunk becomes a plain `delta` (one token stream;
//! markers, not typed deltas). Hand-rolled SSE: the format is `event:` and
//! `data:` lines, and a dependency is a decision this doesn't earn.

use futures::StreamExt;
use serde_json::{Value, json};

use wire::ConversationId;

pub const MAX_TOKENS: i64 = 8192;

/// Both ways of being allowed in: a platform API key, or the Claude Code
/// subscription's OAuth token (bearer + the oauth beta header). v0 does not
/// refresh; an expired token fails the turn honestly (`turn_aborted`).
#[derive(Clone)]
pub enum Auth {
    ApiKey(String),
    OAuth(String),
}

impl Auth {
    /// `ANTHROPIC_API_KEY` wins when set; otherwise the Claude Code
    /// credentials file (`~/.claude/.credentials.json`).
    pub fn resolve() -> anyhow::Result<Auth> {
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            return Ok(Auth::ApiKey(key));
        }
        let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("HOME not set"))?;
        let path = format!("{home}/.claude/.credentials.json");
        let bytes = std::fs::read(&path).map_err(|e| {
            anyhow::anyhow!("no ANTHROPIC_API_KEY and no credentials at {path}: {e}")
        })?;
        let creds: Value = serde_json::from_slice(&bytes)?;
        let token = creds["claudeAiOauth"]["accessToken"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("{path} has no claudeAiOauth.accessToken"))?;
        Ok(Auth::OAuth(token.to_string()))
    }

    fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Auth::ApiKey(key) => request.header("x-api-key", key),
            Auth::OAuth(token) => request
                .header("authorization", format!("Bearer {token}"))
                .header("anthropic-beta", "oauth-2025-04-20"),
        }
    }
}

pub struct TurnDone {
    pub content: Vec<Value>,
    pub stop_reason: String,
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    /// The 5m/1h split of cache_creation_tokens, from message_start's
    /// `usage.cache_creation`. We write only 1h breakpoints, so 1h should carry
    /// it and 5m sit at ~0 — publishing both is how that stays observable.
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
}

/// Stream one turn: publish `block`/`delta` as chunks arrive, accumulate the
/// content blocks for the commit, and return the round's accounting.
/// `tools` is the API `tools` array; empty = the no-tools call as before.
/// `thinking_budget` enables extended thinking when Some — the stream and
/// fold paths already carry thinking blocks; this is the ask.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn(
    client: &async_nats::Client,
    conv: &ConversationId,
    auth: &Auth,
    model: &str,
    system: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    thinking_budget: Option<i64>,
) -> anyhow::Result<TurnDone> {
    // The system array always leads with the Agent SDK identity prefix;
    // subscription (OAuth) access requires it. The spawn's own system prompt
    // follows as a second block.
    let mut system_blocks = vec![json!({
        "type": "text",
        "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    })];
    if let Some(system) = system {
        system_blocks.push(json!({ "type": "text", "text": system }));
    }
    // Cache breakpoints, 1h TTL. Prompt caching is prefix-based over the
    // canonical order tools → system → messages; a breakpoint caches everything
    // before it. Two earn their keep: the last system block caches the static
    // prefix (tools + system, identical every turn), and the last block of the
    // last message caches the conversation prefix so far — moving it each turn
    // extends the cache incrementally and reads the previous turn's write.
    // Without these the cache_creation/cache_read tokens sit at ~0.
    //
    // 1h, not the 5m default: a human-paced conversation easily gaps past five
    // minutes, and a lapsed cache is a full re-read at full price. Cache READS
    // dominate the bill, so the higher 1h write price is cheap insurance — 5m
    // is a coin-flip not worth taking. The 1h TTL is GA; no beta header.
    if let Some(last) = system_blocks.last_mut() {
        last["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
    }
    // Clone before marking: the caller's message tree is not ours to mutate.
    let mut messages = messages.to_vec();
    if let Some(block) = messages
        .last_mut()
        .and_then(|m| m["content"].as_array_mut())
        .and_then(|blocks| blocks.last_mut())
    {
        block["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
    }
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": system_blocks,
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if let Some(budget) = thinking_budget {
        // The API requires budget < max_tokens; clamp rather than error — a
        // misconfigured budget should degrade, not kill every turn.
        let budget = budget.clamp(1024, MAX_TOKENS - 1024);
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    }

    let request = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let response = auth.apply(request).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("messages API {status}: {text}");
    }

    // v2's one deliberately flat subject: delta and block keep their body
    // `type`; the leaf does not spell it here.
    let deltas_subject = format!("conv.v2.{}.deltas", conv.0);
    let publish = |payload: Value| {
        let client = client.clone();
        let subject = deltas_subject.clone();
        async move {
            let bytes = serde_json::to_vec(&payload).expect("json! cannot fail");
            let _ = client.publish(subject, bytes.into()).await;
        }
    };

    // The fold state: content blocks accumulate by index (the API streams
    // them strictly sequentially; order carries the structure). A tool_use
    // block's input streams as `partial_json` chunks; they accumulate here
    // and fold into the block's `input` when the block closes.
    let mut content: Vec<Value> = Vec::new();
    let mut open_json = String::new();
    let mut stop_reason = String::from("end_turn");
    let (mut input_tokens, mut cache_creation, mut cache_read, mut output_tokens) = (0, 0, 0, 0);
    let (mut cache_creation_5m, mut cache_creation_1h) = (0, 0);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        buffer.push_str(&String::from_utf8_lossy(&chunk?));

        // SSE frames are blank-line separated; a frame's payload is its
        // `data:` lines. Process every complete frame in the buffer.
        while let Some(pos) = buffer.find("\n\n") {
            let frame = buffer[..pos].to_string();
            buffer.drain(..pos + 2);
            let data: String = frame
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim_start)
                .collect();
            if data.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&data) else {
                continue; // tolerance: unparseable frames are skipped
            };

            match event["type"].as_str().unwrap_or("") {
                "message_start" => {
                    let usage = &event["message"]["usage"];
                    input_tokens = usage["input_tokens"].as_i64().unwrap_or(0);
                    cache_creation = usage["cache_creation_input_tokens"].as_i64().unwrap_or(0);
                    cache_read = usage["cache_read_input_tokens"].as_i64().unwrap_or(0);
                    // The breakdown lives on the message_start usage object
                    // (message_delta's usage has no cache_creation object).
                    let cc = &usage["cache_creation"];
                    cache_creation_5m = cc["ephemeral_5m_input_tokens"].as_i64().unwrap_or(0);
                    cache_creation_1h = cc["ephemeral_1h_input_tokens"].as_i64().unwrap_or(0);
                }
                "content_block_start" => {
                    finish_block(&mut content, &mut open_json);
                    let block = &event["content_block"];
                    let block_type = block["type"].as_str().unwrap_or("text").to_string();
                    publish(json!({ "type": "block", "blockType": block_type })).await;
                    // Seed the accumulating block; a tool_use start carries
                    // its id and name; the input arrives as partial_json.
                    content.push(block.clone());
                }
                "content_block_delta" => {
                    let delta = &event["delta"];
                    // Whatever the payload field, on the wire it is a plain
                    // delta: the next chunk of the one stream.
                    let text = delta["text"]
                        .as_str()
                        .or_else(|| delta["thinking"].as_str())
                        .or_else(|| delta["partial_json"].as_str())
                        .unwrap_or("");
                    if !text.is_empty() {
                        publish(json!({ "type": "delta", "text": text })).await;
                    }
                    // Fold into the open block for the commit.
                    if let Some(open) = content.last_mut() {
                        match delta["type"].as_str().unwrap_or("") {
                            "text_delta" => append_str(open, "text", text),
                            "thinking_delta" => append_str(open, "thinking", text),
                            "input_json_delta" => open_json.push_str(text),
                            "signature_delta" => append_str(
                                open,
                                "signature",
                                delta["signature"].as_str().unwrap_or(""),
                            ),
                            _ => {}
                        }
                    }
                }
                "message_delta" => {
                    if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                        stop_reason = reason.to_string();
                    }
                    if let Some(out) = event["usage"]["output_tokens"].as_i64() {
                        output_tokens = out;
                    }
                }
                "error" => {
                    anyhow::bail!("stream error: {}", event["error"]);
                }
                // content_block_stop, message_stop, ping: nothing to do;
                // order carries the structure.
                _ => {}
            }
        }
    }

    finish_block(&mut content, &mut open_json);

    Ok(TurnDone {
        content,
        stop_reason,
        input_tokens,
        cache_creation_tokens: cache_creation,
        cache_creation_5m_tokens: cache_creation_5m,
        cache_creation_1h_tokens: cache_creation_1h,
        cache_read_tokens: cache_read,
        output_tokens,
    })
}

/// Close the open block: a tool_use's accumulated `partial_json` becomes its
/// `input`. Unparseable JSON leaves the seeded input; the commit stays
/// well-formed and the model's next turn sees its own tool call as sent.
fn finish_block(content: &mut [Value], open_json: &mut String) {
    if open_json.is_empty() {
        return;
    }
    if let Some(open) = content.last_mut()
        && open["type"] == "tool_use"
        && let Ok(input) = serde_json::from_str::<Value>(open_json)
    {
        open["input"] = input;
    }
    open_json.clear();
}

/// Append a chunk to a string field, creating it if the start event carried
/// none (the API seeds `text: ""` on starts; tolerance costs nothing).
fn append_str(block: &mut Value, field: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    match block.get_mut(field) {
        Some(Value::String(s)) => s.push_str(chunk),
        _ => {
            block[field] = Value::String(chunk.to_string());
        }
    }
}
