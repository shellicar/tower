use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
        .canonicalize()
        .expect("fixture directory")
}

fn fixtures(names: &[&str]) -> BTreeSet<PathBuf> {
    names.iter().map(|name| fixture(name)).collect()
}

mod footprint {
    use super::{fixture, fixtures};

    #[test]
    fn resolves_a_crate_with_no_path_dependencies_to_itself() {
        let expected = fixtures(&["browser"]);

        let actual = buildstamp::footprint(&fixture("browser"));

        assert_eq!(actual, expected);
    }

    #[test]
    fn resolves_path_dependencies_transitively() {
        let expected = fixtures(&["root", "left", "right", "shared", "browser"]);

        let actual = buildstamp::footprint(&fixture("root"));

        assert_eq!(actual, expected);
    }

    #[test]
    fn excludes_dev_dependencies() {
        let expected = false;

        let actual = buildstamp::footprint(&fixture("root")).contains(&fixture("testkit"));

        assert_eq!(actual, expected);
    }

    #[test]
    fn excludes_build_dependencies() {
        let expected = false;

        let actual = buildstamp::footprint(&fixture("root")).contains(&fixture("buildstamp"));

        assert_eq!(actual, expected);
    }

    #[test]
    fn terminates_on_a_dependency_cycle() {
        let expected = fixtures(&["right", "shared"]);

        let actual = buildstamp::footprint(&fixture("right"));

        assert_eq!(actual, expected);
    }
}
