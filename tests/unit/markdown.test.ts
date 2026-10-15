// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/lib/markdown';

describe('renderMarkdown', () => {
  it('renders basic formatting and emoji shortcodes', () => {
    const html = renderMarkdown('**bold** _it_ `code` ~~gone~~ :smile:\n- a\n- b');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<s>gone</s>');
    expect(html).toContain('😄');
    expect(html).toContain('<li>a</li>');
  });

  it('links get safe target/rel', () => {
    const html = renderMarkdown('[x](https://example.com) and https://auto.example');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://auto.example"');
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[x](vbscript:msgbox)',
    '<iframe src="https://evil"></iframe>',
    '<svg onload=alert(1)>',
    '<div style="background:url(javascript:alert(1))">x</div>',
  ])('neutralizes %s', (input) => {
    // Inspect the resulting DOM: escaped text like "&lt;img onerror=…&gt;" is harmless.
    const doc = document.createElement('div');
    doc.innerHTML = renderMarkdown(input);
    expect(doc.querySelector('script, img, iframe, svg, div, style, object, embed')).toBeNull();
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on/i);
        if (attr.name === 'href' || attr.name === 'src') expect(attr.value).toMatch(/^(https?:|mailto:)/i);
      }
    }
  });

  it('never loads remote images', () => {
    const html = renderMarkdown('![tracker](https://evil.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
  });
});
