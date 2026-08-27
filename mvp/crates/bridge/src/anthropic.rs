//! The model adapter: one streaming call to the messages API, SSE events
//! mapped onto the wire's delta stream. `content_block_start` becomes the
//! `block` marker, every chunk becomes a plain `delta` (one token stream;
//! markers, not typed deltas). Hand-rolled SSE: the format is `event:` and
//! `data:` lines, and a dependency is a decision this doesn't earn.

use std::sync::{Arc, RwLock};

use futures::StreamExt;
use serde_json::{Value, json};

use wire::ConversationId;

use crate::retry::{ConnectFailure, RetryPolicy};

/// The live `retry` cell. Read when a failure has to be decided on rather
/// than captured when a query starts, so a policy set or cleared over stdio
/// reaches the next failure of a conversation already running. A wait already
/// under way was computed before it began and runs to its full length.
pub type RetryCell = Arc<RwLock<Option<RetryPolicy>>>;

/// Built once at startup (main.rs) and threaded down through `AgentConfig`/
/// `TurnContext` alongside the NATS client, `Auth`, and every other shared
/// resource — the same pattern this crate already uses for state that many
/// concurrent conversations share, not a special case for this one. A
/// multi-agent headless bridge can easily have several of these streaming
/// requests open to the messages API at once, and `reqwest::Client`'s pool
/// (cheap to clone; internally `Arc`-backed) is built for exactly that kind
/// of concurrent, shared use — each request still gets its own connection
/// (no `http2` cargo feature is enabled; see `Cargo.toml`'s comment on
/// keeping this crate's reqwest footprint to plain streamed HTTPS), but the
/// pool still avoids a fresh TCP+TLS handshake per turn.
///
/// Keepalive is the point of building it explicitly rather than
/// `Client::new()`: a streaming request sits genuinely idle at the TCP level
/// for however long the model takes to produce its first byte (extended
/// thinking can be a long wait), and with no traffic at all in that window
/// some path in between — a NAT, a firewall, Windows' own stack, a corporate
/// proxy — can decide the connection is dead and reset it, surfacing here as
/// `os error 10054` ("An existing connection was forcibly closed by the
/// remote host") on Windows specifically, though nothing about the cause is
/// actually Windows-only. TCP keepalive gives the connection a heartbeat so
/// it's never mistaken for dead during that idle stretch.
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

/// Both ways of being allowed in: a platform API key, or the Claude Code
/// subscription credential (bearer plus the oauth beta header). The
/// credential is held as its SOURCE, never the secret: `bridge-auth` reads
/// it back from the store on every request, so nothing sits at rest here and
/// a token some other process has rotated is picked up rather than served
/// stale. A spent token is renewed in place, once however many conversations
/// find it spent at the same moment.
#[derive(Clone)]
pub enum Auth {
    /// `ANTHROPIC_API_KEY`, read from the environment at each request.
    ApiKey,
    /// The stored subscription credential, read and renewed at each request.
    OAuth(Arc<bridge_auth::Credentials>),
}

impl Auth {
    /// Decide the source (`ANTHROPIC_API_KEY` wins), failing fast if neither
    /// is there — a misconfiguration surfaces at startup, not on the first
    /// turn.
    ///
    /// Obtaining a credential never happens here. This process is spawned
    /// with its stdin belonging to whoever spawned it and no terminal of its
    /// own, so there is nowhere for a login to run; a missing credential is
    /// an error naming the command that creates one.
    pub fn resolve() -> anyhow::Result<Auth> {
        if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
            return Ok(Auth::ApiKey);
        }
        Ok(Auth::OAuth(Arc::new(bridge_auth::Credentials::resolve()?)))
    }

    /// Read the current credential and set the auth header. Fresh per
    /// request: the secret exists only for the duration of this call. Public
    /// so a caller can build the request bridge would send without sending
    /// it, credential and all, which is what makes a failing request
    /// reproducible by hand.
    pub async fn apply(
        &self,
        request: reqwest::RequestBuilder,
        http: &reqwest::Client,
    ) -> anyhow::Result<reqwest::RequestBuilder> {
        Ok(match self {
            Auth::ApiKey => {
                let key = std::env::var("ANTHROPIC_API_KEY")
                    .map_err(|_| anyhow::anyhow!("ANTHROPIC_API_KEY is no longer set"))?;
                request.header("x-api-key", key)
            }
            Auth::OAuth(credentials) => request
                .header(
                    "authorization",
                    format!("Bearer {}", credentials.access_token(http).await?),
                )
                .header("anthropic-beta", bridge_auth::oauth::BETA_HEADER),
        })
    }
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
    let Some(blocks) = messages
        .last_mut()
        .and_then(|m| m["content"].as_array_mut())
    else {
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

/// The turn's own boundary onto NATS: publishing streamed deltas as they
/// arrive (`content_block_start`/`content_block_delta`). Deliberately not
/// `Broker` — request handling's seam covers the conversation record's
/// subscribe/publish/replay/fetch traffic; a turn's delta stream is a
/// different concern that happens to share a transport in production, so
/// it gets its own narrow trait rather than growing `Broker` to cover a
/// caller it wasn't shaped for.
pub trait DeltaSink: Clone + Send + Sync + 'static {
    fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send;
}

#[derive(Clone)]
pub struct NatsDeltaSink(pub async_nats::Client);

impl DeltaSink for NatsDeltaSink {
    async fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.0
            .publish(subject, payload.into())
            .await
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
    }
}

/// A delta sink that publishes nothing — test doubles that never drive a
/// query far enough to reach a model call still need a value to satisfy
/// the generic parameter. This type lives in the binary's own anthropic
/// module (unlike bridge-testkit's fakes, which sit in a separate
/// dev-dependency crate because the library and binary targets compile
/// separately), so a plain `cfg(test)` already keeps it out of a normal
/// build: the binary's own test compilation is what turns `cfg(test)` on
/// here.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct NoopDeltaSink;

#[cfg(test)]
impl DeltaSink for NoopDeltaSink {
    async fn publish(
        &self,
        _subject: String,
        _payload: Vec<u8>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
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

/// The whole request body for one turn. Pulled out as a pure function so
/// what bridge actually sends is a literal-value test rather than something
/// only a live API call can catch.
///
/// `max_tokens` always rides. `thinking` and `output_config` are omitted
/// entirely when unset, which is not the same as sent empty.
fn request_body(
    model: &crate::model::Resolved,
    system: Vec<Value>,
    messages: Vec<Value>,
    tools: &[Value],
) -> Value {
    let mut body = json!({
        "model": model.name,
        "max_tokens": model.max_tokens,
        "stream": true,
        "system": system,
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if let Some(thinking) = model.thinking_field() {
        body["thinking"] = thinking;
    }
    if let Some(output_config) = model.output_config() {
        body["output_config"] = output_config;
    }
    body
}

/// The messages request short of its credential: the url, the version header
/// and the body. Public so a caller reproducing a request by hand builds the
/// one bridge actually sends, and stays right when the url or the version
/// moves.
pub fn message_request(http: &reqwest::Client, body: &Value) -> reqwest::RequestBuilder {
    http.post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .json(body)
}

/// The connect phase: the request up to and including the response status,
/// retried under whatever policy the `retry` cell holds at the moment each
/// failure lands. A response that has begun streaming is past this point and
/// is never retried, because a partial stream cannot be replayed into the
/// same turn.
///
/// A retry is this turn attempted again, not a new one: the ids are the
/// caller's and nothing is published here, so from outside the only
/// difference is a turn that took longer.
///
/// Retrying only inserts attempts ahead of the failure path and never alters
/// it. With no policy the first failure goes down it exactly as before this
/// existed; with an exhausted policy the last one does, and it is the last
/// attempt's error that surfaces, since that is the state the request was in
/// when bridge gave up. The earlier attempts are in the console log.
///
/// A cancel needs nothing here: the caller races this whole future against
/// the cancel signal, so dropping it abandons a backoff wait mid-sleep.
async fn connect(
    http: &reqwest::Client,
    auth: &Auth,
    body: &Value,
    conv: &ConversationId,
    retry: &RetryCell,
) -> anyhow::Result<reqwest::Response> {
    let mut attempt: u32 = 1;
    loop {
        // An auth failure is local configuration rather than a connect
        // failure — it has no representation in ConnectFailure — so it
        // surfaces immediately, as it always did.
        let sent = auth
            .apply(message_request(http, body), http)
            .await?
            .send()
            .await;

        let (failure, reported, error) = match sent {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(crate::retry::parse_retry_after);
                let text = response.text().await.unwrap_or_default();
                (
                    ConnectFailure::Status {
                        code: status.as_u16(),
                        retry_after,
                    },
                    crate::retry::describe(status.as_u16(), &text, retry_after),
                    anyhow::anyhow!("messages API {status}: {text}"),
                )
            }
            Err(e) => {
                let error = anyhow::Error::new(e);
                let reported = format!("no response: {error:#}");
                (ConnectFailure::NoResponse, reported, error)
            }
        };

        let policy = *retry.read().unwrap();
        let wait = policy.and_then(|policy| {
            crate::retry::next_delay(&failure, attempt, &policy, crate::retry::jitter_fraction())
        });
        let Some(wait) = wait else {
            eprintln!(
                "bridge[{}]: connect attempt {attempt} failed: {reported}; giving up",
                conv.0
            );
            return Err(error);
        };
        eprintln!(
            "bridge[{}]: connect attempt {attempt} failed: {reported}; retrying in {}ms",
            conv.0,
            wait.as_millis()
        );
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// The block the system array always leads with: subscription (OAuth) access
/// requires the request to declare the Agent SDK identity. Public because a
/// caller building its own body for `stream_body` has to lead with it too,
/// and a retyped copy of a string the API checks is a copy that can drift.
pub const AGENT_SDK_PREFIX: &str = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/// Stream one turn: build the body bridge shapes for a served conversation,
/// then hand it to `stream_body`. `tools` is the API `tools` array; empty =
/// the no-tools call as before.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn<D: DeltaSink>(
    sink: &D,
    http: &reqwest::Client,
    conv: &ConversationId,
    auth: &Auth,
    model: &crate::model::Resolved,
    system: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    attach: &Option<bridge::attach::AttachHandle>,
    retry: &RetryCell,
) -> anyhow::Result<TurnDone> {
    // The spawn's own system prompt follows the identity prefix as a second
    // block.
    let mut system_blocks = vec![json!({ "type": "text", "text": AGENT_SDK_PREFIX })];
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
    let body = request_body(model, system_blocks, messages, tools);

    stream_body(sink, http, conv, auth, &body, attach, retry).await
}

/// Stream one turn from a body the caller built: publish `block`/`delta` as
/// chunks arrive, accumulate the content blocks for the commit, and return the
/// round's accounting.
///
/// The seam exists for a caller whose request bridge does not shape (a
/// one-shot call wanting its own `output_config` and no cache breakpoints,
/// say), so it can still have the connect-with-retry phase, the SSE fold and
/// the accounting rather than a second copy of them. The body is sent as given:
/// `stream: true` and the `AGENT_SDK_PREFIX` system block are the caller's to
/// include.
pub async fn stream_body<D: DeltaSink>(
    sink: &D,
    http: &reqwest::Client,
    conv: &ConversationId,
    auth: &Auth,
    body: &Value,
    attach: &Option<bridge::attach::AttachHandle>,
    retry: &RetryCell,
) -> anyhow::Result<TurnDone> {
    let response = connect(http, auth, body, conv, retry).await?;

    // v2's one deliberately flat subject: delta and block keep their body
    // `type`; the leaf does not spell it here. Deltas mirror onto the attach
    // fd like every other publish — they're the whole point of a live TUI.
    let deltas_subject = format!("conv.v2.{}.deltas", conv.0);
    let publish = |payload: Value| {
        let sink = sink.clone();
        let subject = deltas_subject.clone();
        let attach = attach.clone();
        async move {
            let bytes = serde_json::to_vec(&payload).expect("json! cannot fail");
            bridge::attach::tee(&attach, &subject, &bytes).await;
            // Fixing the trait's shape here (Result, not swallowed inside
            // it) without also fixing what a turn does when a delta fails to
            // publish is a separate, larger change than this refactor's
            // scope — same behaviour as before: drop it explicitly.
            let _ = sink.publish(subject, bytes).await;
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

    /// The connect loop against a stand-in for the whole network: an HTTP
    /// proxy every request is routed to, whose only behaviour is to accept
    /// the connection and drop it. The messages API is never reached, so
    /// every attempt fails as `NoResponse`, and the accept count is exactly
    /// the number of attempts the loop made.
    mod connecting {
        use std::sync::atomic::{AtomicU32, Ordering};

        use bridge_testkit::TestScratch;

        use super::*;

        async fn dead_network() -> (reqwest::Client, Arc<AtomicU32>) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let attempts = Arc::new(AtomicU32::new(0));
            let counter = Arc::clone(&attempts);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    counter.fetch_add(1, Ordering::SeqCst);
                    drop(stream);
                }
            });
            let client = reqwest::Client::builder()
                .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
                .build()
                .unwrap();
            (client, attempts)
        }

        /// A credential the request can be signed with that costs no network:
        /// an unspent token in a scratch file, so nothing here reaches the
        /// token endpoint or the ambient environment.
        fn auth(scratch: &TestScratch) -> Auth {
            let path = scratch.path("credentials.json");
            std::fs::write(
                &path,
                r#"{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":99999999999999}}"#,
            )
            .unwrap();
            Auth::OAuth(Arc::new(bridge_auth::Credentials::new(
                bridge_auth::Store::File { path },
            )))
        }

        /// Short enough to run at full speed, and still doubling: 10ms, 20ms,
        /// 40ms across three retries.
        fn policy(max_retries: u32) -> RetryCell {
            Arc::new(RwLock::new(
                crate::retry::parse(&json!({
                    "maxRetries": max_retries,
                    "baseDelayMs": 10,
                    "maxDelayMs": 40,
                    "retryAfterCapMs": 1000,
                }))
                .unwrap(),
            ))
        }

        async fn attempts_made(retry: &RetryCell, scratch: &TestScratch) -> u32 {
            let (http, attempts) = dead_network().await;
            let outcome = connect(
                &http,
                &auth(scratch),
                &json!({}),
                &ConversationId("conv-retry".to_string()),
                retry,
            )
            .await;

            assert!(outcome.is_err(), "the dead network cannot succeed");
            attempts.load(Ordering::SeqCst)
        }

        /// Bridge exactly as it behaved before any of this existed.
        #[tokio::test]
        async fn with_no_policy_the_first_failure_ends_the_turn() {
            let expected = 1;
            let scratch = TestScratch::new("connect-no-policy");

            let actual = attempts_made(&Arc::new(RwLock::new(None)), &scratch).await;

            assert_eq!(actual, expected);
        }

        /// Three retries inserted ahead of the failure path: four attempts,
        /// then the same abort as before.
        #[tokio::test]
        async fn a_policy_inserts_exactly_its_retries_ahead_of_the_failure() {
            let expected = 4;
            let scratch = TestScratch::new("connect-retries");

            let actual = attempts_made(&policy(3), &scratch).await;

            assert_eq!(actual, expected);
        }

        /// The cell is read at the moment each failure is decided on, not
        /// captured when the turn started, so clearing it mid-backoff stops
        /// the retrying there and then.
        #[tokio::test]
        async fn clearing_the_policy_mid_flight_stops_the_retrying() {
            let expected = 1;
            let scratch = TestScratch::new("connect-cleared");
            let retry = policy(10);
            *retry.write().unwrap() = None;

            let actual = attempts_made(&retry, &scratch).await;

            assert_eq!(actual, expected);
        }

        /// What surfaces when the policy is exhausted is the failed attempt's
        /// own error, not something the retrying invented on top of it. A
        /// request that never reached a server has no status, so the status
        /// wording must be nowhere in it.
        #[tokio::test]
        async fn giving_up_surfaces_the_connect_failure_itself() {
            let expected = false;
            let scratch = TestScratch::new("connect-error");
            let (http, _) = dead_network().await;

            let error = connect(
                &http,
                &auth(&scratch),
                &json!({}),
                &ConversationId("conv-retry".to_string()),
                &policy(1),
            )
            .await
            .expect_err("the dead network cannot succeed");
            let actual = format!("{error:#}").contains("messages API");

            assert_eq!(actual, expected, "{error:#}");
        }

        /// The caller races this future against the cancel signal, so a
        /// cancel during a backoff wait takes effect immediately rather than
        /// after the wait. Ten minutes of backoff, abandoned at once.
        #[tokio::test]
        async fn a_cancel_during_a_backoff_wait_takes_effect_immediately() {
            let expected = Some(true);
            let scratch = TestScratch::new("connect-cancel");
            let (http, _) = dead_network().await;
            let parked = Arc::new(RwLock::new(
                crate::retry::parse(&json!({
                    "maxRetries": 10,
                    "baseDelayMs": 600000,
                    "maxDelayMs": 600000,
                    "retryAfterCapMs": 600000,
                }))
                .unwrap(),
            ));
            let (tx, mut cancel) = tokio::sync::watch::channel(false);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = tx.send(true);
            });
            let auth = auth(&scratch);
            let body = json!({});
            let conv = ConversationId("conv-retry".to_string());

            // Bounded so a cancel that does wait out the backoff fails here
            // rather than hanging the suite for the ten minutes it asked for.
            let actual = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::select! {
                    _ = connect(&http, &auth, &body, &conv, &parked) => false,
                    _ = crate::agent::cancelled(&mut cancel) => true,
                }
            })
            .await
            .ok();

            assert_eq!(actual, expected);
        }
    }

    mod request_body {
        use super::*;
        use crate::model::Settings;

        fn body(line: Value) -> Value {
            let model = Settings::default()
                .merged(&json!({ "name": "claude-opus-5", "maxTokens": 120000 }))
                .unwrap()
                .merged(&line)
                .unwrap()
                .resolve(None)
                .unwrap();
            super::request_body(&model, vec![], vec![], &[])
        }

        #[test]
        fn max_tokens_always_rides() {
            let expected = json!(120000);

            let actual = body(json!({}));

            assert_eq!(actual["max_tokens"], expected);
        }

        #[test]
        fn the_configured_name_is_the_model() {
            let expected = json!("claude-opus-5");

            let actual = body(json!({}));

            assert_eq!(actual["model"], expected);
        }

        #[test]
        fn adaptive_thinking_is_sent_exactly_as_configured() {
            let expected = json!({ "type": "adaptive", "display": "summarized" });

            let actual = body(json!({ "thinking": "adaptive", "thinkingDisplay": "summarized" }));

            assert_eq!(actual["thinking"], expected);
        }

        #[test]
        fn effort_is_sent_wrapped_as_output_config() {
            let expected = json!({ "effort": "xhigh" });

            let actual = body(json!({ "effort": "xhigh" }));

            assert_eq!(actual["output_config"], expected);
        }

        /// Omitted, not empty: the key is absent from the body entirely.
        #[test]
        fn thinking_unset_omits_the_field_entirely() {
            let expected = false;

            let actual = body(json!({ "effort": "low" }));

            assert_eq!(actual.get("thinking").is_some(), expected);
        }

        #[test]
        fn effort_unset_omits_output_config_entirely() {
            let expected = false;

            let actual = body(json!({ "thinking": "adaptive" }));

            assert_eq!(actual.get("output_config").is_some(), expected);
        }

        /// The legacy shape this replaced. It produced worse thinking than
        /// adaptive mode, so nothing may reintroduce it.
        #[test]
        fn no_budget_tokens_is_ever_sent() {
            let expected = false;

            let actual = body(json!({ "thinking": "adaptive" }));

            assert_eq!(actual["thinking"].get("budget_tokens").is_some(), expected);
        }
    }

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
