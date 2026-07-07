//! SCRATCH HARNESS — not part of the deliverable.
//!
//! Minimal fake-model stub matching the spec's fake-model contract, bound to
//! port 8092 (this session's port; 8090 belongs to another session). Hand-rolled
//! HTTP over a TCP listener: the agent under test is the real HTTP client, the
//! stub only has to speak enough HTTP to serve one SSE response per request.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Deserialize)]
struct Request {
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct Message {
    role: String,
    content: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:8092")
        .await
        .context("binding 8092")?;
    eprintln!("stub model listening on 8092");
    // Backstop: harness must not outlive its usefulness.
    let serve = async {
        loop {
            let (stream, _) = listener.accept().await?;
            tokio::spawn(async move {
                if let Err(e) = handle(stream).await {
                    eprintln!("stub: request failed: {e}");
                }
            });
        }
    };
    tokio::select! {
        result = serve => result,
        _ = tokio::time::sleep(std::time::Duration::from_secs(110)) => {
            eprintln!("stub model: backstop reached, exiting");
            Ok(())
        }
    }
}

async fn handle(mut stream: TcpStream) -> Result<()> {
    let body = read_request(&mut stream).await?;
    let reply = match serde_json::from_slice::<Request>(&body) {
        Ok(req) => match req.messages.iter().rev().find(|m| m.role == "user") {
            Some(last) => format!("You said: {}. Quite so.", last.content),
            None => "You said nothing at all.".to_string(),
        },
        Err(e) => {
            let error = format!("{{\"error\":\"{e}\"}}");
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{error}",
                        error.len()
                    )
                    .as_bytes(),
                )
                .await?;
            return Ok(());
        }
    };

    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        )
        .await?;
    stream
        .write_all(
            b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\"}}\n\n",
        )
        .await?;
    for word in reply.split_inclusive(' ') {
        let data = serde_json::json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": word }
        });
        stream
            .write_all(format!("event: content_block_delta\ndata: {data}\n\n").as_bytes())
            .await?;
        stream.flush().await?;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    stream
        .write_all(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
        .await?;
    stream.flush().await?;
    Ok(())
}

/// Read headers + Content-Length body. Just enough HTTP for the harness.
async fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            bail!("connection closed before headers complete");
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_headers_end(&buf) {
            break pos;
        }
    };
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
    let content_length: usize = headers
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .map(|v| v.trim().parse())
        .transpose()?
        .unwrap_or(0);
    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            bail!("connection closed before body complete");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf[body_start..body_start + content_length].to_vec())
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}
