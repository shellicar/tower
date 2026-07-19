//! The model adapter: one streaming call to the messages API, SSE events
//! mapped onto the wire's delta stream. `content_block_start` becomes the
//! `block` marker, every chunk becomes a plain `delta` (one token stream;
//! markers, not typed deltas). Hand-rolled SSE: the format is `event:` and
//! `data:` lines, and a dependency is a decision this doesn't earn.

use futures::StreamExt;
use serde_json::{Value, json};

use wire::ConversationId;

pub const MAX_TOKENS: i64 = 8192;

/// The OAuth token endpoint and client id claude-sdk-cli itself uses
/// (packages/claude-sdk/src/private/Client/Auth/consts.ts) — refreshing a
/// Claude Code credential means speaking the same grant to the same client.
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// Both ways of being allowed in: a platform API key, or the Claude Code
/// subscription's OAuth token (bearer + the oauth beta header). The credential
/// is held as its SOURCE, never the secret: it is read fresh on every request,
/// so nothing sits at rest in memory and a token the file has since been
/// refreshed with (by this bridge or the CLI) is picked up. An expired token
/// is refreshed in place, matching claude-sdk-cli's own AnthropicAuth so the
/// two can share one credentials file live.
#[derive(Clone)]
pub enum Auth {
    /// `ANTHROPIC_API_KEY`, read from the environment at each request.
    ApiKey,
    /// The Claude Code credentials file, read (and refreshed) at each request.
    OAuth { path: String },
}

impl Auth {
    /// Decide the source (`ANTHROPIC_API_KEY` wins), failing fast if neither is
    /// present or the file carries no token — a misconfiguration surfaces at
    /// startup, not on the first turn. The secret read to validate is dropped,
    /// never stored.
    pub fn resolve() -> anyhow::Result<Auth> {
        if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
            return Ok(Auth::ApiKey);
        }
        let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("HOME not set"))?;
        let path = format!("{home}/.claude/.credentials.json");
        read_credentials(&path)?; // validate now, discard the secret
        Ok(Auth::OAuth { path })
    }

    /// Read the current credential and set the auth header. Fresh per request:
    /// the secret exists only for the duration of this call.
    async fn apply(
        &self,
        request: reqwest::RequestBuilder,
    ) -> anyhow::Result<reqwest::RequestBuilder> {
        Ok(match self {
            Auth::ApiKey => {
                let key = std::env::var("ANTHROPIC_API_KEY")
                    .map_err(|_| anyhow::anyhow!("ANTHROPIC_API_KEY is no longer set"))?;
                request.header("x-api-key", key)
            }
            Auth::OAuth { path } => request
                .header(
                    "authorization",
                    format!("Bearer {}", oauth_token(path).await?),
                )
                .header("anthropic-beta", "oauth-2025-04-20"),
        })
    }
}

/// Read the credentials file whole. Startup validation and every OAuth
/// request both start here.
fn read_credentials(path: &str) -> anyhow::Result<Value> {
    let bytes = std::fs::read(path)
        .map_err(|e| anyhow::anyhow!("no ANTHROPIC_API_KEY and no credentials at {path}: {e}"))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The current OAuth access token. Refreshes and rewrites the credentials
/// file first if `expiresAt` has passed — the same check claude-sdk-cli's
/// `isExpired` makes — so an expired token degrades to one extra round trip
/// instead of failing the turn. Called fresh per request; nothing cached.
async fn oauth_token(path: &str) -> anyhow::Result<String> {
    let mut creds = read_credentials(path)?;
    let expires_at = creds["claudeAiOauth"]["expiresAt"].as_i64().unwrap_or(0);
    if now_ms() >= expires_at {
        let refresh_token = creds["claudeAiOauth"]["refreshToken"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("{path} has no claudeAiOauth.refreshToken"))?
            .to_string();
        creds = refresh_credentials(&refresh_token).await?;
        // Write back so the next process — this bridge or a live claude-sdk-cli
        // sharing the same file — picks up the refreshed token too.
        std::fs::write(path, serde_json::to_vec_pretty(&creds)?)
            .map_err(|e| anyhow::anyhow!("failed to write refreshed credentials to {path}: {e}"))?;
    }
    creds["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("{path} has no claudeAiOauth.accessToken"))
}

/// POST the refresh_token grant (claude-sdk-cli's own
/// Auth/refreshCredentials.ts) and shape the reply to match the credentials
/// file's own schema (Auth/schema.ts's `authCredentials`), so the file stays
/// readable by the CLI too. `subscriptionType`/`rateLimitTier` reset to empty
/// on refresh — the token endpoint doesn't return them, and the reference
/// implementation does the same.
async fn refresh_credentials(refresh_token: &str) -> anyhow::Result<Value> {
    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!("token refresh failed: {status}");
    }
    let data: Value = response.json().await?;
    let access_token = data["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token refresh response has no access_token"))?;
    let new_refresh_token = data["refresh_token"].as_str().unwrap_or(refresh_token);
    let expires_in = data["expires_in"].as_i64().unwrap_or(0);
    let scopes: Vec<&str> = data["scope"]
        .as_str()
        .unwrap_or("")
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect();
    Ok(json!({
        "claudeAiOauth": {
            "accessToken": access_token,
            "refreshToken": new_refresh_token,
            "expiresAt": now_ms() + expires_in * 1000,
            "scopes": scopes,
            "subscriptionType": "",
            "rateLimitTier": "",
        }
    }))
}

/// Marks the last cacheable block of the last message with a 1h ephemeral
/// breakpoint — the moving half of the two breakpoints (the other is the
/// static system-block one in `stream_turn`), extending the cache
/// incrementally each turn. Pulled out as its own pure function so this is a
/// literal-value test, not something only a live API call can catch — an
/// empty text block broke exactly this the first time a resume send (empty
/// text, ws-spec's `text: ""`) reached it: the API rejects `cache_control`
/// on an empty text block outright, so this walks back to the nearest block
/// that isn't one, rather than assume the last block is always eligible.
fn mark_message_cache_breakpoint(messages: &mut [Value]) {
    let Some(blocks) = messages.last_mut().and_then(|m| m["content"].as_array_mut()) else {
        return;
    };
    let Some(block) = blocks
        .iter_mut()
        .rev()
        .find(|b| b["type"] != "text" || b["text"].as_str() != Some(""))
    else {
        // Every block in the last message is an empty text block (a resume
        // send with nothing else attached): no eligible breakpoint this
        // turn — the cache simply doesn't extend, never a reason to fail
        // the send.
        return;
    };
    block["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
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
    mark_message_cache_breakpoint(&mut messages);
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
        // `display: summarized` is required or newer models emit the signature
        // with no thinking text — the block arrives empty and renders blank.
        body["thinking"] =
            json!({ "type": "enabled", "budget_tokens": budget, "display": "summarized" });
    }

    let request = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let response = auth.apply(request).await?.send().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn has_cache_control(block: &Value) -> bool {
        block.get("cache_control").is_some()
    }

    #[test]
    fn marks_the_last_block_when_it_is_a_real_text_block() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }],
        })];
        mark_message_cache_breakpoint(&mut messages);
        assert!(has_cache_control(&messages[0]["content"][0]));
    }

    /// The exact bug this guards: a resume send (ws-spec `text: ""`) with no
    /// attachments has exactly one block, an empty text block — the API
    /// rejects a cache breakpoint on it outright ("cache_control cannot be
    /// set for empty text blocks"). No breakpoint must be set anywhere.
    #[test]
    fn sets_no_breakpoint_when_the_only_block_is_an_empty_text_block() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [{ "type": "text", "text": "" }],
        })];
        mark_message_cache_breakpoint(&mut messages);
        assert!(!has_cache_control(&messages[0]["content"][0]));
    }

    /// A resume send that also answers a dangling tool_use: the empty text
    /// block trails a real one. The breakpoint must land on the tool_result,
    /// never the trailing empty text block.
    #[test]
    fn walks_back_past_a_trailing_empty_text_block_to_a_real_one() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "ok" },
                { "type": "text", "text": "" },
            ],
        })];
        mark_message_cache_breakpoint(&mut messages);
        assert!(has_cache_control(&messages[0]["content"][0]));
        assert!(!has_cache_control(&messages[0]["content"][1]));
    }

    #[test]
    fn only_the_last_message_is_touched() {
        let mut messages = vec![
            json!({ "role": "user", "content": [{ "type": "text", "text": "first" }] }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "second" }] }),
        ];
        mark_message_cache_breakpoint(&mut messages);
        assert!(!has_cache_control(&messages[0]["content"][0]));
        assert!(has_cache_control(&messages[1]["content"][0]));
    }

    #[test]
    fn an_empty_message_list_is_a_no_op() {
        let mut messages: Vec<Value> = vec![];
        mark_message_cache_breakpoint(&mut messages); // must not panic
        assert!(messages.is_empty());
    }
}
