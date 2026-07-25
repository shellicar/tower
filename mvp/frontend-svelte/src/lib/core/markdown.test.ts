// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasMarkdownConstructs, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders inline emphasis, strike, and code spans', () => {
    const html = renderMarkdown('**bold** *italic* ~~gone~~ `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders headings, lists, blockquotes, rules, and tables', () => {
    const html = renderMarkdown(
      '# Heading\n\n- one\n- two\n\n> quoted\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    );
    expect(html).toContain('<h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<table>');
  });

  it('renders code fences plainly', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
  });

  it('opens links in a new tab without leaking window.opener', () => {
    const html = renderMarkdown('[click me](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('strips a script tag entirely', () => {
    const html = renderMarkdown('before<script>alert(1)</script>after');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips an onerror handler from an image tag', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('strips a javascript: link href', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });
});

describe('hasMarkdownConstructs', () => {
  it('is false for plain prose', () => {
    expect(hasMarkdownConstructs('just some ordinary text, nothing fancy.')).toBe(false);
  });

  it('is true for headings, lists, fences, links, and emphasis', () => {
    expect(hasMarkdownConstructs('# heading')).toBe(true);
    expect(hasMarkdownConstructs('- item')).toBe(true);
    expect(hasMarkdownConstructs('```\ncode\n```')).toBe(true);
    expect(hasMarkdownConstructs('[link](https://x.com)')).toBe(true);
    expect(hasMarkdownConstructs('**bold**')).toBe(true);
  });
});
