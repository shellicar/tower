// Stamp the binary with its git commit and build time so a running bridge can
// say which build it is — the cheapest guard against running a stale binary.
use std::process::Command;

fn stamp(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    let hash = stamp("git", &["rev-parse", "--short", "HEAD"]);
    let built = stamp("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]);
    println!("cargo:rustc-env=BRIDGE_GIT_HASH={hash}");
    println!("cargo:rustc-env=BRIDGE_BUILD_TIME={built}");
}
