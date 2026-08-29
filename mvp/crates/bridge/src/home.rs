//! The user's home directory, across platforms. Every call site that needs
//! one goes through this, so there is one fallback instead of a different
//! guess per call site.
//!
//! It lives in `bridge-auth` because that crate has to find the credential
//! file before anything in bridge is running, and `bridge-login` needs the
//! same answer without linking bridge.
pub use bridge_auth::home_dir;
