import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUT_DIR = path.resolve("out");
const BAILOUT_PATTERN = /BAILOUT_TO_CLIENT_SIDE_RENDERING|next-dynamic-bailout-to-csr/;
const PHAROS_ORIGIN = "https://pharos.watch";
const PHAROS_HOSTNAME = new URL(PHAROS_ORIGIN).hostname;
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
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

function normalizeHref(href) {
  if (!href) return null;
  if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
    return null;
  }

  try {
    let target = href;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      const parsed = new URL(target);
      if (parsed.hostname !== PHAROS_HOSTNAME) return null;
      target = parsed.pathname;
    }

    target = target.split("#")[0].split("?")[0];
    if (!target.startsWith("/")) return null;
    return target.endsWith("/") ? target : `${target}/`;
  } catch {
    return null;
  }
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
  const scriptPattern = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  let match = scriptPattern.exec(html);
  while (match) {
    const scriptHtml = match[0];
    const openTagEnd = scriptHtml.indexOf(">");
    const openTag = scriptHtml.slice(0, openTagEnd + 1);
    const attrs = parseAttributes(openTag);
    const type = (attrs.get("type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/ld+json") {
      blocks.push(scriptHtml.slice(openTagEnd + 1, scriptHtml.length - "</script>".length));
    }
    match = scriptPattern.exec(html);
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

export function collectSeoStaticCheckResult({ outDir = DEFAULT_OUT_DIR } = {}) {
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
      title: extractAttr(html, /<title>([^<]*)<\/title>/i),
      description: getMetaContents(html, "name", "description")[0] ?? "",
      canonical: getCanonical(html),
      ogTitle: getMetaContents(html, "property", "og:title")[0] ?? "",
      ogDescription: getMetaContents(html, "property", "og:description")[0] ?? "",
      ogType: getMetaContents(html, "property", "og:type")[0] ?? "",
      twitterCard: getMetaContents(html, "name", "twitter:card")[0] ?? "",
      robotsTags,
      h1Count: (html.match(/<h1\b/gi) ?? []).length,
    };
  });

  for (const record of pageRecords) {
    if (BAILOUT_PATTERN.test(record.html)) {
      errors.push(`${record.route}: CSR bailout marker found in HTML`);
    }

    if (!record.title) errors.push(`${record.route}: missing <title>`);
    if (!record.description) errors.push(`${record.route}: missing meta description`);
    const indexable = isIndexable(record.robotsTags);
    if (indexable && !record.canonical) errors.push(`${record.route}: missing canonical`);
    if (!record.ogTitle) errors.push(`${record.route}: missing og:title`);
    if (!record.ogDescription) errors.push(`${record.route}: missing og:description`);
    if (!record.twitterCard) errors.push(`${record.route}: missing twitter:card`);

    const robotsConflicts = getRobotsConflicts(record.robotsTags);
    for (const conflict of robotsConflicts) {
      errors.push(`${record.route}: conflicting robots directives (${conflict}) in ${record.robotsTags.join(" | ")}`);
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

  const routeSet = new Set(pageRecords.map((p) => p.route));
  const graph = new Map();
  const inbound = new Map();
  for (const route of routeSet) {
    graph.set(route, new Set());
    inbound.set(route, 0);
  }

  for (const record of pageRecords) {
    for (const href of getAnchorHrefs(record.html)) {
      const normalized = normalizeHref(href);
      if (normalized && routeSet.has(normalized)) {
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
