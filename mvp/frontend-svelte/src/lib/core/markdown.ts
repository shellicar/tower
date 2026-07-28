import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: true });

// Every anchor leaves the sanitizer with the same target/rel, whether it came
// from markdown syntax or a raw HTML <a> in the source text — a renderer.link
// override only catches the former, so this runs post-sanitize on the real
// DOM nodes instead, where the guarantee can't be bypassed by writing raw HTML.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Untrusted message content, sanitized before {@html}.
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

// Detects whether text uses any markdown construct beyond plain prose, so
// textHeight.ts can bail to undefined (measure-after-mount) rather than
// teach the plain-line height model markdown's non-uniform line heights
// (headings, lists, code fences, tables all differ from LINE_HEIGHT).
const CONSTRUCT_RE =
  /^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s|^```|^\|.*\|$|^(-{3,}|\*{3,}|_{3,})$|\*\*[^*]|__[^_]|(?<!\*)\*[^*\s][^*]*\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)]+\)|~~[^~]+~~/m;

export function hasMarkdownConstructs(text: string): boolean {
  return CONSTRUCT_RE.test(text);
}
