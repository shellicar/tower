//! The composable engine's one stream type: what a SOURCE produces, a STAGE
//! transforms, and a terminal formats into the tool_result text. Explicit
//! variants, not a trait object — the wire crate's own "option B" precedent
//! (legible for LLM-authored Rust, every match compiler-checked) applies
//! here too. New tools add new grains by adding a variant, never by
//! generalising the shape away.

/// A file path — the grain `Find` (the SOURCE) produces, and a path-grain
/// stage (`Match` against paths, `Head`/`Tail`/`Range` by file count) works
/// over.
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
}

/// One line of a file's content — the grain `Read` produces, and a
/// content-grain stage (`Match` against content, `Head`/`Tail`/`Range` by
/// line count) works over.
#[derive(Debug, Clone)]
pub struct LineEntry {
    pub path: String,
    pub line: usize,
    pub content: String,
}

/// The one value that flows between engine steps, typed at every boundary.
/// `Lines` and the two methods below are unused until the next commit
/// (`Read`, the first stage to construct and consume them) — the shape
/// lands with `Find` because nothing later can build without it existing.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Stream {
    Files(Vec<FileEntry>),
    Lines(Vec<LineEntry>),
}

#[allow(dead_code)]
impl Stream {
    pub fn len(&self) -> usize {
        match self {
            Stream::Files(v) => v.len(),
            Stream::Lines(v) => v.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Render a stream as the tool_result text a model reads — the engine's one
/// terminal formatter, shared by every tool that can end a run: a standalone
/// `Find`/`Read`/etc. today, and `Pipe`'s own last step later.
pub fn format_stream(stream: &Stream) -> String {
    match stream {
        Stream::Files(files) => {
            if files.is_empty() {
                return "(no files)".to_string();
            }
            files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        }
        Stream::Lines(lines) => {
            if lines.is_empty() {
                return "(no lines)".to_string();
            }
            lines
                .iter()
                .map(|l| format!("{}:{}:{}", l.path, l.line, l.content))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_files_stream_formats_to_a_stated_placeholder() {
        assert_eq!(format_stream(&Stream::Files(vec![])), "(no files)");
    }

    #[test]
    fn files_format_one_path_per_line() {
        let stream = Stream::Files(vec![
            FileEntry {
                path: "a.rs".into(),
            },
            FileEntry {
                path: "b.rs".into(),
            },
        ]);
        assert_eq!(format_stream(&stream), "a.rs\nb.rs");
    }

    #[test]
    fn lines_format_as_path_colon_number_colon_content() {
        let stream = Stream::Lines(vec![LineEntry {
            path: "a.rs".into(),
            line: 3,
            content: "fn main() {}".into(),
        }]);
        assert_eq!(format_stream(&stream), "a.rs:3:fn main() {}");
    }
}
