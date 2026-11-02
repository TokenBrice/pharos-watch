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

/**
 * Enforce the rich-text contract at every editorial HTML position. Mutates the
 * parsed content into its canonical allowlisted form and throws on active or
 * unsupported markup, so the builder and its tests share one boundary.
 */
export function validateEditorialContent(content) {
  const sections = Object.fromEntries(content.sections.map(section => [section.id, section]));
  for (const field of ['tldr', 'watch']) content[field] = content[field].map((value, i) => allowlistedRichText(value, `${field}[${i}]`));
  for (const id of ['movers', 'launches', 'stress', 'market']) {
    const section = sections[id];
    if (id === 'movers') section.rows.forEach((row, i) => { row.why = allowlistedRichText(row.why, `sections.movers.rows[${i}].why`); });
    else section.items = section.items.map((value, i) => allowlistedRichText(value, `sections.${section.id}.items[${i}]`));
  }
  content.annex.blocks.forEach((block, i) => { block.body = allowlistedRichText(block.body, `annex.blocks[${i}].body`); });
  content.annex.methodology = allowlistedRichText(content.annex.methodology, 'annex.methodology');
  return content;
}
