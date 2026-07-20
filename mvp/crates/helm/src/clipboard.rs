//! The system clipboard, macOS-first — a straight port of claude-sdk-cli's
//! clipboard.ts. Everything reaches the clipboard through external commands
//! (`pbpaste`, `osascript`, `pngpaste`), so there is no crate dependency and
//! a missing tool degrades to "nothing on the clipboard", never an error.

use tokio::process::Command;

async fn exec_text(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

async fn exec_bytes(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new(program).args(args).output().await.ok()?;
    (out.status.success() && !out.stdout.is_empty()).then_some(out.stdout)
}

/// Plain text off the clipboard, or None if empty/unavailable.
pub async fn read_text() -> Option<String> {
    exec_text("pbpaste", &[]).await
}

/// True if the string reads as a filesystem path: absolute, home-relative,
/// explicitly relative, or bare-relative (contains '/' and no whitespace).
/// Rejects multi-line strings and anything over 1 KB.
pub fn looks_like_path(s: &str) -> bool {
    if s.is_empty() || s.len() > 1024 || s.contains('\n') || s.contains('\r') {
        return false;
    }
    if s.starts_with('/') || s.starts_with("~/") || s == "~" || s.starts_with("./") || s.starts_with("../") {
        return true;
    }
    s.contains('/') && !s.chars().any(char::is_whitespace)
}

/// Reject HFS artifacts: AppleScript coercing plain text to a file reference
/// turns '/' into the HFS separator ':' — a genuine POSIX path never has one.
pub fn sanitise_furl(path: Option<String>) -> Option<String> {
    path.filter(|p| !p.contains(':'))
}

/// JXA snippet reading the first file URI from VS Code's proprietary
/// "code/file-list" pasteboard type (Explorer right-click → Copy), which
/// neither pbpaste nor the furl coercion can see.
const VSCODE_FILE_LIST_JXA: &str = "ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; var d = pb.dataForType($('code/file-list')); if (!d || !d.length) throw 'no code/file-list data'; $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js";

async fn read_vscode_file_list() -> Option<String> {
    let raw = exec_text("osascript", &["-l", "JavaScript", "-e", VSCODE_FILE_LIST_JXA]).await?;
    let first = raw.lines().next()?.trim();
    first.strip_prefix("file://").map(|p| {
        // Percent-decoding matters only for spaces in practice; a fuller
        // decode arrives with the first path that needs it.
        p.replace("%20", " ")
    })
}

async fn read_finder_furl() -> Option<String> {
    sanitise_furl(
        exec_text(
            "osascript",
            &["-e", "POSIX path of (the clipboard as \u{ab}class furl\u{bb})"],
        )
        .await,
    )
}

/// A file path off the clipboard, three-stage (the reference's order):
/// pbpaste when it looks like a path (terminal copy, VS Code "Copy Path"),
/// VS Code's file-list type (Explorer Copy), Finder's furl (⌘C on a file).
pub async fn read_path() -> Option<String> {
    if let Some(text) = read_text().await {
        let trimmed = text.trim().to_string();
        if looks_like_path(&trimmed) {
            return Some(trimmed);
        }
    }
    if let Some(path) = read_vscode_file_list().await {
        return Some(path);
    }
    read_finder_furl().await
}

/// Image media type from magic bytes; None when unrecognised.
pub fn detect_media_type(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 8 && data[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("image/png");
    }
    if data.len() >= 3 && data[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    if data.len() >= 6 && (&data[..6] == b"GIF87a" || &data[..6] == b"GIF89a") {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// An image off the clipboard via `pngpaste -` (brew install pngpaste), with
/// its media type from magic bytes. None when the clipboard has no image or
/// the tool is absent.
pub async fn read_image() -> Option<(Vec<u8>, &'static str)> {
    let bytes = exec_bytes("pngpaste", &["-"]).await?;
    let media_type = detect_media_type(&bytes)?;
    Some((bytes, media_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_heuristics_match_the_reference() {
        assert!(looks_like_path("/absolute/path"));
        assert!(looks_like_path("~/home/relative"));
        assert!(looks_like_path("~"));
        assert!(looks_like_path("./explicit"));
        assert!(looks_like_path("../parent"));
        assert!(looks_like_path("apps/foo/bar.ts"));
        assert!(!looks_like_path("bare-filename.ts"));
        assert!(!looks_like_path("two words/path"));
        assert!(!looks_like_path("multi\nline"));
        assert!(!looks_like_path(""));
    }

    #[test]
    fn furl_hfs_artifacts_are_rejected() {
        assert_eq!(sanitise_furl(Some("/apps:foo:bar.ts".into())), None);
        assert_eq!(
            sanitise_furl(Some("/real/path.png".into())),
            Some("/real/path.png".into())
        );
        assert_eq!(sanitise_furl(None), None);
    }

    #[test]
    fn magic_bytes_identify_the_four_formats() {
        assert_eq!(
            detect_media_type(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]),
            Some("image/png")
        );
        assert_eq!(detect_media_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(detect_media_type(b"GIF89a-rest"), Some("image/gif"));
        assert_eq!(detect_media_type(b"RIFF....WEBPVP8 "), Some("image/webp"));
        assert_eq!(detect_media_type(b"plain text"), None);
        assert_eq!(detect_media_type(&[]), None);
    }
}
