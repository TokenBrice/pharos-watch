import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUT_DIR = path.resolve("out");
const BAILOUT_PATTERN = /BAILOUT_TO_CLIENT_SIDE_RENDERING|next-dynamic-bailout-to-csr/;
const PHAROS_ORIGIN = "https://pharos.watch";
const PHAROS_HOSTNAME = new URL(PHAROS_ORIGIN).hostname;
const RETIRED_INTERNAL_ROUTE_PREFIXES = [
  { prefix: "/blacklist", replacement: "/freezewatch/" },
  { prefix: "/tape", replacement: "/timeline/" },
];
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

const RICHNESS_CHECKS = [
  {
    label: "stablecoin detail",
    pattern: /^\/stablecoin\/[^/]+\/$/,
    minVisibleWords: 60,
  },
  {
    label: "chain detail",
    pattern: /^\/chains\/[^/]+\/$/,
    minVisibleWords: 35,
  },
];
const LOADING_SHELL_PATTERN = /\b(?:loading|placeholder|skeleton|fetching|pending)\b/gi;
const MAX_LOADING_WORD_RATIO = 0.15;
const MAX_LOADING_WORD_COUNT = 4;
const INDEXABLE_SNIPPET_LENGTHS = {
  title: { min: 35, max: 70 },
  description: { min: 110, max: 180 },
};
const REQUIRED_GOOGLE_PREVIEW_DIRECTIVES = ["max-snippet:-1", "max-image-preview:large", "max-video-preview:-1"];
const REQUIRED_STATIC_HEADER_RULES = [
  { route: "/*.txt", header: "X-Robots-Tag", directives: ["noindex", "nofollow"], label: "raw .txt payloads" },
  { route: "/stablecoin/*/yield/", header: "X-Robots-Tag", directives: ["noindex"], label: "yield detail pages" },
  { route: "/stablecoin/*/yield/*", header: "X-Robots-Tag", directives: ["noindex"], label: "yield detail assets" },
  { route: "/openapi.json", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "OpenAPI artifact" },
  { route: "/datasets/*.json", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "JSON datasets" },
  { route: "/datasets/*.csv", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "CSV datasets" },
  { route: "/datasets/*.ndjson", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "NDJSON datasets" },
  { route: "/sheets/*.csv", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "Sheets CSV exports" },
  { route: "/postman/*.json", header: "X-Robots-Tag", directives: ["noindex", "follow"], label: "Postman artifacts" },
];
const REQUIRED_STATIC_HEADER_RESETS = [
  { route: "/llms.txt", header: "X-Robots-Tag", label: "LLM-facing index" },
];
const DATASET_DATA_CATALOG_REFERENCE_PATHS = [
  "includedInDataCatalog.@id",
  "includedInDataCatalog.name",
  "includedInDataCatalog.url",
];

// FAQ structured data is retained as semantic markup for visible Q&A content.
// Google retired broad FAQ rich-result visibility, so this matrix treats FAQ as
// a consistency guardrail rather than a rich-result growth target.
const STRUCTURED_DATA_ROUTE_MATRIX = [
  {
    label: "home page",
    route: "/",
    nodes: [
      { type: "WebSite", requiredPaths: ["name", "url"] },
      { type: "Organization", requiredPaths: ["name", "url"] },
      { type: "WebApplication", requiredPaths: ["name", "url", "applicationCategory"] },
      { type: "CollectionPage", requiredPaths: ["name", "url", "mainEntity"] },
      { type: "ItemList", requiredPaths: ["name", "itemListElement.0.item.name"] },
    ],
  },
  {
    label: "active stablecoin detail",
    route: "/stablecoin/usdt-tether/",
    nodes: [
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs.0",
          "variableMeasured.0.name",
        ],
      },
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
    ],
  },
  {
    label: "pre-launch stablecoin detail",
    pattern: /^\/stablecoin\/[^/]+\/$/,
    selectTypes: ["WebPage", "Thing"],
    nodes: [
      { type: "WebPage", requiredPaths: ["name", "description", "url", "about"] },
      { type: "Thing", requiredPaths: ["name", "description"] },
    ],
  },
  {
    label: "cemetery",
    route: "/cemetery/",
    nodes: [
      { type: "CollectionPage", requiredPaths: ["name", "description", "url", "mainEntity"] },
      { type: "ItemList", requiredPaths: ["name", "numberOfItems", "itemListElement.0.item.name"] },
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs",
          "distribution.0.contentUrl",
        ],
      },
      { type: "DataDownload", requiredPaths: ["contentUrl", "encodingFormat"] },
    ],
  },
  {
    label: "chain directory",
    route: "/chains/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "CollectionPage", requiredPaths: ["name", "url", "mainEntity"] },
      { type: "ItemList", requiredPaths: ["name", "numberOfItems", "itemListElement.0.item.url"] },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "chain profile",
    pattern: /^\/chains\/[^/]+\/$/,
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "CollectionPage", requiredPaths: ["name", "url", "mainEntity"] },
      { type: "ItemList", requiredPaths: ["name", "numberOfItems", "itemListElement.0.item.url"] },
    ],
  },
  {
    label: "stablecoin taxonomy",
    route: "/stablecoins/",
    nodes: [
      { type: "CollectionPage", requiredPaths: ["name", "url"] },
      { type: "ItemList", requiredPaths: ["name", "numberOfItems", "itemListElement.0.url"] },
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs",
          "distribution.0.contentUrl",
          ...DATASET_DATA_CATALOG_REFERENCE_PATHS,
        ],
      },
    ],
  },
  {
    label: "depeg tracker",
    route: "/depeg/",
    nodes: [
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs",
          "distribution.0.contentUrl",
          ...DATASET_DATA_CATALOG_REFERENCE_PATHS,
        ],
      },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "depeg event detail",
    pattern: /^\/depeg\/[^/]+\/$/,
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "NewsArticle", requiredPaths: ["headline", "datePublished", "dateModified", "mainEntityOfPage"] },
    ],
  },
  {
    label: "safety scores",
    route: "/safety-scores/",
    nodes: [
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs",
          "distribution.0.contentUrl",
          ...DATASET_DATA_CATALOG_REFERENCE_PATHS,
        ],
      },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "coverage matrix",
    route: "/coverage/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      {
        type: "Dataset",
        requiredPaths: [
          "name",
          "description",
          "url",
          "creator.@type",
          "creator.name",
          "publisher.@type",
          "publisher.name",
          "license",
          "identifier.0.value",
          "sameAs",
          "variableMeasured.0.name",
          ...DATASET_DATA_CATALOG_REFERENCE_PATHS,
        ],
      },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "about API reference",
    route: "/about/api/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "DataCatalog", requiredPaths: ["name", "url", "dataset.0.@id"] },
      { type: "WebAPI", requiredPaths: ["name", "documentation", "endpointUrl"] },
      { type: "CreativeWork", requiredPaths: ["name", "url", "encodingFormat"] },
    ],
  },
  {
    label: "methodology",
    route: "/methodology/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
      { type: "TechArticle", requiredPaths: ["headline", "description", "mainEntityOfPage"] },
    ],
  },
  {
    label: "public docs detail",
    pattern: /^\/docs\/[^/]+\/$/,
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "TechArticle", requiredPaths: ["headline", "description", "dateModified", "mainEntityOfPage"] },
    ],
  },
  {
    label: "digest detail",
    pattern: /^\/digest\/[^/]+\/$/,
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "Article", requiredPaths: ["headline", "datePublished", "dateModified", "mainEntityOfPage"] },
    ],
  },
  {
    label: "PharosWatchBot",
    route: "/pharoswatchbot/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "SoftwareApplication", requiredPaths: ["name", "operatingSystem", "applicationCategory"] },
      { type: "HowTo", requiredPaths: ["name", "step.0.name"] },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "about FAQ",
    route: "/about/",
    nodes: [
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
    requireVisibleFaq: true,
  },
];

// Sitemap entries should resolve to exported HTML. Keep this list explicit if
// a future sitemap intentionally points at a Pages Function or non-HTML asset.
const SITEMAP_LOCAL_HTML_EXCEPTIONS = new Set([]);

function walkIndexFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_next") continue;
      results.push(...walkIndexFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "index.html") {
      results.push(fullPath);
    }
  }
  return results;
}

function routeFromFile(filePath, outDir) {
  const relDir = path.relative(outDir, path.dirname(filePath)).replace(/\\/g, "/");
  if (!relDir) return "/";
  return `/${relDir}/`;
}

function extractAttr(html, regex) {
  const match = html.match(regex);
  return match?.[1] ?? "";
}

function decodeHtml(value) {
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

function parseAttributes(tag) {
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

function getTags(html, tagName) {
  const pattern = TAG_PATTERNS[tagName];
  if (!pattern) return [];
  return html.match(pattern) ?? [];
}

function getMetaContents(html, attrName, attrValue) {
  return getTags(html, "meta")
    .map((tag) => parseAttributes(tag))
    .filter((attrs) => (attrs.get(attrName)?.toLowerCase() ?? "") === attrValue.toLowerCase())
    .map((attrs) => attrs.get("content") ?? "")
    .filter(Boolean);
}

function getCanonical(html) {
  for (const tag of getTags(html, "link")) {
    const attrs = parseAttributes(tag);
    const relTokens = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (relTokens.includes("canonical")) {
      return attrs.get("href") ?? "";
    }
  }
  return "";
}

function getRobotsDirectives(robotsTags) {
  return new Set(
    robotsTags.flatMap((robots) =>
      robots
        .toLowerCase()
        .split(/[,\s]+/)
        .map((directive) => directive.trim())
        .filter(Boolean),
    ),
  );
}

function isIndexable(robotsTags) {
  return !getRobotsDirectives(robotsTags).has("noindex");
}

function getRobotsConflicts(robotsTags) {
  const directives = getRobotsDirectives(robotsTags);
  const conflicts = [];
  if (directives.has("noindex") && directives.has("index")) {
    conflicts.push("noindex conflicts with index");
  }
  if (directives.has("nofollow") && directives.has("follow")) {
    conflicts.push("nofollow conflicts with follow");
  }
  return conflicts;
}

function parseStaticHeadersFile(text) {
  const blocks = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\S/.test(line)) {
      current = {
        route: trimmed,
        headers: new Map(),
        resets: new Set(),
      };
      blocks.push(current);
      continue;
    }

    if (!current) continue;
    if (trimmed.startsWith("!")) {
      current.resets.add(trimmed.slice(1).trim().toLowerCase());
      continue;
    }

    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const name = match[1].trim().toLowerCase();
    const value = match[2].trim();
    current.headers.set(name, [...(current.headers.get(name) ?? []), value]);
  }

  return blocks;
}

function validateStaticHeaders(outDir, errors) {
  const headersPath = path.join(outDir, "_headers");
  if (!fs.existsSync(headersPath)) {
    errors.push("static headers missing _headers file");
    return;
  }

  const blocks = parseStaticHeadersFile(fs.readFileSync(headersPath, "utf8"));
  const blockByRoute = new Map(blocks.map((block) => [block.route, block]));

  for (const rule of REQUIRED_STATIC_HEADER_RULES) {
    const block = blockByRoute.get(rule.route);
    if (!block) {
      errors.push(`static headers missing ${rule.label} rule for ${rule.route}`);
      continue;
    }

    const values = block.headers.get(rule.header.toLowerCase()) ?? [];
    if (values.length === 0) {
      errors.push(`static headers missing ${rule.header} on ${rule.label} rule ${rule.route}`);
      continue;
    }

    const directives = getRobotsDirectives(values);
    for (const directive of rule.directives) {
      if (!directives.has(directive)) {
        errors.push(`static headers ${rule.label} rule ${rule.route} missing ${rule.header} directive ${directive}`);
      }
    }
  }

  for (const reset of REQUIRED_STATIC_HEADER_RESETS) {
    const block = blockByRoute.get(reset.route);
    if (!block) {
      errors.push(`static headers missing ${reset.label} rule for ${reset.route}`);
      continue;
    }

    if (!block.resets.has(reset.header.toLowerCase())) {
      errors.push(`static headers ${reset.label} rule ${reset.route} must reset ${reset.header}`);
    }
  }
}

function collectNoindexHeaderRoutes(outDir) {
  const headersPath = path.join(outDir, "_headers");
  if (!fs.existsSync(headersPath)) return [];

  const blocks = parseStaticHeadersFile(fs.readFileSync(headersPath, "utf8"));
  const routes = [];
  for (const block of blocks) {
    const values = block.headers.get("x-robots-tag") ?? [];
    if (values.length > 0 && getRobotsDirectives(values).has("noindex")) {
      routes.push(block.route);
    }
  }
  return routes;
}

function headerRouteMatchesPath(routePattern, pathname) {
  // Cloudflare Pages _headers rules match the full path; `*` is a splat that
  // crosses path segments.
  const pattern = routePattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is built from the repo-controlled _headers file with metacharacters escaped
  return new RegExp(`^${pattern}$`).test(pathname);
}

function internalHrefParts(href) {
  if (!href) return null;
  if (href.startsWith("#")) {
    return null;
  }
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(href)?.[0].toLowerCase();
  if (scheme && scheme !== "http:" && scheme !== "https:") return null;

  try {
    const parsed = new URL(href, PHAROS_ORIGIN);
    if (parsed.hostname !== PHAROS_HOSTNAME) return null;
    if (!href.startsWith("/") && !scheme) return null;
    return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  } catch {
    return null;
  }
}

function normalizeHref(href) {
  const parts = internalHrefParts(href);
  if (!parts) return null;
  const target = parts.pathname;
  if (!target.startsWith("/")) return null;
  return target.endsWith("/") ? target : `${target}/`;
}

function slashlessInternalRouteMatch(href, routeSet) {
  const parts = internalHrefParts(href);
  if (!parts) return null;
  const { pathname, search, hash } = parts;
  if (pathname === "/" || pathname.endsWith("/")) return null;
  const canonicalPath = `${pathname}/`;
  if (!routeSet.has(canonicalPath)) return null;
  return `${canonicalPath}${search}${hash}`;
}

function retiredInternalRouteMatch(normalizedHref) {
  return (
    RETIRED_INTERNAL_ROUTE_PREFIXES.find((route) => {
      const normalizedPrefix = route.prefix.endsWith("/") ? route.prefix : `${route.prefix}/`;
      return normalizedHref.startsWith(normalizedPrefix);
    }) ?? null
  );
}

function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m = re.exec(xml);
  while (m) {
    locs.push(m[1]);
    m = re.exec(xml);
  }
  return new Set(locs);
}

function extractJsonLdBlocks(html) {
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

function jsonPathSegment(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function isSiteDataUrl(value) {
  if (!value.includes("/_site-data/")) return false;
  if (value.startsWith("/_site-data/")) return true;

  try {
    const parsed = new URL(value);
    return parsed.hostname === PHAROS_HOSTNAME && parsed.pathname.startsWith("/_site-data/");
  } catch {
    return false;
  }
}

function findStructuredDataSiteDataUrls(value, jsonPath = "$", results = []) {
  if (typeof value === "string") {
    if (isSiteDataUrl(value)) {
      results.push({ path: jsonPath, value });
    }
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findStructuredDataSiteDataUrls(item, `${jsonPath}[${index}]`, results));
    return results;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findStructuredDataSiteDataUrls(item, `${jsonPath}${jsonPathSegment(key)}`, results);
    }
  }

  return results;
}

function collectStructuredDataNodes(value, nodes = []) {
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

function getSchemaTypes(node) {
  const rawTypes = [node?.["@type"], node?.additionalType].flat();
  return rawTypes.map(normalizeSchemaType).filter(Boolean);
}

function nodeHasSchemaType(node, type) {
  return getSchemaTypes(node).includes(type);
}

function pageHasSchemaType(record, type) {
  return record.structuredDataNodes.some((node) => nodeHasSchemaType(node, type));
}

function getPathValue(value, pathExpression) {
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

function hasMeaningfulPathValue(value, pathExpression) {
  const pathValue = getPathValue(value, pathExpression);
  if (pathValue == null) return false;
  if (typeof pathValue === "string") return pathValue.trim().length > 0;
  if (Array.isArray(pathValue)) return pathValue.length > 0;
  return true;
}

function normalizeTextForSearch(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getFaqEntries(record) {
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

function isHiddenElement(attrs) {
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

function extractVisibleText(html) {
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

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function analyzeStaticRichness(record) {
  const visibleText = extractVisibleText(record.html);
  const words = wordCount(visibleText);
  const loadingWords = visibleText.match(LOADING_SHELL_PATTERN)?.length ?? 0;
  return {
    visibleText,
    words,
    loadingWords,
    loadingWordRatio: words > 0 ? loadingWords / words : 0,
  };
}

function selectRichnessRecords(pageRecords, check) {
  return pageRecords
    .filter((record) => check.pattern.test(record.route) && isIndexable(record.robotsTags))
    .sort((a, b) => a.route.localeCompare(b.route));
}

function selectStructuredDataRouteRecord(pageRecords, expectation) {
  const candidates = pageRecords
    .filter((record) => {
      if (!isIndexable(record.robotsTags)) return false;
      if (expectation.route) return record.route === expectation.route;
      return expectation.pattern?.test(record.route) ?? false;
    })
    .sort((a, b) => a.route.localeCompare(b.route));

  if (!expectation.selectTypes?.length) {
    return candidates[0] ?? null;
  }

  return candidates.find((record) => expectation.selectTypes.every((type) => pageHasSchemaType(record, type))) ?? null;
}

function validateStructuredDataRouteMatrix(pageRecords, errors, matrix) {
  for (const expectation of matrix) {
    const record = selectStructuredDataRouteRecord(pageRecords, expectation);
    const selector = expectation.route ?? String(expectation.pattern);
    if (!record) {
      const typeHint = expectation.selectTypes?.length
        ? ` with ${expectation.selectTypes.join(" + ")} structured data`
        : "";
      errors.push(`structured data route matrix missing ${expectation.label}: ${selector}${typeHint}`);
      continue;
    }

    for (const nodeExpectation of expectation.nodes) {
      const matchingNodes = record.structuredDataNodes.filter((node) => nodeHasSchemaType(node, nodeExpectation.type));
      if (matchingNodes.length === 0) {
        errors.push(`${record.route}: ${expectation.label} missing ${nodeExpectation.type} structured data`);
        continue;
      }

      for (const pathExpression of nodeExpectation.requiredPaths) {
        if (!matchingNodes.some((node) => hasMeaningfulPathValue(node, pathExpression))) {
          errors.push(
            `${record.route}: ${expectation.label} ${nodeExpectation.type} structured data missing ${pathExpression}`,
          );
        }
      }
    }

    if (expectation.requireVisibleFaq) {
      const visibleText = normalizeTextForSearch(extractVisibleText(record.html));
      for (const entry of getFaqEntries(record)) {
        const question = normalizeTextForSearch(entry.question);
        const answer = normalizeTextForSearch(entry.answer);
        if (question && !visibleText.includes(question)) {
          errors.push(`${record.route}: FAQPage question is not visible in page content: ${entry.question}`);
        }
        if (answer && !visibleText.includes(answer)) {
          errors.push(`${record.route}: FAQPage answer is not visible in page content for: ${entry.question}`);
        }
      }
    }
  }
}

function getAnchorHrefs(html) {
  const hrefs = [];
  const anchorPattern = /<a\b[^>]*>/gi;
  let match = anchorPattern.exec(html);
  while (match) {
    const attrs = parseAttributes(match[0]);
    const href = attrs.get("href");
    if (href) hrefs.push(href);
    match = anchorPattern.exec(html);
  }
  return hrefs;
}

function sitemapRouteFromPharosUrl(loc) {
  if (SITEMAP_LOCAL_HTML_EXCEPTIONS.has(loc)) return null;

  let parsed;
  try {
    parsed = new URL(loc);
  } catch {
    return { error: `sitemap.xml has invalid URL: ${loc}` };
  }

  if (parsed.hostname !== PHAROS_HOSTNAME) return null;
  if (parsed.protocol !== "https:") {
    return { error: `sitemap.xml pharos.watch URL must use https: ${loc}` };
  }
  if (parsed.search || parsed.hash) {
    return { error: `sitemap.xml pharos.watch URL must not include query or hash: ${loc}` };
  }

  const route = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return { route };
}

function canonicalUrlForRoute(route) {
  return `${PHAROS_ORIGIN}${route === "/" ? "/" : route}`;
}

// Returns the same-origin path that must exist in `out/` for an og:image / twitter:image
// reference, or `null` for external URLs (e.g. the dynamic /api/og/* worker route) that
// are not served by the static export.
function localOgImagePath(value) {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.hostname !== PHAROS_HOSTNAME) return null;
  return parsed.pathname;
}

export function collectSeoStaticCheckResult({
  outDir = DEFAULT_OUT_DIR,
  enforceGooglePreviewDirectives = true,
  enforceSnippetQuality = true,
  enforceStructuredDataMatrix = true,
  structuredDataRouteMatrix = STRUCTURED_DATA_ROUTE_MATRIX,
} = {}) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(outDir)) {
    return {
      errors: [`Missing build output directory: ${outDir}`],
      warnings,
      pageRecords: [],
    };
  }

  const indexFiles = walkIndexFiles(outDir);
  const pageRecords = indexFiles.map((filePath) => {
    const html = fs.readFileSync(filePath, "utf8");
    const robotsTags = getMetaContents(html, "name", "robots");
    return {
      filePath,
      route: routeFromFile(filePath, outDir),
      html,
      title: decodeHtml(extractAttr(html, /<title>([^<]*)<\/title>/i)),
      description: getMetaContents(html, "name", "description")[0] ?? "",
      canonical: getCanonical(html),
      ogTitle: getMetaContents(html, "property", "og:title")[0] ?? "",
      ogDescription: getMetaContents(html, "property", "og:description")[0] ?? "",
      ogType: getMetaContents(html, "property", "og:type")[0] ?? "",
      ogImage: getMetaContents(html, "property", "og:image")[0] ?? "",
      twitterCard: getMetaContents(html, "name", "twitter:card")[0] ?? "",
      twitterImage: getMetaContents(html, "name", "twitter:image")[0] ?? "",
      robotsTags,
      googleBotTags: getMetaContents(html, "name", "googlebot"),
      h1Count: (html.match(/<h1\b/gi) ?? []).length,
      structuredData: [],
      structuredDataNodes: [],
    };
  });

  validateStaticHeaders(outDir, errors);

  for (const record of pageRecords) {
    if (BAILOUT_PATTERN.test(record.html)) {
      errors.push(`${record.route}: CSR bailout marker found in HTML`);
    }

    if (!record.title) errors.push(`${record.route}: missing <title>`);
    if (!record.description) errors.push(`${record.route}: missing meta description`);
    const indexable = isIndexable(record.robotsTags);
    if (indexable && enforceSnippetQuality) {
      if (record.title && record.title.length < INDEXABLE_SNIPPET_LENGTHS.title.min) {
        errors.push(
          `${record.route}: <title> is too short for search snippets (${record.title.length} chars, minimum ${INDEXABLE_SNIPPET_LENGTHS.title.min})`,
        );
      }
      if (record.title && record.title.length > INDEXABLE_SNIPPET_LENGTHS.title.max) {
        errors.push(
          `${record.route}: <title> is too long for search snippets (${record.title.length} chars, maximum ${INDEXABLE_SNIPPET_LENGTHS.title.max})`,
        );
      }
      if (record.description && record.description.length < INDEXABLE_SNIPPET_LENGTHS.description.min) {
        errors.push(
          `${record.route}: meta description is too short for search snippets (${record.description.length} chars, minimum ${INDEXABLE_SNIPPET_LENGTHS.description.min})`,
        );
      }
      if (record.description && record.description.length > INDEXABLE_SNIPPET_LENGTHS.description.max) {
        errors.push(
          `${record.route}: meta description is too long for search snippets (${record.description.length} chars, maximum ${INDEXABLE_SNIPPET_LENGTHS.description.max})`,
        );
      }
    }
    if (indexable && !record.canonical) errors.push(`${record.route}: missing canonical`);
    if (indexable && record.canonical) {
      const expectedCanonical = canonicalUrlForRoute(record.route);
      if (record.canonical !== expectedCanonical) {
        errors.push(
          `${record.route}: canonical does not self-match local route: ${record.canonical} (expected ${expectedCanonical})`,
        );
      }
    }
    if (!record.ogTitle) errors.push(`${record.route}: missing og:title`);
    if (!record.ogDescription) errors.push(`${record.route}: missing og:description`);
    if (!record.twitterCard) errors.push(`${record.route}: missing twitter:card`);

    const robotsConflicts = getRobotsConflicts(record.robotsTags);
    for (const conflict of robotsConflicts) {
      errors.push(`${record.route}: conflicting robots directives (${conflict}) in ${record.robotsTags.join(" | ")}`);
    }

    if (indexable && enforceGooglePreviewDirectives) {
      const previewDirectives = getRobotsDirectives([...record.robotsTags, ...record.googleBotTags]);
      for (const directive of REQUIRED_GOOGLE_PREVIEW_DIRECTIVES) {
        if (!previewDirectives.has(directive)) {
          errors.push(`${record.route}: missing Google preview directive ${directive}`);
        }
      }
    }

    if (indexable && !record.ogType) {
      errors.push(`${record.route}: missing og:type`);
    }

    const jsonLdBlocks = extractJsonLdBlocks(record.html);
    jsonLdBlocks.forEach((block, index) => {
      let parsed;
      try {
        parsed = JSON.parse(block.trim());
      } catch (error) {
        errors.push(`${record.route}: invalid JSON-LD block #${index + 1}: ${error.message}`);
        return;
      }

      record.structuredData.push(parsed);
      record.structuredDataNodes.push(...collectStructuredDataNodes(parsed));

      if (indexable) {
        const siteDataUrls = findStructuredDataSiteDataUrls(parsed);
        for (const entry of siteDataUrls.slice(0, 5)) {
          errors.push(
            `${record.route}: structured data URL points under /_site-data/ at ${entry.path}: ${entry.value}`,
          );
        }
        if (siteDataUrls.length > 5) {
          errors.push(`${record.route}: structured data has ${siteDataUrls.length - 5} additional /_site-data/ URLs`);
        }
      }
    });

    if (indexable && record.h1Count !== 1) {
      errors.push(`${record.route}: expected exactly one <h1> on indexable page, got ${record.h1Count}`);
    }
  }

  const missingOgImagePaths = new Set();
  for (const record of pageRecords) {
    for (const [field, value] of [
      ["og:image", record.ogImage],
      ["twitter:image", record.twitterImage],
    ]) {
      const localPath = localOgImagePath(value);
      if (!localPath) continue;
      if (missingOgImagePaths.has(localPath)) {
        errors.push(`${record.route}: ${field} references missing file ${localPath}`);
        continue;
      }
      const filePath = path.join(outDir, localPath.replace(/^\/+/, ""));
      if (!fs.existsSync(filePath)) {
        missingOgImagePaths.add(localPath);
        errors.push(`${record.route}: ${field} references missing file ${localPath}`);
      }
    }
  }

  if (enforceStructuredDataMatrix) {
    validateStructuredDataRouteMatrix(pageRecords, errors, structuredDataRouteMatrix);
  }

  const routeSet = new Set(pageRecords.map((p) => p.route));
  const graph = new Map();
  const inbound = new Map();
  for (const route of routeSet) {
    graph.set(route, new Set());
    inbound.set(route, 0);
  }

  for (const record of pageRecords) {
    for (const href of getAnchorHrefs(record.html)) {
      const slashlessRoute = slashlessInternalRouteMatch(href, routeSet);
      if (slashlessRoute) {
        errors.push(`${record.route}: internal anchor href omits canonical trailing slash: ${href} (use ${slashlessRoute})`);
      }

      const normalized = normalizeHref(href);
      if (!normalized) continue;

      const retiredRoute = retiredInternalRouteMatch(normalized);
      if (retiredRoute) {
        errors.push(
          `${record.route}: internal anchor href points to retired route prefix ${retiredRoute.prefix}: ${href} (use ${retiredRoute.replacement})`,
        );
      }

      if (routeSet.has(normalized)) {
        graph.get(record.route).add(normalized);
        inbound.set(normalized, (inbound.get(normalized) ?? 0) + 1);
      }
    }
  }

  const depth = new Map();
  const queue = ["/"];
  depth.set("/", 0);

  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    const currentDepth = depth.get(current) ?? 0;
    for (const next of graph.get(current) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, currentDepth + 1);
        queue.push(next);
      }
    }
  }

  for (const record of pageRecords) {
    if (!isIndexable(record.robotsTags)) continue;

    const d = depth.get(record.route);
    if (d === undefined) {
      errors.push(`${record.route}: indexable page is unreachable from homepage`);
      continue;
    }
    if (d > 3) {
      errors.push(`${record.route}: indexable page depth is ${d} clicks (must be <= 3)`);
    }

    if (record.route !== "/" && (inbound.get(record.route) ?? 0) === 0) {
      errors.push(`${record.route}: indexable orphan page has zero internal inbound links`);
    }
  }

  const sitemapPath = path.join(outDir, "sitemap.xml");
  if (!fs.existsSync(sitemapPath)) {
    errors.push("out/sitemap.xml missing");
  } else {
    const sitemapXml = fs.readFileSync(sitemapPath, "utf8");
    const locs = parseSitemapLocs(sitemapXml);
    if (!locs.has("https://pharos.watch/stability-index/")) {
      errors.push("sitemap.xml missing https://pharos.watch/stability-index/");
    }
    if (locs.has("https://pharos.watch/stability-index-alt/")) {
      errors.push("sitemap.xml should not include https://pharos.watch/stability-index-alt/");
    }

    const pageUrlSet = new Set(
      pageRecords
        .filter((p) => isIndexable(p.robotsTags))
        .map((p) => `https://pharos.watch${p.route === "/" ? "/" : p.route}`),
    );

    const missingFromSitemap = [...pageUrlSet].filter((url) => !locs.has(url));
    if (missingFromSitemap.length > 0) {
      errors.push(
        `indexable pages missing from sitemap.xml: ${missingFromSitemap.slice(0, 10).join(", ")}${missingFromSitemap.length > 10 ? " ..." : ""}`,
      );
    }

    for (const loc of locs) {
      const sitemapRoute = sitemapRouteFromPharosUrl(loc);
      if (!sitemapRoute) continue;
      if (sitemapRoute.error) {
        errors.push(sitemapRoute.error);
        continue;
      }
      if (!routeSet.has(sitemapRoute.route)) {
        errors.push(`sitemap.xml URL has no local static HTML artifact: ${loc} (expected ${sitemapRoute.route})`);
      }
    }

    // A sitemap entry signals "index this"; an X-Robots-Tag noindex header on
    // the same route wins over meta robots and silently deindexes it. The
    // /compare/ hub shipped with exactly this three-way conflict (header
    // noindex + meta index + sitemap entry) for weeks.
    const noindexHeaderRoutes = collectNoindexHeaderRoutes(outDir);
    if (noindexHeaderRoutes.length > 0) {
      for (const loc of locs) {
        const sitemapRoute = sitemapRouteFromPharosUrl(loc);
        if (!sitemapRoute || sitemapRoute.error) continue;
        const pathname = new URL(loc).pathname;
        for (const routePattern of noindexHeaderRoutes) {
          if (headerRouteMatchesPath(routePattern, pathname)) {
            errors.push(
              `sitemap.xml URL ${loc} conflicts with _headers noindex rule ${routePattern}; drop one of the two signals`,
            );
          }
        }
      }
    }
  }

  for (const check of RICHNESS_CHECKS) {
    for (const record of selectRichnessRecords(pageRecords, check)) {
      const richness = analyzeStaticRichness(record);
      if (richness.words < check.minVisibleWords) {
        errors.push(
          `${record.route}: ${check.label} static HTML visible text is too thin (${richness.words} words, expected at least ${check.minVisibleWords})`,
        );
      }
      if (richness.loadingWords > MAX_LOADING_WORD_COUNT && richness.loadingWordRatio > MAX_LOADING_WORD_RATIO) {
        errors.push(
          `${record.route}: ${check.label} static HTML is dominated by loading shell text (${richness.loadingWords}/${richness.words} loading words)`,
        );
      }
    }
  }

  // Informational warning only: avoids failing CI for transient route count changes.
  warnings.push(`Checked ${pageRecords.length} HTML pages in out/`);

  return { errors, warnings, pageRecords };
}

function fail(errors, warning = []) {
  for (const w of warning) {
    console.warn(`WARN: ${w}`);
  }
  for (const e of errors) {
    console.error(`ERROR: ${e}`);
  }
  process.exit(1);
}

function main() {
  const { errors, warnings } = collectSeoStaticCheckResult();

  if (errors.length > 0) {
    fail(errors, warnings);
  }

  for (const w of warnings) {
    console.log(`OK: ${w}`);
  }
  console.log("OK: SEO static checks passed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
