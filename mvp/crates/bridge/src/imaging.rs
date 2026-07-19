//! Image conditioning: downscale to a bounded long edge before an image
//! attaches to a model request. Native decode/resize/encode via the `image`
//! crate — no subprocess, no platform tool. `sips` (macOS's own image tool)
//! is how claude-sdk-cli does this in Node, a workaround for not having a
//! real image library available without a second native binary alongside
//! better-sqlite3; that constraint doesn't exist in Rust, so this is a
//! normal compiled dependency instead, decode/resize/encode entirely
//! in-memory.

use image::{DynamicImage, ImageFormat, imageops::FilterType};

/// Longest edge (px) an attached image may keep. Above this, downscale; at
/// or below, leave as-is — a fixed safety number under the API's own
/// per-image dimension handling (it resizes internally too, so nothing is
/// gained by sending more), and it keeps a large image from being what
/// pushes a conversation toward the API's per-request image-count ceiling
/// faster than it needs to.
const MAX_LONG_EDGE: u32 = 2000;

/// Downscale to a `MAX_LONG_EDGE` long edge (aspect kept), re-encoded as
/// PNG, only when the source exceeds it — decode is never attempted
/// otherwise... no, decode always happens (dimensions require it), but
/// re-encode only on an actual resize. Any problem — undecodable bytes, an
/// encode failure — degrades to the original bytes and media type
/// unchanged: a conditioner must never block an attachment. Runs on the
/// blocking pool: decode/resize/encode is real CPU work, not I/O.
pub async fn condition_image(bytes: Vec<u8>, media_type: &str) -> (Vec<u8>, String) {
    let media_type = media_type.to_string();
    tokio::task::spawn_blocking(move || {
        let Ok(img) = image::load_from_memory(&bytes) else {
            return (bytes, media_type);
        };
        let (width, height) = (img.width(), img.height());
        if width.max(height) <= MAX_LONG_EDGE {
            return (bytes, media_type);
        }
        match encode_png(&resize(img)) {
            Ok(resized) => (resized, "image/png".to_string()),
            Err(_) => (bytes, media_type),
        }
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), "application/octet-stream".to_string()))
}

/// `DynamicImage::resize` fits within the given box, aspect preserved —
/// the same "longest side capped" semantics as sips's `-Z`, not a stretch
/// to exact dimensions.
fn resize(img: DynamicImage) -> DynamicImage {
    img.resize(MAX_LONG_EDGE, MAX_LONG_EDGE, FilterType::Lanczos3)
}

fn encode_png(img: &DynamicImage) -> image::ImageResult<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::condition_image;

    /// A genuine, valid 1x1 PNG — well under `MAX_LONG_EDGE`, so decode must
    /// succeed, read real dimensions, and hand the exact original bytes back
    /// untouched (no re-encode on the no-op path).
    #[rustfmt::skip]
    const ONE_BY_ONE_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
        0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5,
        0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    #[tokio::test]
    async fn a_small_image_passes_through_byte_identical() {
        let (bytes, media_type) = condition_image(ONE_BY_ONE_PNG.to_vec(), "image/png").await;
        assert_eq!(bytes, ONE_BY_ONE_PNG);
        assert_eq!(media_type, "image/png");
    }

    #[tokio::test]
    async fn a_large_image_is_downscaled_and_reencoded_as_png() {
        let big = image::DynamicImage::new_rgb8(3000, 1500);
        let mut original = std::io::Cursor::new(Vec::new());
        big.write_to(&mut original, image::ImageFormat::Jpeg)
            .unwrap();
        let original = original.into_inner();

        let (bytes, media_type) = condition_image(original.clone(), "image/jpeg").await;
        assert_eq!(media_type, "image/png");
        assert_ne!(bytes, original);

        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 2000);
        assert_eq!(decoded.height(), 1000);
    }

    #[tokio::test]
    async fn undecodable_bytes_degrade_to_the_original_unchanged() {
        let junk = vec![1, 2, 3, 4, 5];
        let (bytes, media_type) = condition_image(junk.clone(), "image/png").await;
        assert_eq!(bytes, junk);
        assert_eq!(media_type, "image/png");
    }
}
