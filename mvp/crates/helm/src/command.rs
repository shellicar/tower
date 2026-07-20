//! Command mode: the one surface for actions, mirroring claude-sdk-cli's
//! CommandKeyHandler shape. Ctrl+/ is the only door in; Ctrl+/ or Esc the
//! only ways out. While open, bare keys fire intents and everything else is
//! claimed — the say editor never sees a stray keystroke. Sub-states (the
//! attach path editor) nest one level; Esc pops one level, Ctrl+/ closes
//! whole.

use crate::editor::Editor;

#[derive(Debug, Default)]
pub enum CommandMode {
    #[default]
    Closed,
    /// The root binding set: f attach · d drop attachment · y/n approval.
    Root,
    /// The attach path editor (f) — Enter submits, Esc backs out to root.
    AttachEdit(Editor),
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
            CommandMode::AttachEdit(_) => CommandMode::Root,
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
        let mut mode = CommandMode::AttachEdit(Editor::default());
        mode.toggle();
        assert!(matches!(mode, CommandMode::Closed));
    }

    #[test]
    fn escape_pops_one_level() {
        let mut mode = CommandMode::AttachEdit(Editor::default());
        mode.escape();
        assert!(matches!(mode, CommandMode::Root));
        mode.escape();
        assert!(matches!(mode, CommandMode::Closed));
    }
}
