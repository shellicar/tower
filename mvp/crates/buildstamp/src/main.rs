//! Prints the stamp for one binary, given the dep-info cargo wrote for it:
//!
//!     buildstamp target/debug/bridge.d
//!
//! Run between two builds: the first tells cargo to write the dep-info, the
//! second receives what this printed.

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dep_info) = args.next() else {
        eprintln!("usage: buildstamp <path-to-dep-info>   (e.g. target/debug/bridge.d)");
        std::process::exit(2);
    };
    println!("{}", buildstamp::stamp(std::path::Path::new(&dep_info)));
}
