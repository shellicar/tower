//! The user's home directory, across platforms. `$HOME` is the Unix
//! convention every shell exports (including WSL2, which is Linux for this
//! purpose); native Windows doesn't set it by default — its own convention
//! is `%USERPROFILE%`. Every call site that needs a home directory goes
//! through this, one fallback instead of drifting per call site.
pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}
