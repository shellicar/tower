//! Scripted reply generation: deterministic text from the last user message.

/// The canned reply, quoting the last user message back per the spec.
pub fn scripted_reply(last_user_message: &str) -> String {
    format!("You said: \"{last_user_message}\" — and that is the whole of my wisdom.")
}

/// Split a reply into word-sized delta chunks whose concatenation reproduces the
/// reply exactly (each chunk keeps its trailing space).
pub fn word_chunks(reply: &str) -> Vec<String> {
    reply.split_inclusive(' ').map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_quotes_the_input() {
        let reply = scripted_reply("What's 2+2?");
        assert!(reply.contains("What's 2+2?"));
    }

    #[test]
    fn chunks_reassemble_to_the_reply() {
        let reply = scripted_reply("hello there");
        let chunks = word_chunks(&reply);
        assert!(chunks.len() > 1, "streaming needs multiple deltas");
        assert_eq!(chunks.concat(), reply);
    }

    #[test]
    fn empty_reply_yields_no_chunks() {
        assert!(word_chunks("").is_empty());
    }
}
