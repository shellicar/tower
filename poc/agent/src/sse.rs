//! Incremental SSE parsing: raw bytes in, complete events out. Buffers only the
//! current unterminated event, never the whole response — chunks can split lines,
//! events, or multi-byte characters at any point.

/// One complete SSE event: the `event:` name (if present) and the joined `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Feed chunks with [`SseParser::push`]; each call returns the events the chunk completed.
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consume one chunk of bytes, returning every event it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((block_end, sep_len)) = find_block_end(&self.buf) {
            let block: Vec<u8> = self.buf.drain(..block_end + sep_len).collect();
            if let Some(event) = parse_block(&block[..block_end]) {
                events.push(event);
            }
        }
        events
    }
}

/// Find the end of the first complete event block: the position where its final
/// line's `\n` sits, plus the length of the blank-line separator that follows.
fn find_block_end(buf: &[u8]) -> Option<(usize, usize)> {
    for (i, byte) in buf.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        match (buf.get(i + 1), buf.get(i + 2)) {
            (Some(b'\n'), _) => return Some((i + 1, 1)),
            (Some(b'\r'), Some(b'\n')) => return Some((i + 1, 2)),
            _ => {}
        }
    }
    None
}

/// Parse one event block. Returns `None` for blocks with no `data:` line
/// (comments, stray blank lines) or invalid UTF-8.
fn parse_block(block: &[u8]) -> Option<SseEvent> {
    let text = std::str::from_utf8(block).ok()?;
    let mut event = None;
    let mut data_lines = Vec::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("event:") {
            event = Some(name.trim_start().to_string());
        } else if let Some(payload) = line.strip_prefix("data:") {
            data_lines.push(payload.strip_prefix(' ').unwrap_or(payload));
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data_lines.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(text: &str) -> String {
        format!(
            "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n"
        )
    }

    #[test]
    fn one_chunk_many_events() {
        let mut parser = SseParser::new();
        let input = format!("{}{}", delta("a"), delta("b"));
        let events = parser.push(input.as_bytes());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event.as_deref(), Some("content_block_delta"));
        assert!(events[0].data.contains("\"a\""));
        assert!(events[1].data.contains("\"b\""));
    }

    #[test]
    fn event_split_across_chunks() {
        let mut parser = SseParser::new();
        let input = delta("hello");
        let (first, second) = input.as_bytes().split_at(20);
        assert!(parser.push(first).is_empty());
        let events = parser.push(second);
        assert_eq!(events.len(), 1);
        assert!(events[0].data.contains("hello"));
    }

    #[test]
    fn multibyte_char_split_across_chunks() {
        let mut parser = SseParser::new();
        let input = "event: x\ndata: héllo\n\n".as_bytes();
        // Split inside the two-byte 'é'.
        let split = input.iter().position(|b| *b >= 0x80).map(|i| i + 1);
        let (first, second) = input.split_at(split.unwrap_or(1));
        assert!(parser.push(first).is_empty());
        let events = parser.push(second);
        assert_eq!(events[0].data, "héllo");
    }

    #[test]
    fn crlf_line_endings() {
        let mut parser = SseParser::new();
        let events = parser.push(b"event: message_stop\r\ndata: {}\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("message_stop"));
        assert_eq!(events[0].data, "{}");
    }

    #[test]
    fn data_only_event_and_comment_blocks() {
        let mut parser = SseParser::new();
        let events = parser.push(b": comment\n\ndata: bare\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, None);
        assert_eq!(events[0].data, "bare");
    }
}
