//! The proof, driven end to end: build a scratch repository, compute the
//! stamp from what cargo recorded, build again with it, and ask the binary
//! what it says. Cargo's rerun behaviour is what these pin, and it cannot be
//! reasoned about from the outside.

use std::path::PathBuf;
use std::process::Command;

const WORKSPACE: &str = r#"[workspace]
resolver = "2"
members = ["app", "dep"]
"#;

const APP_MANIFEST: &str = r#"[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
dep = { path = "../dep" }

[build-dependencies]
buildstamp = { path = 'BUILDSTAMP_PATH' }
"#;

const OUTSIDE_SOURCE: &str = r#"pub fn note() -> &'static str {
    "outside"
}
"#;

const APP_MAIN: &str = r#"mod orphan;

fn main() {
    println!("{}", env!("APP_GIT_HASH"));
    let _ = dep::hello();
}
"#;

struct Scratch {
    dir: PathBuf,
    outside: Option<PathBuf>,
}

impl Scratch {
    /// A committed, clean repository holding a two-crate workspace whose app
    /// stamps itself through this crate.
    fn new(name: &str) -> Self {
        Self::build_scratch(name, false)
    }

    /// The same, plus a path dependency that lives outside the repository
    /// altogether, compiled into the app all the same.
    fn with_outside_dependency(name: &str) -> Self {
        Self::build_scratch(name, true)
    }

    fn build_scratch(name: &str, outside: bool) -> Self {
        let dir = std::env::temp_dir().join(format!("buildstamp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut scratch = Scratch { dir, outside: None };
        if outside {
            scratch.write_outside_crate(name);
        }

        scratch.write("Cargo.toml", WORKSPACE);
        scratch.write(".gitignore", "target\n");
        let mut manifest = APP_MANIFEST.replace("BUILDSTAMP_PATH", env!("CARGO_MANIFEST_DIR"));
        if let Some(outside) = &scratch.outside {
            manifest.push_str(&format!(
                "\n[dependencies.outside]\npath = '{}'\n",
                outside.display()
            ));
        }
        scratch.write("app/Cargo.toml", &manifest);
        scratch.write(
            "app/build.rs",
            "fn main() {\n    buildstamp::emit(\"APP\");\n}\n",
        );
        let main = match &scratch.outside {
            Some(_) => format!("{APP_MAIN}const _OUTSIDE: fn() -> &'static str = outside::note;\n"),
            None => APP_MAIN.to_string(),
        };
        scratch.write("app/src/main.rs", &main);
        // Compiled, so an edit to it has to show. `mod orphan;` in main.rs
        // is what makes it so.
        scratch.write(
            "app/src/orphan.rs",
            "pub const NOTE: &str = \"compiled\";\n",
        );
        // Never referenced by any module, so it cannot change the binary.
        scratch.write(
            "app/src/unreferenced.rs",
            "pub const NOTE: &str = \"not compiled\";\n",
        );
        scratch.write(
            "dep/Cargo.toml",
            "[package]\nname = \"dep\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        );
        scratch.write(
            "dep/src/lib.rs",
            "pub fn hello() -> &'static str {\n    \"hello\"\n}\n",
        );

        scratch.git(&["init", "-q"]);
        // The lockfile is part of the checked set, so the baseline has to
        // hold it committed the way a real repository does.
        scratch.cargo(&["generate-lockfile"], None);
        scratch.commit(
            &[
                "Cargo.lock",
                "Cargo.toml",
                ".gitignore",
                "app/Cargo.toml",
                "app/build.rs",
                "app/src/main.rs",
                "app/src/orphan.rs",
                "app/src/unreferenced.rs",
                "dep/Cargo.toml",
                "dep/src/lib.rs",
            ],
            "scratch baseline",
        );
        scratch
    }

    /// A crate the repository does not contain, wired in as a path
    /// dependency before the baseline is committed so the lockfile holds it.
    fn write_outside_crate(&mut self, name: &str) {
        let outside =
            std::env::temp_dir().join(format!("buildstamp-{name}-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("src")).expect("create the outside crate");
        std::fs::write(
            outside.join("Cargo.toml"),
            "[package]\nname = \"outside\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("write the outside manifest");
        std::fs::write(outside.join("src").join("lib.rs"), OUTSIDE_SOURCE)
            .expect("write the outside source");
        self.outside = Some(outside);
    }

    fn outside_source(&self) -> PathBuf {
        self.outside
            .as_ref()
            .expect("an outside crate")
            .join("src")
            .join("lib.rs")
    }

    fn set_config(&self, key: &str, value: &str) {
        self.git(&["config", key, value]);
    }

    /// What the check makes of the tree as it stands, against the record the
    /// build it just ran left behind.
    fn stamp_now(&self) -> String {
        self.build(None);
        buildstamp::stamp(&self.dep_info())
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.dir.join(relative);
        std::fs::create_dir_all(path.parent().expect("a parent directory")).expect("create dirs");
        std::fs::write(path, contents).expect("write file");
    }

    fn append(&self, relative: &str, contents: &str) {
        let path = self.dir.join(relative);
        let existing = std::fs::read_to_string(&path).expect("read file");
        std::fs::write(path, format!("{existing}{contents}")).expect("append file");
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(&self.dir)
            .args([
                "-c",
                "user.email=scratch@example.invalid",
                "-c",
                "user.name=scratch",
                // A scratch repository has no signing key, and the machine's
                // own config may well demand one.
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(&self, paths: &[&str], message: &str) {
        let mut add = vec!["add", "--"];
        add.extend_from_slice(paths);
        self.git(&add);
        self.git(&["commit", "-q", "-m", message]);
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "--short", "HEAD"])
    }

    fn dep_info(&self) -> PathBuf {
        self.dir.join("target").join("debug").join("app.d")
    }

    fn build(&self, handed_in: Option<&str>) {
        self.cargo(&["build"], handed_in);
    }

    fn cargo(&self, args: &[&str], handed_in: Option<&str>) {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let mut run = Command::new(cargo);
        run.current_dir(&self.dir)
            .args(args)
            .env("CARGO_TARGET_DIR", self.dir.join("target"))
            .env_remove("CARGO_MANIFEST_DIR")
            .env_remove("CARGO_PKG_NAME")
            .env_remove("CARGO_PKG_VERSION");
        match handed_in {
            Some(stamp) => run.env("BUILDSTAMP_APP", stamp),
            None => run.env_remove("BUILDSTAMP_APP"),
        };
        let out = run.output().expect("run cargo");
        assert!(
            out.status.success(),
            "cargo {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// What the built binary says its stamp is, after the two builds the
    /// approach is made of.
    fn binary_says(&self) -> String {
        self.build(None);
        let stamp = buildstamp::stamp(&self.dep_info());
        self.build(Some(&stamp));
        self.run_binary()
    }

    fn run_binary(&self) -> String {
        let exe = if cfg!(windows) { "app.exe" } else { "app" };
        let out = Command::new(self.dir.join("target").join("debug").join(exe))
            .output()
            .expect("run the built binary");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Some(outside) = &self.outside {
            let _ = std::fs::remove_dir_all(outside);
        }
    }
}

fn dirty(hash: &str) -> String {
    format!("{hash}-dirty")
}

mod stamp {
    use super::{Scratch, dirty};

    #[test]
    fn names_the_commit_when_nothing_has_changed() {
        let scratch = Scratch::new("clean");
        let expected = scratch.head();

        let actual = scratch.binary_says();

        assert_eq!(actual, expected);
    }

    #[test]
    fn marks_dirty_when_a_compiled_file_is_edited() {
        let scratch = Scratch::new("edited");
        let expected = dirty(&scratch.head());

        scratch.append("app/src/orphan.rs", "// edited\n");
        let actual = scratch.binary_says();

        assert_eq!(actual, expected);
    }

    #[test]
    fn marks_dirty_when_an_untracked_file_is_part_of_the_build() {
        let scratch = Scratch::new("untracked");
        // The module declaration is committed and the file it names is not,
        // so the only thing git has to notice is the untracked file itself.
        scratch.append("app/src/main.rs", "mod extra;\n");
        scratch.write("app/src/extra.rs", "pub const NOTE: &str = \"new\";\n");
        scratch.commit(&["app/src/main.rs"], "declare the new module");
        let expected = dirty(&scratch.head());

        let actual = scratch.binary_says();

        assert_eq!(actual, expected);
    }

    #[test]
    fn stays_clean_when_a_file_that_is_not_compiled_is_edited() {
        let scratch = Scratch::new("unreferenced");
        let expected = scratch.head();

        scratch.append("app/src/unreferenced.rs", "// edited\n");
        let actual = scratch.binary_says();

        assert_eq!(actual, expected);
    }

    #[test]
    fn follows_the_commit_when_the_change_is_committed() {
        let scratch = Scratch::new("committed");
        scratch.binary_says();

        scratch.append("app/src/orphan.rs", "// edited\n");
        scratch.commit(&["app/src/orphan.rs"], "edit a compiled file");
        let expected = scratch.head();

        let actual = scratch.binary_says();

        assert_eq!(actual, expected);
    }

    /// Asserted on the computed stamp rather than the binary: cargo rewrites
    /// a hand-edited lockfile back to canonical form on the next build, and
    /// there is no offline `cargo update` to stand in for it.
    #[test]
    fn counts_the_lockfile_that_cargo_never_records_as_compiled() {
        let scratch = Scratch::new("lockfile");
        let expected = dirty(&scratch.head());
        scratch.build(None);

        scratch.append(
            "Cargo.lock",
            "\n# a hand edit standing in for cargo update\n",
        );
        let actual = buildstamp::stamp(&scratch.dep_info());

        assert_eq!(actual, expected);
    }

    #[test]
    fn stamps_a_bare_build_from_the_previous_build() {
        let scratch = Scratch::new("bare");
        let expected = scratch.head();
        scratch.binary_says();

        // No stamp handed in: the build script falls back to the dep-info the
        // build before it left behind.
        scratch.build(None);
        let actual = scratch.run_binary();

        assert_eq!(actual, expected);
    }
}

/// The edges of what the check can see, pinned so they stay known rather than
/// guessed. Several of these answer clean where dirty would be better; that
/// gap is recorded in trigger-matrix.md, not closed here.
mod boundary {
    use super::{Scratch, dirty};

    #[test]
    fn misses_a_crate_manifest_edit_that_leaves_the_lockfile_alone() {
        let scratch = Scratch::new("crate-manifest");
        let expected = scratch.head();

        scratch.append("app/Cargo.toml", "\n[features]\nprobe = []\n");
        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_a_workspace_manifest_edit() {
        let scratch = Scratch::new("workspace-manifest");
        let expected = dirty(&scratch.head());

        scratch.append(
            "Cargo.toml",
            "\n# an edit cargo never records as compiled\n",
        );
        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_an_edit_to_the_build_script() {
        let scratch = Scratch::new("build-script");
        let expected = dirty(&scratch.head());

        scratch.append("app/build.rs", "// edited\n");
        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn misses_a_compiled_file_a_gitignore_rule_matches() {
        let scratch = Scratch::new("ignored");
        scratch.append(".gitignore", "app/src/generated.rs\n");
        scratch.append("app/src/main.rs", "mod generated;\n");
        scratch.write(
            "app/src/generated.rs",
            "pub const NOTE: &str = \"ignored\";\n",
        );
        scratch.commit(
            &[".gitignore", "app/src/main.rs"],
            "compile an ignored file",
        );
        let expected = scratch.head();

        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_bare_build_misses_a_module_added_since_the_last_one() {
        let scratch = Scratch::new("bare-module");
        scratch.binary_says();

        scratch.append("app/src/main.rs", "mod extra;\n");
        scratch.write("app/src/extra.rs", "pub const NOTE: &str = \"new\";\n");
        scratch.commit(&["app/src/main.rs"], "declare the new module");
        let expected = scratch.head();

        scratch.build(None);
        let actual = scratch.run_binary();

        assert_eq!(actual, expected);
    }

    #[test]
    fn misses_a_compiled_source_that_lies_outside_the_repository() {
        let scratch = Scratch::with_outside_dependency("outside");
        let expected = scratch.head();

        std::fs::write(
            scratch.outside_source(),
            "pub fn note() -> &'static str {\n    \"edited\"\n}\n",
        )
        .expect("edit the outside crate");
        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_an_untracked_file_though_a_config_turns_untracked_reporting_off() {
        let scratch = Scratch::new("showuntracked");
        scratch.append("app/src/main.rs", "mod extra;\n");
        scratch.write("app/src/extra.rs", "pub const NOTE: &str = \"new\";\n");
        scratch.commit(&["app/src/main.rs"], "declare the new module");
        scratch.set_config("status.showUntrackedFiles", "no");
        let expected = dirty(&scratch.head());

        let actual = scratch.stamp_now();

        assert_eq!(actual, expected);
    }

    #[test]
    fn refuses_to_certify_when_the_record_cannot_be_read() {
        let scratch = Scratch::new("no-record");
        let expected = dirty(&scratch.head());

        let actual = buildstamp::stamp(&scratch.dir.join("target").join("debug").join("absent.d"));

        assert_eq!(actual, expected);
    }
}
