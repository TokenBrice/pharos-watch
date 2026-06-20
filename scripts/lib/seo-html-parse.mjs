const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const INVISIBLE_CONTENT_TAGS = new Set(["script", "style", "template", "svg"]);
const TAG_PATTERNS = {
  link: /<link\b[^>]*>/gi,
  meta: /<meta\b[^>]*>/gi,
};

export function decodeHtml(value) {
  return value.replace(/&(#(\d+)|#x([a-f0-9]+)|quot|#39|apos|amp|lt|gt);/gi, (entity, token, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    const named = token.toLowerCase();
    if (named === "quot") return '"';
    if (named === "#39" || named === "apos") return "'";
    if (named === "amp") return "&";
    if (named === "lt") return "<";
    if (named === "gt") return ">";
    return entity;
  });
}

export function parseAttributes(tag) {
  const attrs = new Map();
  // eslint-disable-next-line security/detect-unsafe-regex
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match = attrPattern.exec(tag);
  while (match) {
    const [, rawName, doubleQuoted, singleQuoted, unquoted] = match;
    if (!rawName.startsWith("<") && !rawName.startsWith("/")) {
      attrs.set(rawName.toLowerCase(), decodeHtml(doubleQuoted ?? singleQuoted ?? unquoted ?? ""));
    }
    match = attrPattern.exec(tag);
  }
  return attrs;
}

export function getTags(html, tagName) {
  const pattern = TAG_PATTERNS[tagName];
  if (!pattern) return [];
  return html.match(pattern) ?? [];
}

export function getMetaContents(html, attrName, attrValue) {
  return getTags(html, "meta")
    .map((tag) => parseAttributes(tag))
    .filter((attrs) => (attrs.get(attrName)?.toLowerCase() ?? "") === attrValue.toLowerCase())
    .map((attrs) => attrs.get("content") ?? "")
    .filter(Boolean);
}

export function getCanonical(html) {
  for (const tag of getTags(html, "link")) {
    const attrs = parseAttributes(tag);
    const relTokens = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (relTokens.includes("canonical")) {
      return attrs.get("href") ?? "";
    }
  }
  return "";
}

export function extractJsonLdBlocks(html) {
  const blocks = [];
  const lowerHtml = html.toLowerCase();
  let offset = 0;
  while (offset < html.length) {
    const scriptStart = lowerHtml.indexOf("<script", offset);
    if (scriptStart < 0) break;
    const openTagEnd = html.indexOf(">", scriptStart);
    if (openTagEnd < 0) break;
    const closeTagStart = lowerHtml.indexOf("</script>", openTagEnd + 1);
    if (closeTagStart < 0) break;
    const openTag = html.slice(scriptStart, openTagEnd + 1);
    const attrs = parseAttributes(openTag);
    const type = (attrs.get("type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/ld+json") {
      blocks.push(html.slice(openTagEnd + 1, closeTagStart));
    }
    offset = closeTagStart + "</script>".length;
  }
  return blocks;
}

export function collectStructuredDataNodes(value, nodes = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredDataNodes(item, nodes));
    return nodes;
  }

  if (!value || typeof value !== "object") {
    return nodes;
  }

  if (Object.hasOwn(value, "@type") || Object.hasOwn(value, "additionalType")) {
    nodes.push(value);
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      collectStructuredDataNodes(item, nodes);
    }
  }

  return nodes;
}

function normalizeSchemaType(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^https?:\/\/schema\.org\//, "");
}

export function getSchemaTypes(node) {
  const rawTypes = [node?.["@type"], node?.additionalType].flat();
  return rawTypes.map(normalizeSchemaType).filter(Boolean);
}

export function nodeHasSchemaType(node, type) {
  return getSchemaTypes(node).includes(type);
}

export function getPathValue(value, pathExpression) {
  let current = value;
  for (const segment of pathExpression.split(".")) {
    if (current == null) return undefined;

    if (Array.isArray(current)) {
      if (/^\d+$/.test(segment)) {
        current = current[Number(segment)];
      } else {
        current = current.map((item) => item?.[segment]).find((item) => item !== undefined && item !== null);
      }
      continue;
    }

    if (typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

export function hasMeaningfulPathValue(value, pathExpression) {
  const pathValue = getPathValue(value, pathExpression);
  if (pathValue == null) return false;
  if (typeof pathValue === "string") return pathValue.trim().length > 0;
  if (Array.isArray(pathValue)) return pathValue.length > 0;
  return true;
}

export function normalizeTextForSearch(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function getFaqEntries(record) {
  return record.structuredDataNodes
    .filter((node) => nodeHasSchemaType(node, "FAQPage"))
    .flatMap((node) => (Array.isArray(node.mainEntity) ? node.mainEntity : []))
    .map((entry) => ({
      question: entry?.name,
      answer: entry?.acceptedAnswer?.text,
    }))
    .filter((entry) => typeof entry.question === "string" && typeof entry.answer === "string");
}

function getMainHtml(html) {
  const mainOpen = html.search(/<main\b/i);
  if (mainOpen === -1) return html;
  const mainClose = html.search(/<\/main>/i);
  if (mainClose === -1 || mainClose < mainOpen) return html.slice(mainOpen);
  return html.slice(mainOpen, mainClose + "</main>".length);
}

export function isHiddenElement(attrs) {
  const classTokens = (attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
  const style = attrs.get("style") ?? "";
  return (
    attrs.has("hidden") ||
    (attrs.get("aria-hidden") ?? "").toLowerCase() === "true" ||
    classTokens.includes("hidden") ||
    classTokens.includes("sr-only") ||
    /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style) ||
    /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(style)
  );
}

export function extractVisibleText(html) {
  const scope = getMainHtml(html);
  const chunks = [];
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g;
  let hiddenDepth = 0;
  let match = tokenPattern.exec(scope);

  while (match) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<!")) {
      match = tokenPattern.exec(scope);
      continue;
    }

    const closingTag = token.match(/^<\/\s*([A-Za-z][\w:-]*)/);
    if (closingTag) {
      if (hiddenDepth > 0) hiddenDepth -= 1;
      match = tokenPattern.exec(scope);
      continue;
    }

    const openingTag = token.match(/^<\s*([A-Za-z][\w:-]*)/);
    if (openingTag) {
      const tagName = openingTag[1].toLowerCase();
      const isSelfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tagName);
      const attrs = parseAttributes(token);
      const isInvisible = INVISIBLE_CONTENT_TAGS.has(tagName) || isHiddenElement(attrs);
      if (!isSelfClosing && (hiddenDepth > 0 || isInvisible)) {
        hiddenDepth += 1;
      }
      match = tokenPattern.exec(scope);
      continue;
    }

    if (hiddenDepth === 0) {
      chunks.push(token);
    }
    match = tokenPattern.exec(scope);
  }

  return decodeHtml(chunks.join(" ")).replace(/\s+/g, " ").trim();
}

export function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}
