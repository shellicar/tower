//! Markdown layout for text blocks: a token walk over pulldown-cmark emitting
//! styled, wrapped display lines — the Rust twin of claude-sdk-cli's
//! markdownLayout.ts, with the same palette (heading grades 39/74/110, accent
//! 33, link 39, code 180). Tables render aligned columns with a bold ruled
//! header; raw HTML passes through untouched. Lines come back pre-wrapped because helm's
//! hit map needs every visual row accounted for here, not by ratatui.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const ACCENT: Color = Color::Indexed(33);
const LINK: Color = Color::Indexed(39);
const CODE_FG: Color = Color::Indexed(180);
const HEADING: [Color; 3] = [Color::Indexed(39), Color::Indexed(74), Color::Indexed(110)];
const HR_WIDTH: usize = 40;

fn dim() -> Style {
    Style::default().fg(Color::DarkGray)
}

/// A clickable region on one display row: columns [start, end) and the href
/// a click there opens. Columns are relative to the row's own left edge.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkHit {
    pub start: usize,
    pub end: usize,
    pub href: String,
}

/// One laid display row: the styled line and any link regions on it.
#[derive(Clone, Debug, PartialEq)]
pub struct MdLine {
    pub line: Line<'static>,
    pub links: Vec<LinkHit>,
}

impl MdLine {
    fn plain(line: Line<'static>) -> Self {
        Self {
            line,
            links: Vec::new(),
        }
    }
}

/// Lay one markdown text out into styled display lines of at most `width`
/// columns. Pure: text and width in, lines out.
pub fn lay(text: &str, width: usize) -> Vec<MdLine> {
    let mut renderer = Renderer::new(width);
    let parser = Parser::new_ext(text, Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES);
    for event in parser {
        renderer.event(event);
    }
    renderer.finish()
}

/// A styled fragment of the logical line being assembled, carrying the href
/// it belongs to so the click region survives the wrap.
#[derive(Clone)]
struct Seg {
    text: String,
    style: Style,
    href: Option<String>,
}

/// Wrap styled segments into rows of at most `width` columns, splitting on
/// grapheme clusters measured the way the renderer places cells — the same
/// contract as view.rs's wrap_segments, carried per-segment so styles and
/// hrefs survive.
fn wrap_segs(segs: &[Seg], width: usize) -> Vec<Vec<Seg>> {
    let width = width.max(1);
    let mut lines: Vec<Vec<Seg>> = Vec::new();
    let mut current: Vec<Seg> = Vec::new();
    let mut current_width = 0usize;
    for seg in segs {
        let mut piece = String::new();
        for grapheme in seg.text.graphemes(true) {
            let grapheme_width = grapheme.width();
            if current_width + grapheme_width > width && current_width > 0 {
                if !piece.is_empty() {
                    current.push(Seg {
                        text: std::mem::take(&mut piece),
                        style: seg.style,
                        href: seg.href.clone(),
                    });
                }
                lines.push(std::mem::take(&mut current));
                current_width = 0;
            }
            piece.push_str(grapheme);
            current_width += grapheme_width;
        }
        if !piece.is_empty() {
            current.push(Seg {
                text: piece,
                style: seg.style,
                href: seg.href.clone(),
            });
        }
    }
    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }
    lines
}

struct Renderer {
    width: usize,
    out: Vec<MdLine>,
    current: Vec<Seg>,
    bold: usize,
    italic: usize,
    strike: usize,
    link: usize,
    /// The open link's destination, stamped onto every seg inside it.
    link_href: Option<String>,
    heading: Option<HeadingLevel>,
    quote_depth: usize,
    /// One entry per open list: the next ordered number, or None for bullets.
    lists: Vec<Option<u64>>,
    /// The current item's marker, consumed by the first flushed row.
    marker: Option<String>,
    marker_width: usize,
    /// An open fenced/indented code block: language and accumulated body.
    code_block: Option<(String, String)>,
    /// An open table: completed rows of cells, and the current row so far.
    /// Cell content accumulates in `current` and is drained at each cell end.
    table: Option<Vec<Vec<Vec<Seg>>>>,
    table_row: Vec<Vec<Seg>>,
}

impl Renderer {
    fn new(width: usize) -> Self {
        Self {
            width: width.max(1),
            out: Vec::new(),
            current: Vec::new(),
            bold: 0,
            italic: 0,
            strike: 0,
            link: 0,
            link_href: None,
            heading: None,
            quote_depth: 0,
            lists: Vec::new(),
            marker: None,
            marker_width: 0,
            code_block: None,
            table: None,
            table_row: Vec::new(),
        }
    }

    fn style(&self) -> Style {
        let mut style = Style::default();
        if let Some(level) = self.heading {
            let index = (level as usize - 1).min(HEADING.len() - 1);
            style = style.fg(HEADING[index]).add_modifier(Modifier::BOLD);
        }
        if self.bold > 0 {
            style = style.add_modifier(Modifier::BOLD);
        }
        if self.italic > 0 || self.quote_depth > 0 {
            style = style.add_modifier(Modifier::ITALIC);
        }
        if self.strike > 0 {
            style = style.add_modifier(Modifier::CROSSED_OUT);
        }
        if self.link > 0 {
            style = style.fg(LINK).add_modifier(Modifier::UNDERLINED);
        }
        style
    }

    /// The row prefix outside the wrapped content: quote gutters, list
    /// indent, and (on an item's first row only) its marker.
    fn prefix(&self, first_row: bool) -> (Vec<Span<'static>>, usize) {
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut width = 0usize;
        for _ in 0..self.quote_depth {
            spans.push(Span::styled("\u{2502} ", dim()));
            width += 2;
        }
        if !self.lists.is_empty() {
            let pad = "  ".repeat(self.lists.len() - 1);
            width += pad.len();
            if !pad.is_empty() {
                spans.push(Span::raw(pad));
            }
            if let Some(marker) = &self.marker
                && first_row
            {
                let style = if marker.starts_with('\u{2022}') {
                    Style::default().fg(ACCENT)
                } else if marker.starts_with('\u{25e6}') {
                    dim()
                } else {
                    Style::default()
                };
                spans.push(Span::styled(marker.clone(), style));
            } else if self.marker_width > 0 {
                spans.push(Span::raw(" ".repeat(self.marker_width)));
            }
            width += self.marker_width;
        }
        (spans, width)
    }

    /// Flush the assembled logical line into wrapped display rows, turning
    /// each seg's href into a column-ranged link hit.
    fn flush(&mut self) {
        let content = std::mem::take(&mut self.current);
        if content.is_empty() {
            return;
        }
        let (_, prefix_width) = self.prefix(true);
        let available = self.width.saturating_sub(prefix_width).max(1);
        for (row, segs) in wrap_segs(&content, available).into_iter().enumerate() {
            let (mut spans, _) = self.prefix(row == 0);
            let mut links: Vec<LinkHit> = Vec::new();
            let mut col = prefix_width;
            for seg in segs {
                let seg_width = seg.text.width();
                if let Some(href) = &seg.href
                    && seg_width > 0
                {
                    match links.last_mut() {
                        Some(last) if last.end == col && last.href == *href => {
                            last.end += seg_width;
                        }
                        _ => links.push(LinkHit {
                            start: col,
                            end: col + seg_width,
                            href: href.clone(),
                        }),
                    }
                }
                col += seg_width;
                spans.push(Span::styled(seg.text, seg.style));
            }
            self.out.push(MdLine {
                line: Line::from(spans),
                links,
            });
            self.marker = None;
        }
    }

    /// Push a pre-formed row (rule, code box line) through the prefix.
    fn push_row(&mut self, mut segments: Vec<Span<'static>>) {
        let (mut line, _) = self.prefix(true);
        line.append(&mut segments);
        self.out.push(MdLine::plain(Line::from(line)));
        self.marker = None;
    }

    /// A blank separator row before a new block, unless one is already there.
    fn blank(&mut self) {
        if self
            .out
            .last()
            .is_some_and(|row| !row.line.spans.iter().all(|s| s.content.is_empty()))
        {
            self.out.push(MdLine::plain(Line::raw("")));
        }
    }

    fn text(&mut self, text: &str) {
        let style = self.style();
        // A text token can carry newlines (raw fallthrough); each one ends a row.
        let mut parts = text.split('\n').peekable();
        while let Some(part) = parts.next() {
            if !part.is_empty() {
                self.current.push(Seg {
                    text: part.to_string(),
                    style,
                    href: self.link_href.clone(),
                });
            }
            if parts.peek().is_some() {
                self.flush();
            }
        }
    }

    fn code_box(&mut self, lang: &str, body: &str) {
        let (_, prefix_width) = self.prefix(true);
        let max_inner = self.width.saturating_sub(prefix_width + 4).max(1);
        let mut wrapped: Vec<String> = Vec::new();
        for line in body.lines() {
            let seg = Seg {
                text: line.to_string(),
                style: Style::default(),
                href: None,
            };
            for segment in wrap_segs(&[seg], max_inner) {
                wrapped.push(segment.into_iter().map(|s| s.text).collect());
            }
        }
        let lang = if lang.is_empty() { "plaintext" } else { lang };
        let label_width = lang.width();
        let inner = wrapped
            .iter()
            .map(|l| l.width())
            .chain(std::iter::once(label_width + 1))
            .max()
            .unwrap_or(1)
            .min(max_inner);
        self.push_row(vec![
            Span::styled("\u{250c}\u{2500} ", dim()),
            Span::styled(lang.to_string(), Style::default().fg(ACCENT)),
            Span::styled(
                format!(
                    " {}\u{2510}",
                    "\u{2500}".repeat(inner.saturating_sub(1 + label_width))
                ),
                dim(),
            ),
        ]);
        for line in wrapped {
            let pad = inner.saturating_sub(line.width());
            self.push_row(vec![
                Span::styled("\u{2502} ", dim()),
                Span::styled(line, Style::default().fg(CODE_FG)),
                Span::styled(format!("{} \u{2502}", " ".repeat(pad)), dim()),
            ]);
        }
        self.push_row(vec![Span::styled(
            format!("\u{2514}{}\u{2518}", "\u{2500}".repeat(inner + 2)),
            dim(),
        )]);
    }

    /// Render a completed table with aligned columns: the first row is the
    /// header (bold, ruled off), cells pad to their column's widest content,
    /// dim │ separators between columns.
    fn table_box(&mut self, rows: Vec<Vec<Vec<Seg>>>) {
        if rows.is_empty() {
            return;
        }
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        let cell_width = |cell: &[Seg]| cell.iter().map(|s| s.text.width()).sum::<usize>();
        let mut widths = vec![0usize; columns];
        for row in &rows {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(cell_width(cell));
            }
        }
        for (index, row) in rows.into_iter().enumerate() {
            let mut spans: Vec<Span<'static>> = Vec::new();
            for (i, width) in widths.iter().enumerate() {
                if i > 0 {
                    spans.push(Span::styled(" \u{2502} ", dim()));
                }
                let cell = row.get(i).cloned().unwrap_or_default();
                let pad = width.saturating_sub(cell_width(&cell));
                for seg in cell {
                    let style = if index == 0 {
                        seg.style.add_modifier(Modifier::BOLD)
                    } else {
                        seg.style
                    };
                    spans.push(Span::styled(seg.text, style));
                }
                if pad > 0 {
                    spans.push(Span::raw(" ".repeat(pad)));
                }
            }
            self.push_row(spans);
            if index == 0 {
                let rule = widths
                    .iter()
                    .map(|w| "\u{2500}".repeat(*w))
                    .collect::<Vec<_>>()
                    .join("\u{2500}\u{253c}\u{2500}");
                self.push_row(vec![Span::styled(rule, dim())]);
            }
        }
    }

    fn event(&mut self, event: Event<'_>) {
        if let Some((_, body)) = &mut self.code_block {
            // Inside a fence everything is literal text until the End.
            match event {
                Event::Text(text) => {
                    body.push_str(&text);
                    return;
                }
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, body) = self.code_block.take().unwrap_or_default();
                    self.code_box(&lang, &body);
                    return;
                }
                _ => return,
            }
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.text(&text),
            Event::Code(code) => {
                let seg = Seg {
                    text: code.into_string(),
                    style: self.style().fg(CODE_FG),
                    href: self.link_href.clone(),
                };
                self.current.push(seg);
            }
            Event::SoftBreak => self.current.push(Seg {
                text: " ".into(),
                style: Style::default(),
                href: None,
            }),
            Event::HardBreak => self.flush(),
            Event::Rule => {
                self.blank();
                let width = self.width.min(HR_WIDTH);
                self.push_row(vec![Span::styled("\u{2500}".repeat(width), dim())]);
            }
            Event::TaskListMarker(done) => {
                let mark = if done { "[x] " } else { "[ ] " };
                self.current.push(Seg {
                    text: mark.to_string(),
                    style: dim(),
                    href: None,
                });
            }
            Event::Html(html) | Event::InlineHtml(html) => self.text(&html),
            Event::FootnoteReference(name) => self.text(&format!("[^{name}]")),
            Event::InlineMath(math) | Event::DisplayMath(math) => self.text(&math),
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                if self.lists.is_empty() {
                    self.blank();
                }
            }
            Tag::Heading { level, .. } => {
                self.blank();
                self.heading = Some(level);
            }
            Tag::BlockQuote(_) => {
                if self.quote_depth == 0 {
                    self.blank();
                }
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.blank();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                self.code_block = Some((lang, String::new()));
            }
            Tag::List(start) => {
                if self.lists.is_empty() {
                    self.blank();
                } else {
                    // A nested list interrupts its parent item's text.
                    self.flush();
                }
                self.lists.push(start);
            }
            Tag::Item => {
                let depth = self.lists.len();
                let marker = match self.lists.last_mut() {
                    Some(Some(n)) => {
                        let marker = format!("{n}. ");
                        *n += 1;
                        marker
                    }
                    _ if depth <= 1 => "\u{2022} ".to_string(),
                    _ => "\u{25e6} ".to_string(),
                };
                self.marker_width = marker.width();
                self.marker = Some(marker);
            }
            Tag::Table(_) => {
                self.blank();
                self.table = Some(Vec::new());
            }
            Tag::Emphasis => self.italic += 1,
            Tag::Strong => self.bold += 1,
            Tag::Strikethrough => self.strike += 1,
            Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
                self.link += 1;
                self.link_href = Some(dest_url.to_string());
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Item => self.flush(),
            TagEnd::Heading(_) => {
                self.flush();
                self.heading = None;
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            TagEnd::List(_) => {
                self.flush();
                self.lists.pop();
                self.marker = None;
                if let Some(Some(_)) | Some(None) = self.lists.last() {
                    // Back inside the parent item: its marker is spent.
                    self.marker_width = 2;
                } else if self.lists.is_empty() {
                    self.marker_width = 0;
                }
            }
            TagEnd::TableCell => {
                let cell = std::mem::take(&mut self.current);
                self.table_row.push(cell);
            }
            TagEnd::TableHead | TagEnd::TableRow => {
                let row = std::mem::take(&mut self.table_row);
                if let Some(rows) = &mut self.table {
                    rows.push(row);
                }
            }
            TagEnd::Table => {
                if let Some(rows) = self.table.take() {
                    self.table_box(rows);
                }
            }
            TagEnd::Emphasis => self.italic = self.italic.saturating_sub(1),
            TagEnd::Strong => self.bold = self.bold.saturating_sub(1),
            TagEnd::Strikethrough => self.strike = self.strike.saturating_sub(1),
            TagEnd::Link | TagEnd::Image => {
                self.link = self.link.saturating_sub(1);
                if self.link == 0 {
                    self.link_href = None;
                }
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<MdLine> {
        self.flush();
        self.out
    }
}

#[cfg(test)]
mod tests {
    use ratatui::style::{Color, Modifier};

    use super::{MdLine, lay};

    fn row_text(row: &MdLine) -> String {
        row.line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn bold_markers_are_stripped_and_the_span_is_bold() {
        let lines = lay("plain **loud** plain", 40);

        assert_eq!(row_text(&lines[0]), "plain loud plain");
        let loud = lines[0]
            .line
            .spans
            .iter()
            .find(|s| s.content == "loud")
            .expect("the bold word has its own span");
        assert!(loud.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn a_codespan_keeps_its_text_and_takes_the_code_colour() {
        let lines = lay("run `just build` now", 40);

        let code = lines[0]
            .line
            .spans
            .iter()
            .find(|s| s.content == "just build")
            .expect("the codespan has its own span");
        assert_eq!(code.style.fg, Some(Color::Indexed(180)));
    }

    #[test]
    fn a_heading_loses_its_hashes_and_gains_its_grade() {
        let lines = lay("## Title", 40);

        assert_eq!(row_text(&lines[0]), "Title");
        assert_eq!(lines[0].line.spans[0].style.fg, Some(Color::Indexed(74)));
        assert!(
            lines[0].line.spans[0]
                .style
                .add_modifier
                .contains(Modifier::BOLD)
        );
    }

    #[test]
    fn bullets_render_dots_and_nested_items_indent() {
        let lines = lay("- top\n  - inner", 40);

        assert_eq!(row_text(&lines[0]), "\u{2022} top");
        assert_eq!(row_text(&lines[1]), "  \u{25e6} inner");
    }

    #[test]
    fn ordered_numbers_are_kept_literally() {
        let lines = lay("3. third\n4. fourth", 40);

        assert_eq!(row_text(&lines[0]), "3. third");
        assert_eq!(row_text(&lines[1]), "4. fourth");
    }

    #[test]
    fn a_wrapped_list_item_hangs_under_its_text() {
        let lines = lay("- abcdefgh", 8);

        assert_eq!(row_text(&lines[0]), "\u{2022} abcdef");
        assert_eq!(row_text(&lines[1]), "  gh");
    }

    #[test]
    fn a_blockquote_gets_a_gutter_and_italic_body() {
        let lines = lay("> quoted", 40);

        assert_eq!(row_text(&lines[0]), "\u{2502} quoted");
        let body = lines[0].line.spans.last().expect("quote body span");
        assert!(body.style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn a_fence_becomes_a_box_with_its_language_label() {
        let lines = lay("```rust\nlet x = 1;\n```", 40);

        let rows: Vec<String> = lines.iter().map(row_text).collect();
        assert!(rows[0].starts_with("\u{250c}\u{2500} rust "));
        assert_eq!(rows[1], "\u{2502} let x = 1; \u{2502}");
        assert!(rows[2].starts_with('\u{2514}'));
    }

    #[test]
    fn fence_markers_never_reach_the_screen() {
        let lines = lay("```\ncode\n```", 40);

        assert!(lines.iter().all(|l| !row_text(l).contains("```")));
    }

    #[test]
    fn a_link_renders_its_label_underlined() {
        let lines = lay("see [the spec](https://example.com) here", 40);

        assert_eq!(row_text(&lines[0]), "see the spec here");
        let label = lines[0]
            .line
            .spans
            .iter()
            .find(|s| s.content == "the spec")
            .expect("the label has its own span");
        assert!(label.style.add_modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn a_link_carries_its_click_range_and_href() {
        let lines = lay("see [the spec](https://example.com) here", 40);

        let link = lines[0].links.first().expect("one link on the row");
        assert_eq!(link.href, "https://example.com");
        // "see " is four columns; the label is eight.
        assert_eq!((link.start, link.end), (4, 12));
    }

    #[test]
    fn a_wrapped_link_carries_a_range_on_each_row() {
        let lines = lay("[abcdefghij](https://example.com)", 6);

        assert!(lines.len() > 1);
        assert!(lines.iter().all(|l| !l.links.is_empty()));
        assert!(
            lines
                .iter()
                .all(|l| l.links[0].href == "https://example.com")
        );
    }

    #[test]
    fn an_hr_is_a_dim_rule() {
        let lines = lay("above\n\n---\n\nbelow", 40);

        assert!(
            lines
                .iter()
                .any(|l| row_text(l).starts_with("\u{2500}\u{2500}\u{2500}"))
        );
    }

    #[test]
    fn a_table_renders_aligned_columns_with_a_ruled_header() {
        let source = "| left | b |\n|---|---|\n| 1 | 22 |";

        let lines = lay(source, 40);
        let rows: Vec<String> = lines.iter().map(row_text).collect();

        assert_eq!(rows, vec!["left │ b ", "─────┼───", "1    │ 22"]);
    }

    #[test]
    fn a_table_header_is_bold() {
        let lines = lay("| h |\n|---|\n| x |", 40);

        let header = lines[0].line.spans.first().expect("header cell span");
        assert!(header.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn paragraphs_are_separated_by_one_blank_row() {
        let lines = lay("one\n\ntwo", 40);

        let rows: Vec<String> = lines.iter().map(row_text).collect();
        assert_eq!(rows, vec!["one", "", "two"]);
    }

    #[test]
    fn long_prose_wraps_at_the_column_width() {
        let lines = lay("aaaa bbbb cccc", 5);

        assert!(lines.len() > 1);
        assert!(lines.iter().all(|l| {
            use unicode_width::UnicodeWidthStr;
            row_text(l).width() <= 5
        }));
    }
}
