//! Command mode: the one surface for actions, mirroring claude-sdk-cli's
//! CommandKeyHandler shape. Ctrl+/ is the only door in; Ctrl+/ or Esc the
//! only ways out. While open, bare keys fire intents and everything else is
//! claimed — the say editor never sees a stray keystroke. Sub-states (the
//! attach path editor) nest one level; Esc pops one level, Ctrl+/ closes
//! whole.

use tui_textarea::TextArea;

#[derive(Debug, Default)]
pub enum CommandMode {
    #[default]
    Closed,
    /// The root binding set: t/i/f attachments · d drop · y/n approval ·
    /// m model · c cwd · j config.
    Root,
    /// The attach path editor (f) — Enter adds the chip, Esc backs out.
    AttachEdit(TextArea<'static>),
    /// The model editor (m) — Enter sends the `model` control line.
    ModelEdit(TextArea<'static>),
    /// The cwd editor (c) — Enter sends the `cwd` control line.
    CwdEdit(TextArea<'static>),
    /// The config editor (j) — same grammar as `-c`: one JSON object per
    /// line, plain Enter breaks a line (multi-line, unlike the single-line
    /// editors above), Ctrl/Cmd+Enter sends every line through
    /// `apply_config_line` (config.rs).
    ConfigEdit(TextArea<'static>),
}

impl CommandMode {
    pub fn is_open(&self) -> bool {
        !matches!(self, CommandMode::Closed)
    }

    /// Ctrl+/ — from anywhere: closed opens to root, anything open closes.
    pub fn toggle(&mut self) {
        *self = match self {
            CommandMode::Closed => CommandMode::Root,
            _ => CommandMode::Closed,
        };
    }

    /// Esc — pops one level: an open editor backs out to root, root closes.
    pub fn escape(&mut self) {
        *self = match self {
            CommandMode::AttachEdit(_)
            | CommandMode::ModelEdit(_)
            | CommandMode::CwdEdit(_)
            | CommandMode::ConfigEdit(_) => CommandMode::Root,
            _ => CommandMode::Closed,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_opens_from_closed_and_closes_from_anywhere() {
        let mut mode = CommandMode::Closed;
        mode.toggle();
        assert!(matches!(mode, CommandMode::Root));
        mode.toggle();
        assert!(matches!(mode, CommandMode::Closed));
        let mut mode = CommandMode::AttachEdit(TextArea::default());
        mode.toggle();
        assert!(matches!(mode, CommandMode::Closed));
        let mut mode = CommandMode::ConfigEdit(TextArea::default());
        mode.toggle();
        assert!(matches!(mode, CommandMode::Closed));
    }

    #[test]
    fn escape_pops_one_level() {
        for mut mode in [
            CommandMode::AttachEdit(TextArea::default()),
            CommandMode::ModelEdit(TextArea::default()),
            CommandMode::CwdEdit(TextArea::default()),
            CommandMode::ConfigEdit(TextArea::default()),
        ] {
            mode.escape();
            assert!(matches!(mode, CommandMode::Root));
            mode.escape();
            assert!(matches!(mode, CommandMode::Closed));
        }
    }
}
