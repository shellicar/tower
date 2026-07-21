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

    /// Start of the cursor's logical line.
    fn line_start(&self) -> usize {
        let mut i = self.cursor;
        while i > 0 && self.chars[i - 1] != '\n' {
            i -= 1;
        }
        i
    }

    /// Up one logical line, keeping the column where the line allows.
    /// First line: no-op — there is nowhere up to go.
    pub fn up(&mut self) {
        let line_start = self.line_start();
        if line_start == 0 {
            return;
        }
        let column = self.cursor - line_start;
        let prev_end = line_start - 1; // the '\n' above
        let mut prev_start = prev_end;
        while prev_start > 0 && self.chars[prev_start - 1] != '\n' {
            prev_start -= 1;
        }
        self.cursor = prev_start + column.min(prev_end - prev_start);
    }

    /// Down one logical line, keeping the column where the line allows.
    /// Last line: no-op.
    pub fn down(&mut self) {
        let column = self.cursor - self.line_start();
        let mut line_end = self.cursor;
        while line_end < self.chars.len() && self.chars[line_end] != '\n' {
            line_end += 1;
        }
        if line_end == self.chars.len() {
            return;
        }
        let next_start = line_end + 1;
        let mut next_end = next_start;
        while next_end < self.chars.len() && self.chars[next_end] != '\n' {
            next_end += 1;
        }
        self.cursor = next_start + column.min(next_end - next_start);
    }

    /// Start of the previous word: skip whitespace back, then the word.
    fn word_start_back(&self) -> usize {
        let mut i = self.cursor;
        while i > 0 && self.chars[i - 1].is_whitespace() {
            i -= 1;
        }
        while i > 0 && !self.chars[i - 1].is_whitespace() {
            i -= 1;
        }
        i
    }

    /// End of the next word: skip whitespace forward, then the word.
    fn word_end_forward(&self) -> usize {
        let mut i = self.cursor;
        while i < self.chars.len() && self.chars[i].is_whitespace() {
            i += 1;
        }
        while i < self.chars.len() && !self.chars[i].is_whitespace() {
            i += 1;
        }
        i
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_start_back();
    }

    pub fn word_right(&mut self) {
        self.cursor = self.word_end_forward();
    }

    /// Option/Ctrl+Backspace: delete back to the previous word's start.
    pub fn delete_word_back(&mut self) {
        let start = self.word_start_back();
        self.chars.drain(start..self.cursor);
        self.cursor = start;
    }

    /// Option/Ctrl+Delete: delete forward through the next word.
    pub fn delete_word_forward(&mut self) {
        let end = self.word_end_forward();
        self.chars.drain(self.cursor..end);
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

    #[test]
    fn word_backspace_eats_the_previous_word_and_its_gap() {
        let mut e = editor_with("hello brave world");
        e.delete_word_back();
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec!["hello brave "]);
        assert_eq!(cursor, (0, 12));
        e.delete_word_back();
        let (lines, _) = e.lines_and_cursor();
        assert_eq!(lines, vec!["hello "]);
    }

    #[test]
    fn word_delete_eats_the_next_word() {
        let mut e = editor_with("one two three");
        e.home();
        e.delete_word_forward();
        let (lines, cursor) = e.lines_and_cursor();
        assert_eq!(lines, vec![" two three"]);
        assert_eq!(cursor, (0, 0));
    }

    #[test]
    fn up_moves_to_the_same_column_of_the_line_above() {
        let mut e = editor_with("line1\nline2\nli_e3");
        e.left();
        e.left(); // column 3 of the last line
        e.up();

        let expected_cursor = (1, 3); // column 3 of "line2"
        let (_, actual_cursor) = e.lines_and_cursor();
        assert_eq!(actual_cursor, expected_cursor);
    }

    #[test]
    fn up_clamps_the_column_to_a_shorter_line() {
        let mut e = editor_with("ab\nlonger");
        e.end();
        e.up();

        let expected_cursor = (0, 2); // end of "ab"
        let (_, actual_cursor) = e.lines_and_cursor();
        assert_eq!(actual_cursor, expected_cursor);
    }

    #[test]
    fn down_moves_to_the_same_column_of_the_line_below() {
        let mut e = editor_with("alpha\nbeta");
        e.up();
        e.home();
        e.right(); // (0, 1)
        e.down();

        let expected_cursor = (1, 1);
        let (_, actual_cursor) = e.lines_and_cursor();
        assert_eq!(actual_cursor, expected_cursor);
    }

    #[test]
    fn up_on_the_first_line_and_down_on_the_last_are_no_ops() {
        let mut e = editor_with("only");
        e.up();
        let (_, after_up) = e.lines_and_cursor();
        assert_eq!(after_up, (0, 4));
        e.down();
        let (_, after_down) = e.lines_and_cursor();
        assert_eq!(after_down, (0, 4));
    }

    #[test]
    fn word_navigation_jumps_word_boundaries() {
        let mut e = editor_with("alpha beta");
        e.word_left();
        let (_, cursor) = e.lines_and_cursor();
        assert_eq!(cursor, (0, 6)); // start of "beta"
        e.word_left();
        let (_, cursor) = e.lines_and_cursor();
        assert_eq!(cursor, (0, 0));
        e.word_right();
        let (_, cursor) = e.lines_and_cursor();
        assert_eq!(cursor, (0, 5)); // end of "alpha"
    }
}
