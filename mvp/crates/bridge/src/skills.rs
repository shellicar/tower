//! Skills: the catalogue is re-scanned per say. The first say of a
//! conversation commits the full catalogue reminder and records the delta
//! baseline; each later say commits a delta reminder naming the skills whose
//! SKILL.md content changed since the last scan (removals are silent). The body
//! is read fresh at invoke time. A skill is `{root}/{dir}/SKILL.md` with YAML
//! frontmatter carrying
//! `name` and `description`; the body below the frontmatter is what the
//! Skill tool returns, stripped of the frontmatter.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};

/// The frontmatter fields the catalogue reads; unknown fields are ignored
/// (yaml_serde tolerates them by default: the open-set rule, here too).
#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

pub struct SkillMeta {
    pub name: String,
    pub description: String,
    path: PathBuf,
    /// Hash of the whole SKILL.md (frontmatter + body), so a body-only edit —
    /// invisible to the catalogue line — still registers as a change.
    hash: u64,
}

pub struct Skills {
    list: Vec<SkillMeta>,
}

impl Skills {
    /// Scan `{root}/*/SKILL.md`. A file that fails to read or parse is
    /// skipped with a log line, never fatal; a broken skill must not stop
    /// the host. `name` defaults to the directory name when the frontmatter
    /// omits it.
    pub fn scan(root: PathBuf) -> Skills {
        let mut list = Vec::new();
        let Ok(entries) = std::fs::read_dir(&root) else {
            return Skills { list }; // no skills directory: an empty catalogue
        };
        for entry in entries.flatten() {
            let path = entry.path().join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let (front, _) = split_frontmatter(&text);
            let front: Frontmatter = match yaml_serde::from_str(front) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("bridge: skill {dir_name} has unparseable frontmatter: {e}; skipped");
                    continue;
                }
            };
            let name = front.name.unwrap_or(dir_name);
            let Some(description) = front.description else {
                eprintln!("bridge: skill {name} has no description; skipped");
                continue;
            };
            let hash = content_hash(&text);
            list.push(SkillMeta {
                name,
                description,
                path,
                hash,
            });
        }
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Skills { list }
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// The availability block, committed onto the conversation's first user
    /// message so the record shows what the model saw.
    pub fn reminder(&self) -> Option<String> {
        if self.list.is_empty() {
            return None;
        }
        let mut text = String::from(
            "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n",
        );
        for s in &self.list {
            text.push_str(&format!("- {}: {}\n", s.name, s.description));
        }
        text.push_str("</system-reminder>\n\n");
        Some(text)
    }

    /// The delta baseline: every skill's name mapped to its content hash. The
    /// first say records this and stays silent; later says diff against it.
    pub fn baseline(&self) -> HashMap<String, u64> {
        self.list.iter().map(|s| (s.name.clone(), s.hash)).collect()
    }

    /// Diff a fresh scan against a prior baseline. Returns a `<system-reminder>`
    /// naming the skills whose SKILL.md content changed or is new, or None when
    /// none did. Removals are deliberately silent: pointing the directory at an
    /// empty path announces nothing, and pointing it back re-advertises every
    /// skill as new. A body-only edit still surfaces — the hash covers the whole
    /// file, so a skill loaded earlier is re-announced as stale even when its
    /// catalogue line is unchanged.
    pub fn delta(&self, previous: &HashMap<String, u64>) -> Option<String> {
        let mut updated: Vec<String> = self
            .list
            .iter()
            .filter(|s| previous.get(&s.name) != Some(&s.hash))
            .map(|s| format!("- {}: {}", s.name, s.description))
            .collect();
        if updated.is_empty() {
            return None;
        }
        updated.sort();
        Some(format!(
            "<system-reminder>\nThe following skills have been updated:\n\n{}\n</system-reminder>\n\n",
            updated.join("\n")
        ))
    }

    /// The Skill tool, for the API's `tools` array.
    pub fn tool_schema(&self) -> Value {
        json!({
            "name": "Skill",
            "description": "Load a skill's instructions into the conversation. \
                Available skills are listed in a system-reminder block; invoke \
                only names from that list, never guessed ones. When a skill \
                matches the task, invoke it before responding.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "skill": {
                        "type": "string",
                        "description": "The name of a skill from the available-skills list."
                    }
                },
                "required": ["skill"],
                "additionalProperties": false
            }
        })
    }

    /// Invoke: read the skill fresh (the catalogue is static, the body is
    /// whatever is on disk now) and return it with the frontmatter stripped.
    /// Unknown names and unreadable files are `Err`; the tool_result carries
    /// the message with `is_error`.
    pub fn invoke(&self, name: &str) -> Result<String, String> {
        let Some(skill) = self.list.iter().find(|s| s.name == name) else {
            let names: Vec<&str> = self.list.iter().map(|s| s.name.as_str()).collect();
            return Err(format!(
                "unknown skill {name:?}; available: {}",
                names.join(", ")
            ));
        };
        let text = std::fs::read_to_string(&skill.path)
            .map_err(|e| format!("skill {name} unreadable: {e}"))?;
        let (_, body) = split_frontmatter(&text);
        Ok(body.trim_start().to_string())
    }
}

/// `---\n{front}\n---\n{body}` → (front, body); no frontmatter → ("", whole).
fn split_frontmatter(text: &str) -> (&str, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return ("", text);
    };
    match rest.split_once("\n---") {
        // The closing marker's own line ends at the next newline (or EOF).
        Some((front, tail)) => (front, tail.split_once('\n').map_or("", |(_, b)| b)),
        None => ("", text),
    }
}

/// A content hash of a whole SKILL.md, for change detection across scans.
/// Non-cryptographic (std DefaultHasher): the need is "did the bytes change",
/// not integrity, so no new dependency is pulled for a SHA.
fn content_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique throwaway dir under the OS temp dir: std only, no tempfile
    /// dependency for two tests. Best-effort cleanup by the caller.
    fn skills_dir(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bridge-skills-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (name, content) in files {
            let d = dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), content).unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_reminds_and_invokes_stripped() {
        let dir = skills_dir(
            "scan",
            &[
                (
                    "test-skill",
                    "---\nname: test-skill\ndescription: I am a teapot\n---\n\nhello world\n",
                ),
                ("no-description", "---\nname: broken\n---\nbody\n"),
                ("bare", "no frontmatter at all\n"),
            ],
        );
        let skills = Skills::scan(dir.clone());

        // no-description is skipped, bare has no description either.
        assert_eq!(skills.list.len(), 1);
        let reminder = skills.reminder().unwrap();
        assert!(reminder.starts_with("<system-reminder>"));
        assert!(reminder.contains("- test-skill: I am a teapot"));
        assert!(reminder.ends_with("</system-reminder>\n\n"));

        // Invoke returns the body only, frontmatter stripped.
        assert_eq!(skills.invoke("test-skill").unwrap(), "hello world\n");
        assert!(skills.invoke("nope").unwrap_err().contains("test-skill"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn block_scalar_descriptions_parse() {
        let dir = skills_dir(
            "block",
            &[(
                "ado-work-items",
                "---\nname: ado-work-items\ndescription: |\n  Query and update Azure DevOps work items.\n  Use when the user mentions ADO.\n---\nbody\n",
            )],
        );
        let skills = Skills::scan(dir.clone());
        let reminder = skills.reminder().unwrap();
        // Real YAML semantics: `|` keeps the line break, and the block ends
        // with a single trailing newline (clip chomping).
        assert!(reminder.contains(
            "- ado-work-items: Query and update Azure DevOps work items.\nUse when the user mentions ADO.\n"
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_catalogue_has_no_reminder() {
        let skills = Skills::scan(std::env::temp_dir().join("bridge-skills-test-missing"));
        assert!(skills.is_empty());
        assert!(skills.reminder().is_none());
    }

    #[test]
    fn delta_surfaces_changed_and_added_but_never_removed() {
        let dir = skills_dir(
            "delta",
            &[
                (
                    "alpha",
                    "---\nname: alpha\ndescription: first\n---\nbody one\n",
                ),
                (
                    "beta",
                    "---\nname: beta\ndescription: second\n---\nbody two\n",
                ),
            ],
        );
        let base = Skills::scan(dir.clone()).baseline();

        // Body-only edit to alpha (its catalogue line is unchanged), beta
        // removed, gamma added.
        std::fs::write(
            dir.join("alpha").join("SKILL.md"),
            "---\nname: alpha\ndescription: first\n---\nbody one CHANGED\n",
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(dir.join("beta"));
        std::fs::create_dir_all(dir.join("gamma")).unwrap();
        std::fs::write(
            dir.join("gamma").join("SKILL.md"),
            "---\nname: gamma\ndescription: third\n---\nbody three\n",
        )
        .unwrap();

        let delta = Skills::scan(dir.clone()).delta(&base).unwrap();
        assert!(delta.contains("The following skills have been updated:"));
        assert!(delta.contains("- alpha: first"));
        assert!(delta.contains("- gamma: third"));
        // Removals are silent: beta is gone, but the delta never says so.
        assert!(!delta.contains("- beta"));
        assert!(!delta.contains("no longer available"));

        // A baseline that already matches the current scan yields no delta.
        let current = Skills::scan(dir.clone()).baseline();
        assert!(Skills::scan(dir.clone()).delta(&current).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emptying_then_refilling_is_silent_then_readvertises() {
        let dir = skills_dir(
            "refill",
            &[("alpha", "---\nname: alpha\ndescription: first\n---\nbody\n")],
        );
        let base = Skills::scan(dir.clone()).baseline();

        // Point at an empty directory: nothing is announced, baseline empties.
        let empty =
            std::env::temp_dir().join(format!("bridge-skills-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        let empty_scan = Skills::scan(empty.clone());
        assert!(empty_scan.delta(&base).is_none());
        let empty_base = empty_scan.baseline();

        // Point back: alpha is new against the empty baseline, so it re-advertises.
        let delta = Skills::scan(dir.clone()).delta(&empty_base).unwrap();
        assert!(delta.contains("- alpha: first"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }
}
