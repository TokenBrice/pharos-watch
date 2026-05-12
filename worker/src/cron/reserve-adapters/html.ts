export function htmlLayoutChangedError(adapterName: string, detail: string): Error {
  return new Error(`${adapterName}: layout-changed: ${detail}`);
}

export function htmlParseError(adapterName: string, detail: string): Error {
  return new Error(`${adapterName}: parse-failed: ${detail}`);
}

/** Escape regex metacharacters so a user-controlled or layout-driven string
 *  can be safely interpolated into a constructed regex. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Named HTML entities encountered in disclosure pages. Numeric (`&#123;` /
 *  `&#xAB;`) entities are decoded directly by {@link decodeHtmlEntities}. */
export const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/** Decode named (`&amp;`) and numeric (`&#xA0;` / `&#160;`) HTML entities.
 *  Unknown named entities are left untouched. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name.startsWith("#x")) {
      const codePoint = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (name.startsWith("#")) {
      const codePoint = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return HTML_ENTITY_MAP[name] ?? entity;
  });
}

/** Strip HTML tags from `value`, collapse whitespace, trim, and decode HTML
 *  entities so the resulting string is safe to feed into number/date parsers. */
export function stripTags(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Read an attribute value from a single tag string (e.g. `<a href="...">`).
 *  Handles double-quoted, single-quoted, and unquoted values, and decodes any
 *  HTML entities in the returned value. Returns `null` when the attribute is
 *  missing or empty. */
export function readHtmlAttribute(tag: string, name: string): string | null {
  const escapedName = escapeRegExp(name);
  // eslint-disable-next-line security/detect-non-literal-regexp -- attribute name is escaped before constructing the bounded matcher.
  const regex = new RegExp(String.raw`\b${escapedName}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i");
  const match = tag.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value.trim()) : null;
}

/** Locate the opening tag (`<… id="…" …>`) of the element with the given `id`.
 *  Returns the tag substring or `null` if not found. */
export function extractTagById(html: string, id: string): string | null {
  const escapedId = escapeRegExp(id);
  // eslint-disable-next-line security/detect-non-literal-regexp -- id is escaped before interpolation.
  const re = new RegExp(`<[^>]*\\sid\\s*=\\s*["']${escapedId}["'][^>]*>`, "i");
  return html.match(re)?.[0] ?? null;
}

/** Locate the first match of `anchor` inside `html` and return the substring
 *  spanning `halfWidth` characters on either side, clamped to the document
 *  bounds. Returns `null` when the anchor is not present. Adapters use this to
 *  scope subsequent regex lookups to the disclosure block surrounding an
 *  anchor element instead of the whole page. */
export function extractAnchorWindow(html: string, anchor: RegExp, halfWidth: number): string | null {
  const match = anchor.exec(html);
  if (!match) return null;
  const start = Math.max(0, match.index - halfWidth);
  const end = Math.min(html.length, match.index + halfWidth);
  return html.slice(start, end);
}

/** Match a `<span>{label}</span>\s*<span>{value}</span>` pair (case-insensitive)
 *  and return the trimmed inner text of the value span. The label is escaped
 *  before interpolation. Returns `null` when no such pair exists. */
export function extractLabeledSpanText(html: string, label: string): string | null {
  const escapedLabel = escapeRegExp(label);
  // eslint-disable-next-line security/detect-non-literal-regexp -- label is escaped before interpolation.
  const re = new RegExp(
    `<span[^>]*>\\s*${escapedLabel}\\s*</span>\\s*<span[^>]*>\\s*([^<]+?)\\s*</span>`,
    "i",
  );
  const match = html.match(re);
  return match?.[1]?.trim() ?? null;
}

function decodeEscapedJsonFragment(fragment: string): string {
  return fragment
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"");
}

export function extractEscapedJsonValueAfterKey(
  html: string,
  key: string,
  adapterName: string,
): string {
  const keyIndex = html.indexOf(key);
  if (keyIndex < 0) {
    throw htmlLayoutChangedError(adapterName, `missing ${key}`);
  }

  const valueStart = keyIndex + key.length;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = valueStart; index < html.length; index += 1) {
    const char = html[index];
    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return decodeEscapedJsonFragment(html.slice(start, index + 1));
      }
    }
  }

  throw htmlParseError(adapterName, `unterminated ${key}`);
}
