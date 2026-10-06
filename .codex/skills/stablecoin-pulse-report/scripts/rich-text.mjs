import { JSDOM } from 'jsdom';

// Parse inertly, then reconstruct only the documented editorial vocabulary.
export function allowlistedRichText(value, field) {
  const fragment = JSDOM.fragment(value);
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const render = node => {
    if (node.nodeType === 3) return escape(node.textContent);
    if (node.nodeType === 8) return '';
    const tag = node.localName;
    if (!['b', 'i', 'a'].includes(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      throw new Error(`content.json: ${field} contains unsupported rich-text markup`);
    }
    if ([...node.attributes].some(attribute => tag !== 'a' || attribute.name !== 'href')) {
      throw new Error(`content.json: ${field} contains unsupported rich-text attributes`);
    }
    let href = '';
    if (tag === 'a') {
      let url;
      try { url = new URL(node.getAttribute('href')); } catch { throw new Error(`content.json: ${field} link must be HTTPS`); }
      if (url.protocol !== 'https:') throw new Error(`content.json: ${field} link must be HTTPS`);
      href = ` href="${escape(url.href)}"`;
    }
    return `<${tag}${href}>${[...node.childNodes].map(render).join('')}</${tag}>`;
  };
  return [...fragment.childNodes].map(render).join('');
}
