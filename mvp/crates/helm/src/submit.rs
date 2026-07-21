//! Submit composition — a port of claude-sdk-cli's buildSubmitText.ts, and
//! the format is the contract: text and file attachments serialise into the
//! message text as one <attachments> block (the system prompt tells the
//! agent this structure); images alone ride as native blocks. The interface
//! around it may differ from the reference; this format must not.

/// One pinned attachment. Text carries the pasted content; File carries
/// metadata only (the agent reads the path with its own tools — bytes are
/// never uploaded for a file); Image carries the object-store reference
/// block minted at paste time.
#[derive(Debug, Clone)]
pub enum Chip {
    Text {
        text: String,
    },
    File {
        path: String,
        kind: FileKind,
    },
    Image {
        label: String,
        block: serde_json::Value,
    },
}

#[derive(Debug, Clone)]
pub enum FileKind {
    Missing,
    Dir,
    File { size: u64 },
}

impl Chip {
    /// The chip row's label — display only, not part of the format contract.
    pub fn label(&self) -> String {
        match self {
            Chip::Text { text } => format!("text ({})", fmt_size(text.len() as u64)),
            Chip::File { path, kind } => {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                match kind {
                    FileKind::Missing => format!("{name} (missing)"),
                    FileKind::Dir => format!("{name} (dir)"),
                    FileKind::File { size } => format!("{name} ({})", fmt_size(*size)),
                }
            }
            Chip::Image { label, .. } => label.clone(),
        }
    }
}

/// `${(n/1024).toFixed(1)}KB` / `${n}B` — the reference's exact rendering.
fn fmt_size(n: u64) -> String {
    if n >= 1024 {
        format!("{:.1}KB", n as f64 / 1024.0)
    } else {
        format!("{n}B")
    }
}

/// The submit: text+file chips fold into the message text (the format
/// contract, verbatim from buildSubmitText.ts); image chips return as the
/// wire attachments. Plain text passes through unchanged when nothing
/// serialises.
pub fn build_submit(text: &str, chips: &[Chip]) -> (String, Vec<serde_json::Value>) {
    let mut items: Vec<String> = Vec::new();
    let mut images: Vec<serde_json::Value> = Vec::new();
    for chip in chips {
        match chip {
            Chip::Text { text } => {
                items.push(format!("<attachment>\n{text}\n</attachment>"));
            }
            Chip::File { path, kind } => {
                let mut lines = vec![format!("path: {path}")];
                match kind {
                    FileKind::Missing => lines.push("// not found".into()),
                    FileKind::Dir => lines.push("type: dir".into()),
                    FileKind::File { size } => {
                        lines.push("type: file".into());
                        lines.push(format!("size: {}", fmt_size(*size)));
                    }
                }
                items.push(format!("<attachment>\n{}\n</attachment>", lines.join("\n")));
            }
            Chip::Image { block, .. } => images.push(block.clone()),
        }
    }
    let submit = if items.is_empty() {
        text.to_string()
    } else {
        format!(
            "{text}\n\n<attachments>\n{}\n</attachments>",
            items.join("\n")
        )
    };
    (submit, images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passes_through_unchanged() {
        let (submit, images) = build_submit("hello", &[]);
        assert_eq!(submit, "hello");
        assert!(images.is_empty());
    }

    #[test]
    fn a_text_chip_serialises_as_the_reference_block() {
        let chips = [Chip::Text {
            text: "copied content".into(),
        }];
        let (submit, _) = build_submit("look at this", &chips);
        assert_eq!(
            submit,
            "look at this\n\n<attachments>\n<attachment>\ncopied content\n</attachment>\n</attachments>"
        );
    }

    #[test]
    fn file_chips_carry_metadata_in_the_reference_shapes() {
        let chips = [
            Chip::File {
                path: "/a/b.rs".into(),
                kind: FileKind::File { size: 2048 },
            },
            Chip::File {
                path: "/a/dir".into(),
                kind: FileKind::Dir,
            },
            Chip::File {
                path: "/a/gone".into(),
                kind: FileKind::Missing,
            },
        ];
        let (submit, _) = build_submit("m", &chips);
        assert_eq!(
            submit,
            "m\n\n<attachments>\n<attachment>\npath: /a/b.rs\ntype: file\nsize: 2.0KB\n</attachment>\n<attachment>\npath: /a/dir\ntype: dir\n</attachment>\n<attachment>\npath: /a/gone\n// not found\n</attachment>\n</attachments>"
        );
    }

    #[test]
    fn images_ride_as_blocks_never_text() {
        let block =
            serde_json::json!({ "type": "image", "source": { "type": "object", "id": "x" } });
        let chips = [Chip::Image {
            label: "clipboard.png".into(),
            block: block.clone(),
        }];
        let (submit, images) = build_submit("see image", &chips);
        assert_eq!(submit, "see image"); // no <attachments> block for images alone
        assert_eq!(images, vec![block]);
    }

    #[test]
    fn sizes_render_exactly_like_the_reference() {
        assert_eq!(fmt_size(512), "512B");
        assert_eq!(fmt_size(1024), "1.0KB");
        assert_eq!(fmt_size(1536), "1.5KB");
    }
}
