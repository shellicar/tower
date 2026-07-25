import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';

const renderer = new Renderer();
renderer.link = function ({ href, title, tokens }) {
  const titleAttr = title != null ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(tokens)}</a>`;
};
const marked = new Marked({ renderer, gfm: true, breaks: true });

// Untrusted message content, sanitized before {@html}. target/rel survive
// DOMPurify's default attribute allowlist only via ADD_ATTR.
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), { ADD_ATTR: ['target', 'rel'] });
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
