//! The editor concern: the input buffer and its cursor (tui-architecture.md
//! view state). Pure — keys in, text state out; the submit itself is main's
//! wiring. No tower-frontend reference exists for this (a browser textarea
//! does it natively), so this is the one concern ported in spirit from
//! claude-sdk-cli's EditorState, minus what a first slice doesn't need
//! (word-wise ops, selection, kill ring).

#[derive(Debug, Default)]
pub struct Editor {
    chars: Vec<char>,
    cursor: usize,
}

impl Editor {
    pub fn insert(&mut self, c: char) {
        self.chars.insert(self.cursor, c);
        self.cursor += 1;
    }

    pub fn newline(&mut self) {
        self.insert('\n');
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.chars.len());
    }

    /// Start of the current logical line.
    pub fn home(&mut self) {
        while self.cursor > 0 && self.chars[self.cursor - 1] != '\n' {
            self.cursor -= 1;
        }
    }

    /// End of the current logical line.
    pub fn end(&mut self) {
        while self.cursor < self.chars.len() && self.chars[self.cursor] != '\n' {
            self.cursor += 1;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.chars.iter().all(|c| c.is_whitespace())
    }

    /// Drain the buffer for a submit.
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        self.chars.drain(..).collect()
    }

    /// The buffer as logical lines, plus the cursor's (line, column) — what
    /// layout needs to draw the box and place the hardware cursor.
    pub fn lines_and_cursor(&self) -> (Vec<String>, (usize, usize)) {
        let mut lines: Vec<String> = vec![String::new()];
        let mut cursor_line = 0;
        let mut cursor_col = 0;
        for (i, &c) in self.chars.iter().enumerate() {
            if i == self.cursor {
                cursor_line = lines.len() - 1;
                cursor_col = lines.last().expect("never empty").chars().count();
            }
            if c == '\n' {
                lines.push(String::new());
            } else {
                lines.last_mut().expect("never empty").push(c);
            }
        }
        if self.cursor == self.chars.len() {
            cursor_line = lines.len() - 1;
            cursor_col = lines.last().expect("never empty").chars().count();
        }
        (lines, (cursor_line, cursor_col))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor_with(text: &str) -> Editor {
        let mut e = Editor::default();
        for c in text.chars() {
            e.insert(c);
        }
        e
    }

    #[test]
    fn typing_moves_the_cursor_with_the_text() {
        let e = editor_with("hi");
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec!["hi"]);
        assert_eq!(cursor, (0, 2));
    }

    #[test]
    fn newline_splits_lines_and_cursor_follows() {
        let mut e = editor_with("ab");
        e.newline();
        e.insert('c');
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec!["ab", "c"]);
        assert_eq!(cursor, (1, 1));
    }

    #[test]
    fn backspace_at_line_start_joins_lines() {
        let mut e = editor_with("ab\nc");
        e.home(); // start of "c"
        e.backspace(); // removes the newline
        let (lines, _) = e.lines_and_cursor();
        assert_eq!(lines, vec!["abc"]);
    }

    #[test]
    fn home_and_end_work_within_the_current_line() {
        let mut e = editor_with("ab\ncd");
        e.home();
        let (_, cursor) = e.lines_and_cursor();
        assert_eq!(cursor, (1, 0));
        e.end();
        let (_, cursor) = e.lines_and_cursor();
        assert_eq!(cursor, (1, 2));
    }

    #[test]
    fn take_drains_and_resets() {
        let mut e = editor_with("hello");
        assert_eq!(e.take(), "hello");
        assert!(e.is_empty());
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec![""]);
        assert_eq!(cursor, (0, 0));
    }

    #[test]
    fn whitespace_only_is_empty() {
        assert!(editor_with("  \n ").is_empty());
        assert!(!editor_with(" x ").is_empty());
    }

    #[test]
    fn insert_mid_buffer_lands_at_the_cursor() {
        let mut e = editor_with("ac");
        e.left();
        e.insert('b');
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec!["abc"]);
        assert_eq!(cursor, (0, 2));
    }

    #[test]
    fn delete_removes_under_the_cursor() {
        let mut e = editor_with("abc");
        e.home();
        e.delete();
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec!["bc"]);
        assert_eq!(cursor, (0, 0));
    }
}
