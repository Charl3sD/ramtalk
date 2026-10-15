// Renders peer-supplied markdown. markdown-it runs with raw HTML disabled and the image rule
// turned off (remote images would leak the reader's IP and can't load offline anyway); DOMPurify
// then enforces a strict tag/attribute allowlist as a second line of defence.

import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.use(emoji);
md.disable(['image']);

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const ALLOWED_ATTR = ['href', 'title', 'start', 'align'];
const SAFE_URL = /^(https?:|mailto:)/i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (!SAFE_URL.test(href)) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  purifier = p;
  return p;
}

export function renderMarkdown(source: string): string {
  return getPurifier().sanitize(md.render(source), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
