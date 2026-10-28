import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
  collectStructuredDataNodes,
  countVisibleMainTags,
  decodeHtml,
  extractJsonLdBlocks,
  extractVisibleText,
  getCanonical,
  getFaqEntries,
  getMetaContents,
  hasMeaningfulPathValue,
  nodeHasSchemaType,
  normalizeTextForSearch,
  parseAttributes,
  wordCount,
} from "../lib/seo-html-parse.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { findDuplicateSitemapLocs, parseSitemapLocs, walkOutFiles } from "../lib/seo-sitemap.mjs";

const DEFAULT_OUT_DIR = path.resolve("out");
// These families dropped their route-level loading.tsx (2026-10-25 SEO plan,
// TR3): its Suspense fallback put a skeleton in the static <main> and streamed
// the real h1, copy and JSON-LD into a hidden div after it. /flows/ also
// dropped its page-level Suspense boundary for the same reason (#1653).
const VISIBLE_MAIN_H1_ROUTE_PATTERN = /^\/(?:depeg|compare|safety-scores|screener|yield|flows|liquidity|compliance)\//;
const BAILOUT_PATTERN = /BAILOUT_TO_CLIENT_SIDE_RENDERING|next-dynamic-bailout-to-csr/;
const EMPTY_BAILOUT_TEMPLATE_PATTERN = /<template\s+data-dgst=(["'])BAILOUT_TO_CLIENT_SIDE_RENDERING\1><\/template>/g;
const PHAROS_ORIGIN = "https://pharos.watch";
const PHAROS_HOSTNAME = new URL(PHAROS_ORIGIN).hostname;
const RETIRED_INTERNAL_ROUTE_PREFIXES = [
  { prefix: "/telegram", replacement: "/pharoswatchbot/" },
  { prefix: "/screener/selector", replacement: "/screener/picker/" },
  { prefix: "/mica", replacement: "/compliance/" },
  { prefix: "/blacklist", replacement: "/freezewatch/" },
  { prefix: "/report-cards", replacement: "/safety-scores/" },
  { prefix: "/risk-lab", replacement: "/safety-scores/" },
  { prefix: "/peg-tracker", replacement: "/" },
  { prefix: "/stability-index-alt", replacement: "/stability-index/" },
  { prefix: "/tape", replacement: "/timeline/" },
  { prefix: "/stablecoins/protocol/liquity-v1", replacement: "/stablecoins/infrastructure/liquity-v1/" },
  { prefix: "/stablecoins/protocol/liquity-v2", replacement: "/stablecoins/infrastructure/liquity-v2/" },
  { prefix: "/stablecoins/protocol/liquity", replacement: "/stablecoins/infrastructure/liquity-v1/" },
  { prefix: "/about/principles", replacement: "/about/" },
  { prefix: "/about/editorial", replacement: "/about/" },
  { prefix: "/about/style", replacement: "/about/" },
  { prefix: "/sitemap-tree", replacement: "/" },
  { prefix: "/start", replacement: "/" },
  { prefix: "/about/bluechip", replacement: "/about/#bluechip" },
  { prefix: "/docs/architecture", replacement: "/docs/" },
  { prefix: "/docs/worker-and-api-limits", replacement: "/docs/" },
  { prefix: "/docs/data-flow-map", replacement: "/docs/" },
  { prefix: "/docs/design-language", replacement: "/docs/" },
  { prefix: "/docs/design-tokens", replacement: "/docs/" },
  { prefix: "/stablecoin/pusd-pleasing", replacement: "/coverage/" },
  { prefix: "/stablecoin/phpc-coins-ph", replacement: "/coverage/" },
  { prefix: "/feed/digest", replacement: "/feed/digest.xml" },
  { prefix: "/feed/depeg", replacement: "/feed/depeg.xml" },
  { prefix: "/feed/methodology", replacement: "/feed/methodology.xml" },
  { prefix: "/feed/cemetery", replacement: "/feed/cemetery.xml" },
  { prefix: "/methodology/pdf", replacement: "/methodology/" },
];
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
// Title and description hygiene (SEO plan PF10, TR2). Only templated titles
// ending in the root " | Pharos" suffix are checked for a second brand
// mention; absolute titles (e.g. "| Pharos Blog") opt out by construction.
const TITLE_BRAND_SUFFIX = " | Pharos";
const TITLE_BRAND_PATTERN = /\bPharos\b/;
// The homepage, and the Pharos Network chain whose own name is "Pharos".
const TITLE_BRAND_ALLOWED_ROUTES = new Set(["/", "/chains/pharos/"]);
const TITLE_DASH_PATTERN = /[\u2012-\u2015]/;
const TITLE_WARN_LENGTH = 60;
// Families whose titles or descriptions other SEO lanes are still rewriting:
// these report as warnings until their fix lands. Delete a prefix to enforce it.
const METADATA_RULE_WARN_ONLY_PREFIXES = {
  titleBrand: [
    "/about/", "/api/", "/changelog/", "/docs/", "/funding/", "/methodology/",
    "/privacy/", "/screener/", "/stability-index/", "/status/",
  ],
  titleDash: ["/depeg/"],
  descriptionEllipsis: ["/compare/"],
};

function isWarnOnlyMetadataRoute(rule, route) {
  return METADATA_RULE_WARN_ONLY_PREFIXES[rule].some((prefix) => route.startsWith(prefix));
}

function checkTitleAndDescriptionHygiene(record, errors, warnings, longTitles) {
  const report = (rule, message) =>
    (isWarnOnlyMetadataRoute(rule, record.route) ? warnings : errors).push(`${record.route}: ${message}`);
  const { title, description } = record;
  if (
    title.endsWith(TITLE_BRAND_SUFFIX)
    && !TITLE_BRAND_ALLOWED_ROUTES.has(record.route)
    && TITLE_BRAND_PATTERN.test(title.slice(0, -TITLE_BRAND_SUFFIX.length))
  ) {
    report("titleBrand", `<title> repeats "Pharos" before the suffix: ${title}`);
  }
  if (TITLE_DASH_PATTERN.test(title)) {
    report("titleDash", `<title> contains a figure, en or em dash (U+2012-U+2015): ${title}`);
  }
  if (description.endsWith("…")) {
    report("descriptionEllipsis", `meta description ends in "…"; compose whole sentences instead: ${description}`);
  }
  if (title.length > TITLE_WARN_LENGTH) longTitles.push(record.route);
}

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
const REQUIRED_STATIC_HEADER_RESETS = [{ route: "/llms.txt", header: "X-Robots-Tag", label: "LLM-facing index" }];
const REQUIRED_DOCUMENT_CACHE_DIRECTIVES = ["max-age=0", "must-revalidate"];
const FORBIDDEN_DOCUMENT_CACHE_DIRECTIVES = ["s-maxage", "stale-while-revalidate"];
const DATASET_DATA_CATALOG_REFERENCE_PATHS = [
  "includedInDataCatalog.@id",
  "includedInDataCatalog.name",
  "includedInDataCatalog.url",
];
const DATASET_BASE_REQUIRED_PATHS = [
  "name",
  "description",
  "url",
  "creator.@type",
  "creator.name",
  "publisher.@type",
  "publisher.name",
  "license",
  "identifier.0.value",
];

// FAQ structured data is retained as content-understanding markup that mirrors
// visible Q&A. FAQ rich results ended (2026-05-07) and HowTo rich results are
// retired, so the FAQPage rows below are a markup-to-copy consistency guard,
// not rich-result coverage. Do not add FAQ or HowTo nodes to win SERP space.
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
        requiredPaths: [...DATASET_BASE_REQUIRED_PATHS, "sameAs.0", "variableMeasured.0.name"],
      },
      { type: "BreadcrumbList", requiredPaths: ["itemListElement.0.name", "itemListElement.0.item"] },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
    requireVisibleFaq: true,
  },
  {
    label: "pre-launch stablecoin detail",
    pattern: /^\/stablecoin\/[^/]+\/$/,
    selectTypes: ["WebPage", "Thing"],
    // Active profiles also nest a WebPage (mainEntityOfPage) and a Thing
    // (Dataset.about); only pre-launch profiles lack the Dataset node.
    excludeTypes: ["Dataset"],
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
        requiredPaths: [...DATASET_BASE_REQUIRED_PATHS, "sameAs", "distribution.0.contentUrl"],
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
          ...DATASET_BASE_REQUIRED_PATHS,
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
          ...DATASET_BASE_REQUIRED_PATHS,
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
      { type: "NewsArticle", requiredPaths: ["@id", "headline", "datePublished", "dateModified", "mainEntityOfPage"] },
    ],
  },
  {
    label: "safety scores",
    route: "/safety-scores/",
    nodes: [
      {
        type: "Dataset",
        requiredPaths: [
          ...DATASET_BASE_REQUIRED_PATHS,
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
          ...DATASET_BASE_REQUIRED_PATHS,
          "sameAs",
          "variableMeasured.0.name",
          ...DATASET_DATA_CATALOG_REFERENCE_PATHS,
        ],
      },
      { type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] },
    ],
  },
  {
    label: "API page",
    route: "/api/reference/",
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

function routeFromFile(filePath, outDir) {
  const relDir = path.relative(outDir, path.dirname(filePath)).replace(/\\/g, "/");
  if (!relDir) return "/";
  return `/${relDir}/`;
}

function extractAttr(html, regex) {
  const match = html.match(regex);
  return match?.[1] ?? "";
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
  const directives = getRobotsDirectives(robotsTags);
  return !directives.has("noindex") && !directives.has("none");
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

function redirectSourceKey(source) {
  if (!source.startsWith("/")) return null;
  if (source.includes("*") || source.includes(":")) return null;

  const pathname = source.split(/[?#]/)[0];
  if (!pathname || !pathname.startsWith("/")) return null;
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "");
}

function collectRedirectEntries(outDir) {
  const redirectsPath = path.join(outDir, "_redirects");
  if (!fs.existsSync(redirectsPath)) return [];

  const rules = [];
  for (const line of fs.readFileSync(redirectsPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [source, destination, status] = trimmed.split(/\s+/);
    if (source) rules.push({ source, destination, status: status ?? "" });
  }
  return rules;
}

const DURABLE_ARCHIVE_ROUTE_PATTERN = /^\/(?:depeg|digest)\/[^/]+\/$/;

function normalizeSitemapUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== PHAROS_HOSTNAME || url.search || url.hash) return null;
    const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return `${PHAROS_ORIGIN}${pathname}`;
  } catch {
    return null;
  }
}

export function findPublishedArchiveContinuityErrors(
  previousSitemapXml,
  currentSitemapXml,
  redirectRules = [],
  currentHtmlRoutes = new Set(),
) {
  const previousUrls = new Set(parseSitemapLocs(previousSitemapXml).map(normalizeSitemapUrl).filter(Boolean));
  const currentUrls = new Set(parseSitemapLocs(currentSitemapXml).map(normalizeSitemapUrl).filter(Boolean));
  const missing = [];

  for (const previousUrl of previousUrls) {
    const pathname = new URL(previousUrl).pathname;
    if (!DURABLE_ARCHIVE_ROUTE_PATTERN.test(pathname) || currentUrls.has(previousUrl)) continue;
    // A deliberately noindexed archive page (e.g. a daily digest past its
    // index window) leaves the sitemap but still resolves; only a vanished
    // page needs a 301.
    if (currentHtmlRoutes.has(pathname)) continue;

    const sourceKey = redirectSourceKey(pathname);
    const hasCanonicalRedirect = redirectRules.some((rule) => {
      if (rule.status !== "301" || redirectSourceKey(rule.source) !== sourceKey) return false;
      const destination = normalizeSitemapUrl(new URL(rule.destination, PHAROS_ORIGIN).toString());
      return destination !== null && currentUrls.has(destination);
    });
    if (!hasCanonicalRedirect) missing.push(previousUrl);
  }

  if (missing.length === 0) return [];
  return [
    `published archive URLs missing from the current sitemap without a direct 301 to a submitted URL: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " ..." : ""}`,
  ];
}

function redirectPathTemplate(value) {
  if (!value.startsWith("/")) return null;
  const pathname = value.split(/[?#]/)[0];
  const withoutSplat = pathname.replace(/\/:splat$/, "").replace(/\/\*$/, "");
  return withoutSplat === "/" ? "/" : withoutSplat.replace(/\/+$/, "");
}

function redirectSourceMatchesPath(source, pathname) {
  const sourcePath = redirectPathTemplate(source);
  if (!sourcePath) return false;
  const wildcard = source.includes("*") || source.includes(":splat");
  if (!wildcard) return sourcePath === pathname;
  return sourcePath === "/" || pathname === sourcePath || pathname.startsWith(`${sourcePath}/`);
}

function isPublicDatasetRewrite(rule) {
  if (rule.status !== "200") return false;
  const destination = /^\/datasets\/([^/]+)\/\d{4}-\d{2}-\d{2}\.(csv|json|ndjson)$/.exec(rule.destination);
  if (!destination) return false;
  const latest = /^\/datasets\/([^/]+)\/latest\.(csv|json|ndjson)$/.exec(rule.source);
  if (latest) {
    return latest[1] === destination[1] && latest[2] === destination[2];
  }
  const sheet = /^\/sheets\/([^/]+)\.csv$/.exec(rule.source);
  return sheet != null && sheet[1] === destination[1] && destination[2] === "csv";
}

// Cloudflare Pages caps dynamic (splat/placeholder) rules at 100 and counts every
// rule after the first dynamic one as dynamic; rules past the cap are silently
// ignored in production.
const MAX_DYNAMIC_REDIRECTS = 100;

function isDynamicRedirectSource(source) {
  return source.includes("*") || source.includes(":");
}

function validateRedirectOrdering(rules, errors) {
  const firstDynamic = rules.findIndex((rule) => isDynamicRedirectSource(rule.source));
  if (firstDynamic === -1) return;
  const lateStatic = rules.slice(firstDynamic).filter((rule) => !isDynamicRedirectSource(rule.source));
  for (const rule of lateStatic) {
    errors.push(`_redirects static rule ${rule.source} follows a dynamic rule; move it above every splat/placeholder rule`);
  }
  if (rules.length - firstDynamic > MAX_DYNAMIC_REDIRECTS) {
    errors.push(`_redirects has ${rules.length - firstDynamic} dynamic-counted rules; Cloudflare Pages ignores rules past ${MAX_DYNAMIC_REDIRECTS}`);
  }
}

function validateStaticRedirects(rules, errors) {
  validateRedirectOrdering(rules, errors);
  for (const rule of rules) {
    const destinationPath = redirectPathTemplate(rule.destination);
    if (!destinationPath) continue;
    if (rule.status !== "301" && !isPublicDatasetRewrite(rule)) {
      errors.push(`_redirects internal rule must be permanent (301): ${rule.source} ${rule.destination} ${rule.status}`);
    }
    const nextRule = rules.find((candidate) => redirectSourceMatchesPath(candidate.source, destinationPath));
    if (nextRule) {
      errors.push(
        `_redirects source ${rule.source} targets another redirect source ${nextRule.source} via ${rule.destination}; collapse to one hop`,
      );
    }
  }
}

// Retired coin IDs 301 to their peg hub only while that hub is built (hubs
// exist only for currencies with an active coin); a hub that leaves the export
// must not turn the redirect into a 404.
function validateTaxonomyRedirectDestinations(rules, outDir, errors) {
  for (const rule of rules) {
    const destinationPath = redirectPathTemplate(rule.destination);
    if (!destinationPath?.startsWith("/stablecoins/")) continue;
    if (!fs.existsSync(path.join(outDir, destinationPath, "index.html"))) {
      errors.push(`_redirects source ${rule.source} targets ${rule.destination}, which the build does not export; redirect it to /coverage/`);
    }
  }
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

  const catchAll = blockByRoute.get("/*");
  const cacheValues = catchAll?.headers.get("cache-control") ?? [];
  const cacheDirectives = cacheValues
    .flatMap((value) => value.split(","))
    .map((directive) => directive.trim().toLowerCase())
    .filter(Boolean);
  if (cacheValues.length === 0) {
    errors.push("static headers missing Cache-Control on catch-all document rule /*");
  }
  for (const required of REQUIRED_DOCUMENT_CACHE_DIRECTIVES) {
    if (!cacheDirectives.includes(required)) {
      errors.push(`static headers catch-all document rule /* missing Cache-Control directive ${required}`);
    }
  }
  for (const forbidden of FORBIDDEN_DOCUMENT_CACHE_DIRECTIVES) {
    if (cacheDirectives.some((directive) => directive === forbidden || directive.startsWith(`${forbidden}=`))) {
      errors.push(`static headers catch-all document rule /* must not use Cache-Control directive ${forbidden}`);
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

/**
 * Every internal `_redirects` redirect (not a 200 rewrite) marks a retired
 * route, so internal anchors are checked against the file itself rather than
 * only the hand-kept prefix list: a link to a source costs a redirect hop.
 * Static sources match exactly (trailing slash normalized); `/*` splats match
 * their prefix. Placeholder sources are not matched.
 */
function buildRedirectedRouteMatchers(redirectRules) {
  return redirectRules
    .filter((rule) => rule.source.startsWith("/") && rule.status !== "200" && !rule.source.includes(":"))
    .map((rule) => {
      const splat = rule.source.endsWith("/*");
      const path = splat ? rule.source.slice(0, -1) : rule.source;
      return { source: rule.source, destination: rule.destination, splat, base: path.endsWith("/") ? path : `${path}/` };
    });
}

function redirectedInternalRouteMatch(normalizedHref, matchers) {
  return matchers.find((matcher) => (matcher.splat ? normalizedHref.startsWith(matcher.base) : normalizedHref === matcher.base)) ?? null;
}

function isRetiredInternalRoute(route) {
  return retiredInternalRouteMatch(route) !== null;
}

function hasFatalCsrBailoutMarker(html) {
  return BAILOUT_PATTERN.test(html.replace(EMPTY_BAILOUT_TEMPLATE_PATTERN, ""));
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

function pageHasSchemaType(record, type) {
  return record.structuredDataNodes.some((node) => nodeHasSchemaType(node, type));
}

function analyzeStaticRichness(record) {
  return record.richness ?? { words: 0, loadingWords: 0, loadingWordRatio: 0 };
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

  return candidates.find((record) =>
    expectation.selectTypes.every((type) => pageHasSchemaType(record, type))
    && !(expectation.excludeTypes ?? []).some((type) => pageHasSchemaType(record, type))) ?? null;
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
      const visibleText = record.normalizedVisibleText ?? "";
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

export function buildSeoPageRecord(
  filePath,
  outDir,
  structuredDataRouteMatrix = STRUCTURED_DATA_ROUTE_MATRIX,
) {
  const html = fs.readFileSync(filePath, "utf8");
  const robotsTags = [
    ...getMetaContents(html, "name", "robots"),
    ...getMetaContents(html, "name", "googlebot"),
  ];
  const route = routeFromFile(filePath, outDir);
  const retired = isRetiredInternalRoute(route);
  const indexable = !retired && isIndexable(robotsTags);
  const structuredData = [];
  const structuredDataNodes = [];
  const structuredDataErrors = [];
  const structuredDataSiteDataUrlGroups = [];

  extractJsonLdBlocks(html).forEach((block, index) => {
    let parsed;
    try {
      parsed = JSON.parse(block.trim());
    } catch (error) {
      structuredDataErrors.push(`invalid JSON-LD block #${index + 1}: ${error.message}`);
      return;
    }
    structuredData.push(parsed);
    structuredDataNodes.push(...collectStructuredDataNodes(parsed));
    if (indexable) {
      structuredDataSiteDataUrlGroups.push(findStructuredDataSiteDataUrls(parsed));
    }
  });

  const richnessCheck = RICHNESS_CHECKS.find((check) => check.pattern.test(route));
  const visibleFaqRequired = structuredDataRouteMatrix.some(
    (expectation) =>
      expectation.requireVisibleFaq
      && (expectation.route === route || expectation.pattern?.test(route)),
  );
  const visibleText = richnessCheck || visibleFaqRequired ? extractVisibleText(html) : "";
  const words = richnessCheck ? wordCount(visibleText) : 0;
  const loadingWords = richnessCheck ? (visibleText.match(LOADING_SHELL_PATTERN)?.length ?? 0) : 0;

  return {
    filePath,
    route,
    title: decodeHtml(extractAttr(html, /<title>([^<]*)<\/title>/i)),
    description: getMetaContents(html, "name", "description")[0] ?? "",
    canonical: getCanonical(html),
    ogTitle: getMetaContents(html, "property", "og:title")[0] ?? "",
    ogDescription: getMetaContents(html, "property", "og:description")[0] ?? "",
    ogType: getMetaContents(html, "property", "og:type")[0] ?? "",
    ogSiteName: getMetaContents(html, "property", "og:site_name")[0] ?? "",
    ogImage: getMetaContents(html, "property", "og:image")[0] ?? "",
    twitterCard: getMetaContents(html, "name", "twitter:card")[0] ?? "",
    twitterImage: getMetaContents(html, "name", "twitter:image")[0] ?? "",
    robotsTags,
    retired,
    indexable,
    googleBotTags: getMetaContents(html, "name", "googlebot"),
    h1Count: (html.match(/<h1\b/gi) ?? []).length,
    visibleMainH1Count: VISIBLE_MAIN_H1_ROUTE_PATTERN.test(route) ? countVisibleMainTags(html, "h1") : null,
    hasFatalCsrBailout: hasFatalCsrBailoutMarker(html),
    hrefs: getAnchorHrefs(html),
    structuredData,
    structuredDataNodes,
    structuredDataErrors,
    structuredDataSiteDataUrlGroups,
    normalizedVisibleText: visibleFaqRequired ? normalizeTextForSearch(visibleText) : "",
    richness: richnessCheck
      ? {
          words,
          loadingWords,
          loadingWordRatio: words > 0 ? loadingWords / words : 0,
        }
      : null,
  };
}

const STABLECOIN_PROFILE_ROUTE_PATTERN = /^\/stablecoin\/[^/]+\/$/;
// An unresolved AI-summary claim rendered as "N/A" ("USDT carries a N/A overall grade").
const UNRESOLVED_GRADE_CLAIM_PATTERN = /\bN\/A (?:overall grade|report card)\b/;
const LOADING_DOSSIER_TEXT = "Loading research dossier";
// The server-rendered static profile (StablecoinDetailSeoContent), outside the dossier's Suspense boundary.
const STATIC_PROFILE_MARKER = 'id="stablecoin-static-profile-title"';
// C1 pilot: profiles whose retained-ledger History preview must be in the export.
const HISTORY_PREVIEW_PILOT_IDS = new Set([
  "usdt-tether",
  "usdc-circle",
  "tusd-trueusd",
  "dai-makerdao",
  "fdusd-first-digital",
]);
const HISTORY_PREVIEW_CAPTION_PATTERN = /Latest [\d,]+ of [\d,]+ archived incidents · as of \d{4}-\d{2}-\d{2} UTC\. Recorded history; coverage may be incomplete\./;
const STABLECOIN_CATALOG_PATH = path.resolve("shared/data/stablecoins/coins.generated.json");
let navTokenProfileIdsCache;

/** NAV profiles never get a Depeg preview; the catalog is the authority. */
function getNavTokenProfileIds() {
  if (navTokenProfileIdsCache) return navTokenProfileIdsCache;
  navTokenProfileIdsCache = new Set();
  try {
    const catalog = JSON.parse(fs.readFileSync(STABLECOIN_CATALOG_PATH, "utf8"));
    for (const coin of Array.isArray(catalog) ? catalog : []) {
      if (coin?.flags?.navToken === true) navTokenProfileIdsCache.add(coin.id);
    }
  } catch {
    // A missing catalog only skips the NAV assertion; profile checks still run.
  }
  return navTokenProfileIdsCache;
}

/** Only real exported markup: RSC flight data and JSON-LD live in `<script>`. */
function stripEmbeddedScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/** Text of the exported markup including hidden panels, ignoring tags and hydration comments. */
function extractMarkupText(html) {
  return decodeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

const VOID_ELEMENT_NAMES = new Set([
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
// eslint-disable-next-line security/detect-unsafe-regex -- one linear tag token over bounded exported HTML; quoted attribute values may contain `>`
const ELEMENT_TOKEN_PATTERN = /<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * Exported markup with non-element content removed: `<head>`, hydration
 * comments, and `<script>`/`<style>`/`<template>` bodies. RSC flight payloads
 * and JSON-LD live inside `<script>`, so text there is never HTML evidence.
 */
function stripNonElementMarkup(html) {
  return html
    .replace(/<head\b[\s\S]*?<\/head>/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ");
}

/** Real markup tags in source order, with parsed attributes on opening tags. */
function collectElementTags(html) {
  const tags = [];
  for (const match of html.matchAll(ELEMENT_TOKEN_PATTERN)) {
    const [raw, closingMark, rawName] = match;
    tags.push({
      name: rawName.toLowerCase(),
      closing: closingMark === "/",
      selfClosing: /\/\s*>$/.test(raw),
      start: match.index,
      end: match.index + raw.length,
      attrs: closingMark === "/" ? new Map() : parseAttributes(raw),
    });
  }
  return tags;
}

function openingElementTags(tags, predicate) {
  const matches = [];
  tags.forEach((tag, index) => {
    if (!tag.closing && predicate(tag)) matches.push({ tag, index });
  });
  return matches;
}

/** Outer HTML of the element opened at `index`, bounded by its matching close tag. */
function elementOuterHtml(html, tags, index) {
  const open = tags[index];
  if (open.selfClosing || VOID_ELEMENT_NAMES.has(open.name)) return html.slice(open.start, open.end);
  let depth = 0;
  for (let cursor = index; cursor < tags.length; cursor += 1) {
    const tag = tags[cursor];
    if (tag.name !== open.name) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return html.slice(open.start, tag.end);
    } else if (!tag.selfClosing && !VOID_ELEMENT_NAMES.has(tag.name)) {
      depth += 1;
    }
  }
  return html.slice(open.start);
}

function formatIdList(values, max = 6) {
  return `${values.slice(0, max).join(", ")}${values.length > max ? ` (+${values.length - max} more)` : ""}`;
}

function countHistoryPreviewRows(html) {
  const host = html.indexOf('data-testid="depeg-history-preview"');
  if (host < 0) return null;
  const tableStart = html.indexOf("<table", host);
  const tableEnd = tableStart < 0 ? -1 : html.indexOf("</table>", tableStart);
  if (tableStart < 0 || tableEnd < 0) return null;
  const table = html.slice(tableStart, tableEnd);
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(table);
  return body ? (body[1].match(/<tr\b/gi) ?? []).length : 0;
}

/**
 * C1 semantic sentinels. The payload must be real table text, not a matching
 * sentence inside an RSC string, and the inactive Depeg panel must carry the
 * same facts as the rest of the HTML. Profiles outside the pilot are untouched.
 */
function validateStablecoinProfileHistoryPreview(route, html, errors) {
  const profileId = route.slice("/stablecoin/".length, -1);
  const stripped = stripEmbeddedScripts(html);
  const hasHistoryShell = /data-history-tab=["']/.test(stripped);
  if (!hasHistoryShell) return;
  const previewCount = (stripped.match(/data-testid="depeg-history-preview"/g) ?? []).length;
  const anchorCount = (stripped.match(/id=["']depeg-history["']/g) ?? []).length;
  const isPilot = HISTORY_PREVIEW_PILOT_IDS.has(profileId);
  const isNav = getNavTokenProfileIds().has(profileId);

  if (isNav) {
    if (previewCount > 0) errors.push(`${route}: NAV profile renders a depeg history preview`);
    if (anchorCount > 0) errors.push(`${route}: NAV profile renders a #depeg-history panel`);
    return;
  }
  if (!isPilot) return;
  if (anchorCount !== 1) {
    errors.push(`${route}: History preview must own exactly one #depeg-history (found ${anchorCount})`);
  }
  if (previewCount !== 1) {
    errors.push(`${route}: History preview must render exactly once (found ${previewCount})`);
    return;
  }
  if (!HISTORY_PREVIEW_CAPTION_PATTERN.test(extractMarkupText(stripped))) {
    errors.push(`${route}: History preview is missing its capture date or coverage caption`);
  }
  const rows = countHistoryPreviewRows(stripped);
  if (rows == null) {
    errors.push(`${route}: History preview table is not parseable`);
  } else if (rows === 0) {
    errors.push(`${route}: History preview renders no incident rows`);
  } else if (rows > 6) {
    errors.push(`${route}: History preview renders ${rows} incident rows (maximum 6)`);
  }
}

/**
 * Profiles are indexed in their prerendered state, hidden streamed segments
 * included: no unresolved grade claim, and a loading dossier never stands
 * alone without the static profile. The one-h1 rule covers profiles above.
 */
function validateStablecoinProfileRender(pageRecords, errors) {
  for (const record of pageRecords) {
    if (!STABLECOIN_PROFILE_ROUTE_PATTERN.test(record.route) || !record.filePath || !fs.existsSync(record.filePath)) continue;
    const html = fs.readFileSync(record.filePath, "utf8");
    const unresolved = html.match(UNRESOLVED_GRADE_CLAIM_PATTERN);
    if (unresolved) errors.push(`${record.route}: profile HTML renders an unresolved claim ("${unresolved[0]}")`);
    if (html.includes(LOADING_DOSSIER_TEXT) && !html.includes(STATIC_PROFILE_MARKER)) {
      errors.push(`${record.route}: profile HTML is a "${LOADING_DOSSIER_TEXT}" shell without the static profile`);
    }
    validateStablecoinProfileHistoryPreview(record.route, html, errors);
  }
}

// C3/C6 exported-artifact sentinels. The full expected deployment sets stay in
// the registry-iterating Vitest suites; this guard proves the built HTML keeps
// their text and destinations wired, without a second hand-authored inventory.
const CONTRACT_FOLD_PROFILE_ROUTES = ["/stablecoin/usdt-tether/", "/stablecoin/usdc-circle/"];
const CHAIN_CONTRACT_TABLE_PILOTS = [
  { chain: "solana", chainName: "Solana" },
  { chain: "base", chainName: "Base" },
  { chain: "tron", chainName: "Tron" },
];
const CHAIN_CONTRACT_TABLE_ROW_LIMIT = 20;
const COIN_DATA_DIR = path.resolve("shared/data/stablecoins/coins");
/** C6 hub rows deep-link to the profile's Contracts module, never a per-row id. */
const CONTRACT_MODULE_ANCHOR_ID = "contracts";

const ATTRIBUTE_VALUE_PATTERNS = {
  id: /\bid="([^"]*)"/g,
  href: /\bhref="([^"]*)"/g,
};

function attributeValues(html, attribute) {
  const pattern = ATTRIBUTE_VALUE_PATTERNS[attribute];
  return [...html.matchAll(pattern)].map((match) => decodeHtml(match[1]));
}

function readCheckedInCoin(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(COIN_DATA_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Element text for the whole document. `extractVisibleText` is `<main>`-scoped
 * and skips `hidden` subtrees, but a prerendered profile's streamed dossier
 * (which owns the Contracts card) is emitted after `</main>` inside a `hidden`
 * segment that hydration reveals. Reading that raw element text with scripts
 * and templates removed is the artifact check C3/C6 ask for; inline RSC JSON can
 * never match because it lives in `<script>`.
 */
function extractDocumentText(html) {
  return decodeHtml(stripNonElementMarkup(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Outer HTML of the in-flow `Contract addresses` fold, or null when absent. */
function findContractAddressFold(html) {
  const stripped = stripNonElementMarkup(html);
  const tags = collectElementTags(stripped);
  const folds = openingElementTags(tags, (tag) => tag.name === "details" && tag.attrs.has("data-module-fold"));
  for (const { index } of folds) {
    const outer = elementOuterHtml(stripped, tags, index);
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(outer);
    if (summary && extractMarkupText(summary[1]).startsWith("Contract addresses")) return outer;
  }
  return null;
}

/**
 * C3: every profile keeps the complete recorded deployment set in the closed
 * `Contract addresses` fold as exact, plain address text.
 * C6: the three pilot hubs keep their bounded table, report a truthful
 * `shown/total`, and every row links to the target profile's `#contracts`
 * module, which must exist exactly once. The complete profile directory stays
 * as the overflow path.
 */
function validateContractDeploymentSurfaces(pageRecords, errors, warnings) {
  const htmlByRoute = new Map(
    pageRecords
      .filter((record) => record.filePath && fs.existsSync(record.filePath))
      .map((record) => [record.route, fs.readFileSync(record.filePath, "utf8")]),
  );

  for (const route of CONTRACT_FOLD_PROFILE_ROUTES) {
    const html = htmlByRoute.get(route);
    if (!html) continue;
    const coinId = route.split("/")[2];
    const coin = readCheckedInCoin(coinId);
    const contracts = coin?.contracts ?? [];
    if (contracts.length === 0) {
      warnings.push(`${route}: no checked-in contract deployment for the contract-fold sentinel`);
      continue;
    }

    const foldHtml = findContractAddressFold(html);
    if (!foldHtml) {
      errors.push(`${route}: contract address fold summary missing`);
      continue;
    }
    const foldText = extractDocumentText(foldHtml);
    const missingAddresses = contracts
      .map((contract) => contract.address)
      .filter((address) => !foldText.includes(address));
    if (missingAddresses.length > 0) {
      errors.push(
        `${route}: contract address fold omits ${missingAddresses.length} of ${contracts.length} recorded addresses (${formatIdList(missingAddresses)})`,
      );
    }
    const previewChain = contracts[0]?.chain;
    if (
      previewChain
      && !html.includes(`href="/chains/${previewChain}"`)
      && !html.includes(`href="/chains/${previewChain}/"`)
    ) {
      errors.push(`${route}: preview chain destination /chains/${previewChain} lost`);
    }
  }

  for (const { chain, chainName } of CHAIN_CONTRACT_TABLE_PILOTS) {
    const route = `/chains/${chain}/`;
    const html = htmlByRoute.get(route);
    if (!html) continue;
    const heading = `Recorded contract addresses on ${chainName}`;
    const visibleText = extractDocumentText(html);
    if (!visibleText.includes(heading)) {
      errors.push(`${route}: "${heading}" missing`);
      continue;
    }

    const sectionStart = html.indexOf('id="chain-contract-addresses"');
    if (sectionStart < 0) {
      errors.push(`${route}: #chain-contract-addresses section missing`);
      continue;
    }
    const sectionEnd = html.indexOf("</section>", sectionStart);
    const sectionHtml = html.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
    const columnHeaders = sectionHtml.match(/scope="col"/g)?.length ?? 0;
    if (columnHeaders !== 4) {
      errors.push(`${route}: contract table has ${columnHeaders} column headers, expected 4`);
    }

    const caption = visibleText.match(/Showing (\d+) of (\d+) recorded deployments/);
    if (!caption) {
      errors.push(`${route}: contract table caption missing`);
    } else {
      const shown = Number(caption[1]);
      const total = Number(caption[2]);
      if (shown > CHAIN_CONTRACT_TABLE_ROW_LIMIT || total < shown) {
        errors.push(`${route}: contract table reports ${shown} of ${total} recorded deployments`);
      } else if (shown !== Math.min(total, CHAIN_CONTRACT_TABLE_ROW_LIMIT)) {
        errors.push(`${route}: contract table preview bound is not applied (${shown} of ${total})`);
      }
    }

    const destinations = [...sectionHtml.matchAll(/href="(\/stablecoin\/[^"#]+)#([^"]*)"/g)];
    if (destinations.length === 0) {
      errors.push(`${route}: no contract table destinations to recorded profile modules`);
    }
    if (caption && destinations.length !== Number(caption[1])) {
      errors.push(`${route}: contract table shows ${caption[1]} rows but links ${destinations.length} destinations`);
    }

    for (const [, href, fragment] of destinations) {
      if (fragment !== CONTRACT_MODULE_ANCHOR_ID) {
        errors.push(`${route}: contract table destination ${href}#${fragment} does not target #${CONTRACT_MODULE_ANCHOR_ID}`);
        continue;
      }
      const targetRoute = `${href.replace(/\/+$/, "")}/`;
      const targetHtml = htmlByRoute.get(targetRoute);
      if (!targetHtml) {
        errors.push(`${route}: contract table destination ${targetRoute} is not part of the export`);
        continue;
      }
      const matches = attributeValues(targetHtml, "id").filter((value) => value === CONTRACT_MODULE_ANCHOR_ID).length;
      if (matches !== 1) {
        errors.push(`${route}: contract table destination ${targetRoute}#${CONTRACT_MODULE_ANCHOR_ID} resolves to ${matches} ids`);
      }
    }

    if (html.indexOf('aria-labelledby="chain-deployment-anchors-heading"') < 0) {
      errors.push(`${route}: complete profile directory missing, so contract table overflow has no destination`);
    }
  }
}

// B1: the dated Safety Scores preview must be real exported markup. Facts are
// projected from the same committed dataset the page reads, so the check never
// keeps a second hand-authored inventory and never infers publication counts
// from the rendered 20-row slice.
const SAFETY_SCORES_ROUTE = "/safety-scores/";
const SAFETY_RESULTS_REGION_LABEL = "Safety score cards";
const SAFETY_RESULTS_REGION_ID = "data";
const SAFETY_PREVIEW_MAX_ROWS = 20;
const SAFETY_GRADE_VALUES = new Set(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);
const SAFETY_PROFILE_HREF_PATTERN = /^\/stablecoin\/[^/]+\/$/;
const PUBLIC_DATASETS_DIR = path.resolve("public/datasets");
const PUBLIC_DATASET_CURRENT_MODULE_PATH = path.resolve("src/lib/datasets/public-dataset-current.ts");
const SAFETY_GRADE_POLICY_PATH = path.resolve("shared/data/safety-score-v9/methodology-policy-candidate-v1.json");
const COMPLIANCE_DATA_DIR = path.resolve("shared/data/stablecoins/domains/compliance");
let safetyScoresPreviewExpectationCache;
let compliancePanelExpectationCache;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Active registry membership from the checked-in per-coin sources, or null. */
function readActiveStablecoinIds(coinDataDir = COIN_DATA_DIR) {
  let fileNames;
  try {
    fileNames = fs.readdirSync(coinDataDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  const ids = new Set();
  for (const fileName of fileNames) {
    const coin = readJsonFile(path.join(coinDataDir, fileName));
    if (!coin || typeof coin.id !== "string") continue;
    if (coin.status == null || coin.status === "active") ids.add(coin.id);
  }
  return ids.size > 0 ? ids : null;
}

function buildStablecoinHref(id) {
  return `/stablecoin/${encodeURIComponent(id)}/`;
}

/** The generated current-dataset module names which dated export the page reads. */
function readCurrentPublicDatasetDate(currentModulePath) {
  let source;
  try {
    source = fs.readFileSync(currentModulePath, "utf8");
  } catch {
    return null;
  }
  return /PUBLIC_DATASET_CURRENT_DATE\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(source)?.[1] ?? null;
}

function gradeForScore(score, thresholds) {
  const clamped = Math.max(0, Math.min(100, score));
  return thresholds.find((entry) => clamped >= entry.minScore)?.grade ?? "F";
}

/**
 * Projects the expected preview the same way the page does: rated rows that are
 * current active registry members with recorded, threshold-consistent grades,
 * sorted by score then code-unit id and cut at the row bound. Mirrors
 * `buildSafetyScoresPreview` in `src/lib/safety-grade-snapshot.ts`; any
 * divergence surfaces as missing/unexpected profile links in the artifact.
 *
 * @returns {{ status: "ok", preview: { snapshotDate: string, publishedAtSec: number, publishedAtIso: string, publishedDate: string, eligibleRatedCount: number, rows: { id: string, href: string, grade: string, score: number }[] } } | { status: "unavailable", reason: string }}
 */
export function buildSafetyScoresPreviewExpectation({
  currentModulePath = PUBLIC_DATASET_CURRENT_MODULE_PATH,
  datasetsDir = PUBLIC_DATASETS_DIR,
  coinDataDir = COIN_DATA_DIR,
  gradePolicyPath = SAFETY_GRADE_POLICY_PATH,
} = {}) {
  const unavailable = (reason) => ({ status: "unavailable", reason });
  const datasetDate = readCurrentPublicDatasetDate(currentModulePath);
  if (!datasetDate) return unavailable("current-dataset-date-unreadable");
  const dataset = readJsonFile(path.join(datasetsDir, "scores-latest", `${datasetDate}.json`));
  if (!dataset) return unavailable(`scores-latest-dataset-missing:${datasetDate}`);
  const display = dataset._meta?.displayProjection;
  if (display?.version !== 1) return unavailable("display-projection-missing");
  if (display.snapshotDate !== datasetDate) return unavailable("display-projection-date-mismatch");
  const safety = display.safety;
  if (!safety) return unavailable(display.safetyUnavailableReason ?? "safety-projection-missing");
  const publishedAtSec = safety.publishedAtSec;
  if (!Number.isInteger(publishedAtSec) || publishedAtSec <= 0) return unavailable("publication-clock-invalid");
  const thresholds = readJsonFile(gradePolicyPath)?.semantic?.formula?.gradeThresholds;
  if (!Array.isArray(thresholds) || thresholds.length === 0) return unavailable("grade-policy-unreadable");
  const activeIds = readActiveStablecoinIds(coinDataDir);
  if (!activeIds) return unavailable("active-registry-unavailable");

  // Global admissions the page performs before it projects any row: a second
  // row per asset, an inconsistent not-rated/pipeline-gap row, a completeness
  // mismatch or an incompatible methodology all withhold the preview.
  const ratedStatusCounts = { rated: 0, "not-rated": 0, "pipeline-gap": 0 };
  const seenIds = new Set();
  for (const row of Array.isArray(dataset.rows) ? dataset.rows : []) {
    if (!row || typeof row.stablecoinId !== "string" || row.stablecoinId.length === 0) continue;
    if (seenIds.has(row.stablecoinId)) return unavailable(`duplicate-dataset-row:${row.stablecoinId}`);
    seenIds.add(row.stablecoinId);
    if (row.ratingStatus === "not-rated") {
      if (row.safetyScore !== null || row.safetyGrade !== "NR") return unavailable(`invalid-not-rated-row:${row.stablecoinId}`);
      ratedStatusCounts["not-rated"] += 1;
    } else if (row.ratingStatus === "pipeline-gap") {
      if (row.safetyScore !== null || row.safetyGrade !== null) return unavailable(`invalid-pipeline-gap-row:${row.stablecoinId}`);
      ratedStatusCounts["pipeline-gap"] += 1;
    } else if (row.ratingStatus === "rated") {
      ratedStatusCounts.rated += 1;
    }
  }
  const completeness = safety.completeness;
  if (
    ratedStatusCounts.rated !== completeness?.ratedCount
    || ratedStatusCounts["not-rated"] !== completeness?.notRatedCount
    || ratedStatusCounts["pipeline-gap"] !== completeness?.pipelineGapCount
  ) {
    return unavailable("completeness-mismatch");
  }
  const methodologyLabel = dataset._meta?.methodologyLabel;
  const methodologyVersion = String(safety.identity?.methodologyVersion ?? "").replace(/^v/, "");
  if (
    typeof methodologyLabel !== "string"
    || !methodologyVersion
    || !methodologyLabel.includes(`safety-score v${methodologyVersion}`)
  ) {
    return unavailable("methodology-identity-mismatch");
  }

  const rows = [];
  for (const row of Array.isArray(dataset.rows) ? dataset.rows : []) {
    if (!row || typeof row.stablecoinId !== "string" || row.ratingStatus !== "rated") continue;
    const { safetyScore: score, safetyGrade: grade } = row;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) continue;
    if (typeof grade !== "string" || !SAFETY_GRADE_VALUES.has(grade)) continue;
    if (!activeIds.has(row.stablecoinId)) continue;
    // A held letter is published as recorded; the page omits any row whose
    // recorded facts contradict the score or its own hold.
    const gradeHold = row.safetyDisplay?.gradeHold ?? null;
    const rawGrade = gradeForScore(score, thresholds);
    if (gradeHold) {
      if (gradeHold.rawGrade !== rawGrade || grade === rawGrade) continue;
    } else if (grade !== rawGrade) {
      continue;
    }
    rows.push({ id: row.stablecoinId, href: buildStablecoinHref(row.stablecoinId), grade, score });
  }
  if (rows.length === 0) return unavailable("no-eligible-rated-rows");
  rows.sort((left, right) => right.score - left.score
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return {
    status: "ok",
    preview: {
      snapshotDate: datasetDate,
      publishedAtSec,
      publishedAtIso: new Date(publishedAtSec * 1000).toISOString(),
      // The caption names the publication clock, which can be a later UTC day
      // than the dataset's calendar date.
      publishedDate: new Date(publishedAtSec * 1000).toISOString().slice(0, 10),
      eligibleRatedCount: rows.length,
      rows: rows.slice(0, SAFETY_PREVIEW_MAX_ROWS),
    },
  };
}

/**
 * B1 semantic sentinels for `/safety-scores/`: exactly one results region in the
 * whole exported document (the hidden streamed segment included), a `<time>`
 * grade date, the projected canonical profile links with their exact grades and
 * scores, and a caption denominator taken from the full admitted set rather
 * than from the rendered slice.
 */
function validateSafetyScoresPreview(pageRecords, errors, warnings, expectation) {
  const record = pageRecords.find((entry) =>
    entry.route === SAFETY_SCORES_ROUTE && entry.filePath && fs.existsSync(entry.filePath));
  if (!record) return;
  const route = record.route;
  const html = stripNonElementMarkup(fs.readFileSync(record.filePath, "utf8"));
  const tags = collectElementTags(html);

  // The client's pending render lands in the streamed segment Next swaps in on
  // parse. Count every region, hidden or not: a duplicated preview (route
  // fallback plus client render) is two result sets for the same facts.
  const regions = openingElementTags(tags, (tag) => tag.attrs.get("aria-label") === SAFETY_RESULTS_REGION_LABEL);
  if (expectation?.status !== "ok") {
    // Without an admissible dated projection the page keeps the neutral
    // skeleton (B0 fails closed). A held publication or a replayed pre-B0
    // dataset is not a release failure; a preview the build cannot prove is.
    const reason = expectation?.reason ?? "not-provided";
    if (regions.length > 0) {
      errors.push(`${route}: Safety Scores preview rendered without an admissible dated projection (${reason})`);
    } else {
      warnings.push(`${route}: Safety Scores dated preview unavailable (${reason}); the page serves the neutral skeleton`);
    }
    return;
  }
  if (regions.length !== 1) {
    errors.push(
      `${route}: expected exactly one Safety Scores results region (aria-label "${SAFETY_RESULTS_REGION_LABEL}"), found ${regions.length}`,
    );
    return;
  }
  if (regions[0].tag.attrs.get("id") !== SAFETY_RESULTS_REGION_ID) {
    errors.push(`${route}: Safety Scores results region lost its #${SAFETY_RESULTS_REGION_ID} anchor`);
  }
  const dataAnchors = openingElementTags(tags, (tag) => tag.attrs.get("id") === SAFETY_RESULTS_REGION_ID);
  if (dataAnchors.length !== 1) {
    errors.push(`${route}: expected exactly one #${SAFETY_RESULTS_REGION_ID} region, found ${dataAnchors.length}`);
  }
  const preview = expectation.preview;
  const regionHtml = elementOuterHtml(html, tags, regions[0].index);
  const regionTags = collectElementTags(regionHtml);
  const regionText = extractMarkupText(regionHtml);

  const timeTags = openingElementTags(regionTags, (tag) => tag.name === "time");
  if (timeTags.length !== 1) {
    errors.push(`${route}: preview results region must carry exactly one <time> grade date (found ${timeTags.length})`);
  } else {
    const datetime = timeTags[0].tag.attrs.get("datetime") ?? "";
    if (datetime !== preview.publishedAtIso) {
      errors.push(
        `${route}: preview <time> datetime ${JSON.stringify(datetime)} is not the publication clock ${preview.publishedAtIso}`,
      );
    }
    const timeText = extractMarkupText(elementOuterHtml(regionHtml, regionTags, timeTags[0].index));
    if (!timeText.includes(`Grades as of ${preview.publishedDate}`)) {
      errors.push(`${route}: preview <time> does not carry "Grades as of ${preview.publishedDate}"`);
    }
  }

  const captionMatches = regionText.match(/Top (\d+) of (\d+) rated active stablecoins by Safety Score/g) ?? [];
  if (captionMatches.length !== 1) {
    errors.push(`${route}: preview caption is missing or repeated (found ${captionMatches.length})`);
  } else {
    const [shown, eligible] = (captionMatches[0].match(/\d+/g) ?? []).map(Number);
    if (shown !== preview.rows.length || eligible !== preview.eligibleRatedCount) {
      errors.push(
        `${route}: preview caption reports Top ${shown} of ${eligible}, but the projected dataset admits Top ${preview.rows.length} of ${preview.eligibleRatedCount} rated active stablecoins (source counts are never inferred from the slice)`,
      );
    }
  }

  const anchors = openingElementTags(regionTags, (tag) =>
    tag.name === "a" && SAFETY_PROFILE_HREF_PATTERN.test(tag.attrs.get("href") ?? ""))
    .map(({ tag, index }) => ({ href: tag.attrs.get("href"), html: elementOuterHtml(regionHtml, regionTags, index) }));
  const hrefs = anchors.map((anchor) => anchor.href);
  const duplicated = [...new Set(hrefs.filter((href, index) => hrefs.indexOf(href) !== index))];
  if (duplicated.length > 0) {
    errors.push(`${route}: preview renders duplicate profile cards: ${formatIdList(duplicated)}`);
  }
  const expectedHrefs = preview.rows.map((row) => row.href);
  const missing = expectedHrefs.filter((href) => !hrefs.includes(href));
  if (missing.length > 0) {
    errors.push(`${route}: preview omits projected profile links: ${formatIdList(missing)}`);
  }
  const unexpected = hrefs.filter((href) => !expectedHrefs.includes(href));
  if (unexpected.length > 0) {
    errors.push(`${route}: preview renders profile links outside the projected top rows: ${formatIdList(unexpected)}`);
  }

  for (const row of preview.rows) {
    const anchor = anchors.find((candidate) => candidate.href === row.href);
    if (!anchor) continue;
    const gradeLabels = [...anchor.html.matchAll(/aria-label="Safety grade ([^"]*)"/g)].map((match) => match[1]);
    if (gradeLabels.length !== 1 || gradeLabels[0] !== row.grade) {
      errors.push(
        `${route}: preview card ${row.href} carries ${gradeLabels.length === 0 ? "no" : `"${gradeLabels.join('", "')}"`} grade label, expected the projected "${row.grade}"`,
      );
    }
    // React separates adjacent text nodes with `<!-- -->`, which text
    // extraction turns into a space, so the score may read "87 /100".
    if (!extractMarkupText(anchor.html).replace(/\s*\/\s*/g, "/").includes(`${row.score}/100`)) {
      errors.push(`${route}: preview card ${row.href} does not carry the projected ${row.score}/100 score`);
    }
  }
}

// B2: all three compliance regime panels mount once, only the selected panel is
// exposed, and each regime's rows sit inside their own panel. Representative
// rows come from the checked-in compliance sources, not an inventory.
const COMPLIANCE_ROUTE = "/compliance/";
const COMPLIANCE_REGIME_PANELS = [
  { regime: "all", id: "compliance-overview-panel", hidden: false },
  { regime: "mica", id: "compliance-mica-panel", hidden: true },
  { regime: "genius", id: "compliance-genius-panel", hidden: true },
];
const COMPLIANCE_REGIME_HEADINGS = [
  { regime: "mica", id: "mica", text: "MiCA authorization" },
  { regime: "genius", id: "genius", text: "GENIUS Act status" },
];
const COMPLIANCE_EXPANDED_MICA_STATUSES = new Set(["authorized", "pending", "transitional", "non-compliant"]);
const COMPLIANCE_COLLAPSED_GENIUS_STATUSES = new Set(["no-public-authorization-found", "not-applicable", "unknown"]);

/**
 * One MiCA row absent from the GENIUS panel and one GENIUS row absent from the
 * MiCA panel, derived from the checked-in compliance sources and active
 * registry so the cross-panel assertion never hard-codes coin ids.
 *
 * @returns {{ status: "ok", mica: { id: string, href: string } | null, genius: { id: string, href: string, reviewedAt: string | null } | null } | { status: "unavailable", reason: string }}
 */
export function buildCompliancePanelExpectation({
  complianceDir = COMPLIANCE_DATA_DIR,
  coinDataDir = COIN_DATA_DIR,
} = {}) {
  const unavailable = (reason) => ({ status: "unavailable", reason });
  const activeIds = readActiveStablecoinIds(coinDataDir);
  if (!activeIds) return unavailable("active-registry-unavailable");
  let fileNames;
  try {
    fileNames = fs.readdirSync(complianceDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return unavailable("compliance-sources-missing");
  }

  let mica = null;
  let genius = null;
  for (const fileName of fileNames) {
    const entry = readJsonFile(path.join(complianceDir, fileName));
    if (!entry || typeof entry.id !== "string" || !activeIds.has(entry.id)) continue;
    const micaStatus = entry.mica?.status;
    const geniusStatus = entry.genius?.authorizationStatus;
    if (mica === null
      && COMPLIANCE_EXPANDED_MICA_STATUSES.has(micaStatus)
      && (geniusStatus === undefined || COMPLIANCE_COLLAPSED_GENIUS_STATUSES.has(geniusStatus))) {
      mica = { id: entry.id, href: buildStablecoinHref(entry.id) };
    }
    if (genius === null
      && geniusStatus === "issuer-announced-intent"
      && !COMPLIANCE_EXPANDED_MICA_STATUSES.has(micaStatus)) {
      genius = {
        id: entry.id,
        href: buildStablecoinHref(entry.id),
        reviewedAt: typeof entry.genius?.reviewedAt === "string" ? entry.genius.reviewedAt : null,
      };
    }
    if (mica !== null && genius !== null) break;
  }
  return { status: "ok", mica, genius };
}

function validateComplianceRegimePanels(pageRecords, errors, warnings, expectation) {
  const record = pageRecords.find((entry) =>
    entry.route === COMPLIANCE_ROUTE && entry.filePath && fs.existsSync(entry.filePath));
  if (!record) return;
  const route = record.route;
  const html = stripNonElementMarkup(fs.readFileSync(record.filePath, "utf8"));
  const tags = collectElementTags(html);

  const idMatches = new Map();
  for (const { tag, index } of openingElementTags(tags, (candidate) => candidate.attrs.has("id"))) {
    const id = tag.attrs.get("id");
    idMatches.set(id, [...(idMatches.get(id) ?? []), { tag, index }]);
  }
  const panelHtmlByRegime = new Map();
  for (const panel of COMPLIANCE_REGIME_PANELS) {
    const matches = idMatches.get(panel.id) ?? [];
    if (matches.length !== 1) {
      errors.push(`${route}: expected exactly one #${panel.id} panel, found ${matches.length}`);
      continue;
    }
    const { tag, index } = matches[0];
    if (tag.attrs.get("role") !== "tabpanel") {
      errors.push(`${route}: #${panel.id} is missing role="tabpanel"`);
    }
    const labelledBy = tag.attrs.get("aria-labelledby") ?? "";
    if ((idMatches.get(labelledBy) ?? []).length !== 1) {
      errors.push(`${route}: #${panel.id} aria-labelledby ${JSON.stringify(labelledBy)} does not resolve to exactly one tab`);
    }
    const hidden = tag.attrs.has("hidden");
    if (panel.hidden && !hidden) {
      errors.push(`${route}: #${panel.id} must stay hidden until its tab is selected`);
    } else if (!panel.hidden && hidden) {
      errors.push(`${route}: #${panel.id} must not be hidden; it is the initial panel`);
    }
    panelHtmlByRegime.set(panel.regime, elementOuterHtml(html, tags, index));
  }

  for (const heading of COMPLIANCE_REGIME_HEADINGS) {
    const matches = idMatches.get(heading.id) ?? [];
    if (matches.length !== 1) {
      errors.push(`${route}: expected exactly one #${heading.id} regime heading, found ${matches.length}`);
      continue;
    }
    const headingHtml = elementOuterHtml(html, tags, matches[0].index);
    if (extractMarkupText(headingHtml) !== heading.text) {
      errors.push(`${route}: #${heading.id} heading text is ${JSON.stringify(extractMarkupText(headingHtml))}, expected "${heading.text}"`);
    }
    const panelHtml = panelHtmlByRegime.get(heading.regime) ?? "";
    if (!panelHtml.includes(headingHtml)) {
      errors.push(`${route}: #${heading.id} heading is outside the ${heading.regime} panel`);
    }
  }

  const overviewHtml = panelHtmlByRegime.get("all") ?? "";
  const micaHtml = panelHtmlByRegime.get("mica") ?? "";
  const geniusHtml = panelHtmlByRegime.get("genius") ?? "";
  const overviewText = extractMarkupText(overviewHtml);
  const micaText = extractMarkupText(micaHtml);
  const geniusText = extractMarkupText(geniusHtml);

  if (!overviewHtml.includes('data-table-id="compliance-overview"')) {
    errors.push(`${route}: Overview panel is missing the compliance-overview directory table`);
  }
  if (!overviewText.includes("Stablecoin directory")) {
    errors.push(`${route}: Overview panel is missing its directory label`);
  }
  if (!(overviewHtml.match(/href="\/stablecoin\/[^"#]*\/"/g) ?? []).length) {
    errors.push(`${route}: Overview panel renders no first-page profile links`);
  }
  if (overviewText.includes("MiCA authorization") || overviewText.includes("GENIUS Act status")) {
    errors.push(`${route}: Overview panel carries a regime heading; regime panels must own them`);
  }

  if (!micaHtml.includes('data-table-id="compliance-mica-authorization"')) {
    errors.push(`${route}: MiCA panel is missing its authorization table`);
  }
  if (!micaText.includes("Sources")) {
    errors.push(`${route}: MiCA panel mounts no source fold for its rows`);
  }
  if (!/href="https?:\/\//.test(micaHtml)) {
    errors.push(`${route}: MiCA panel carries no reviewed source destinations`);
  }
  if (micaText.includes("GENIUS Act status") || micaText.includes("GENIUS implementation watch")) {
    errors.push(`${route}: MiCA panel carries GENIUS content`);
  }

  if (!/data-table-id="compliance-genius-(?:authorization|watch)"/.test(geniusHtml)) {
    errors.push(`${route}: GENIUS panel is missing its authorization or implementation-watch table`);
  }
  if (!/Reviewed \d{4}-\d{2}-\d{2}/.test(geniusText)) {
    errors.push(`${route}: GENIUS panel carries no reviewed date for its mounted rows`);
  }
  if (!(geniusHtml.match(/href="\/stablecoin\/[^"#]*\/"/g) ?? []).length) {
    errors.push(`${route}: GENIUS panel renders no profile links`);
  }
  if (geniusText.includes("MiCA authorization")) {
    errors.push(`${route}: GENIUS panel carries MiCA content`);
  }
  const watchMatches = idMatches.get("implementation-watch") ?? [];
  if (watchMatches.length !== 1) {
    errors.push(`${route}: expected exactly one #implementation-watch block, found ${watchMatches.length}`);
  } else if (!geniusHtml.includes(elementOuterHtml(html, tags, watchMatches[0].index))) {
    errors.push(`${route}: #implementation-watch is outside the GENIUS panel`);
  }

  if (expectation?.status !== "ok") {
    warnings.push(`${route}: compliance panel representatives unavailable (${expectation?.reason ?? "not-provided"})`);
    return;
  }
  if (expectation.mica) {
    if (!micaHtml.includes(`href="${expectation.mica.href}"`)) {
      errors.push(`${route}: MiCA row ${expectation.mica.href} is missing from the MiCA panel`);
    }
    if (geniusHtml.includes(`href="${expectation.mica.href}"`)) {
      errors.push(`${route}: MiCA row ${expectation.mica.href} leaked into the GENIUS panel`);
    }
  }
  if (expectation.genius) {
    if (!geniusHtml.includes(`href="${expectation.genius.href}"`)) {
      errors.push(`${route}: GENIUS row ${expectation.genius.href} is missing from the GENIUS panel`);
    }
    if (micaHtml.includes(`href="${expectation.genius.href}"`)) {
      errors.push(`${route}: GENIUS row ${expectation.genius.href} leaked into the MiCA panel`);
    }
    if (expectation.genius.reviewedAt && !geniusText.includes(`Reviewed ${expectation.genius.reviewedAt}`)) {
      errors.push(
        `${route}: GENIUS row ${expectation.genius.href} does not carry its recorded review date ${expectation.genius.reviewedAt}`,
      );
    }
  }
}

export function collectSeoStaticCheckResult({
  outDir = DEFAULT_OUT_DIR,
  enforceGooglePreviewDirectives = true,
  enforceSnippetQuality = true,
  enforceStructuredDataMatrix = true,
  structuredDataRouteMatrix = STRUCTURED_DATA_ROUTE_MATRIX,
  safetyScoresPreviewExpectation,
  compliancePanelExpectation,
  pageRecords: suppliedPageRecords,
} = {}) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(outDir)) {
    return {
      errors: [`Missing build output directory: ${outDir}`],
      warnings,
      pageRecords: [],
      redirectRules: [],
    };
  }

  const pageRecords = suppliedPageRecords ?? [...walkOutFiles(outDir, (name) => name === "index.html")]
    .map((filePath) => buildSeoPageRecord(filePath, outDir, structuredDataRouteMatrix));

  const redirectEntries = collectRedirectEntries(outDir);
  const redirectRules = redirectEntries.filter((entry) => entry.destination);
  validateStaticHeaders(outDir, errors);
  validateStaticRedirects(redirectRules, errors);
  const longTitleRoutes = [];
  validateTaxonomyRedirectDestinations(redirectRules, outDir, errors);

  for (const record of pageRecords) {
    if (record.hasFatalCsrBailout) {
      errors.push(`${record.route}: CSR bailout marker found in HTML`);
    }

    if (!record.title) errors.push(`${record.route}: missing <title>`);
    if (!record.description) errors.push(`${record.route}: missing meta description`);
    const indexable = !record.retired && isIndexable(record.robotsTags);
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
      checkTitleAndDescriptionHygiene(record, errors, warnings, longTitleRoutes);
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
    if (indexable && !record.ogSiteName) errors.push(`${record.route}: missing og:site_name`);

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

    for (const error of record.structuredDataErrors) {
      errors.push(`${record.route}: ${error}`);
    }
    if (indexable) {
      for (const siteDataUrls of record.structuredDataSiteDataUrlGroups) {
        for (const entry of siteDataUrls.slice(0, 5)) {
          errors.push(
            `${record.route}: structured data URL points under /_site-data/ at ${entry.path}: ${entry.value}`,
          );
        }
        if (siteDataUrls.length > 5) {
          errors.push(`${record.route}: structured data has ${siteDataUrls.length - 5} additional /_site-data/ URLs`);
        }
      }
    }

    if (indexable && record.h1Count !== 1) {
      errors.push(`${record.route}: expected exactly one <h1> on indexable page, got ${record.h1Count}`);
    }
    if (indexable && record.visibleMainH1Count != null && record.visibleMainH1Count !== 1) {
      errors.push(
        `${record.route}: expected exactly one visible <h1> inside <main>, got ${record.visibleMainH1Count} (a route-level loading boundary moves it into hidden streamed HTML)`,
      );
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
  const redirectedRouteMatchers = buildRedirectedRouteMatchers(redirectRules);
  const graph = new Map();
  const inbound = new Map();
  for (const route of routeSet) {
    graph.set(route, new Set());
    inbound.set(route, 0);
  }

  for (const record of pageRecords) {
    for (const href of record.hrefs) {
      const slashlessRoute = slashlessInternalRouteMatch(href, routeSet);
      if (slashlessRoute) {
        errors.push(
          `${record.route}: internal anchor href omits canonical trailing slash: ${href} (use ${slashlessRoute})`,
        );
      }

      const normalized = normalizeHref(href);
      if (!normalized) continue;

      const retiredRoute = retiredInternalRouteMatch(normalized);
      if (retiredRoute) {
        errors.push(
          `${record.route}: internal anchor href points to retired route prefix ${retiredRoute.prefix}: ${href} (use ${retiredRoute.replacement})`,
        );
      } else {
        const redirectedRoute = redirectedInternalRouteMatch(normalized, redirectedRouteMatchers);
        if (redirectedRoute) {
          errors.push(
            `${record.route}: internal anchor href points to _redirects source ${redirectedRoute.source}: ${href} (use ${redirectedRoute.destination})`,
          );
        }
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
    if (record.retired || !isIndexable(record.robotsTags)) continue;

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
    const locList = parseSitemapLocs(sitemapXml);
    const duplicateLocs = findDuplicateSitemapLocs(locList);
    if (duplicateLocs.length > 0) {
      errors.push(
        `sitemap.xml contains duplicate <loc> entries: ${duplicateLocs.slice(0, 10).join(", ")}${duplicateLocs.length > 10 ? " ..." : ""}`,
      );
    }
    const locs = new Set(locList);
    const stabilityIndexUrl = `${PHAROS_ORIGIN}/stability-index/`;
    const alternateStabilityIndexUrl = `${PHAROS_ORIGIN}/stability-index-alt/`;
    if (!locs.has(stabilityIndexUrl)) {
      errors.push(`sitemap.xml missing ${stabilityIndexUrl}`);
    }
    if (locs.has(alternateStabilityIndexUrl)) {
      errors.push(`sitemap.xml should not include ${alternateStabilityIndexUrl}`);
    }

    const pageUrlSet = new Set(
      pageRecords
        .filter((p) => p.indexable)
        .map((p) => `https://pharos.watch${p.route === "/" ? "/" : p.route}`),
    );

    const missingFromSitemap = [...pageUrlSet].filter((url) => !locs.has(url));
    if (missingFromSitemap.length > 0) {
      errors.push(
        `indexable pages missing from sitemap.xml: ${missingFromSitemap.slice(0, 10).join(", ")}${missingFromSitemap.length > 10 ? " ..." : ""}`,
      );
    }

    const pageByRoute = new Map(pageRecords.map((page) => [page.route, page]));
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
      const page = pageByRoute.get(sitemapRoute.route);
      if (page && !page.indexable) {
        errors.push(`sitemap.xml URL ${loc} conflicts with non-indexable HTML metadata; drop one of the two signals`);
      }
    }

    const redirectSourceByKey = new Map(
      redirectEntries.flatMap(({ source }) => {
        const key = redirectSourceKey(source);
        return key ? [[key, source]] : [];
      }),
    );
    if (redirectSourceByKey.size > 0) {
      for (const loc of locs) {
        const sitemapRoute = sitemapRouteFromPharosUrl(loc);
        if (!sitemapRoute || sitemapRoute.error) continue;
        const source = redirectSourceByKey.get(redirectSourceKey(sitemapRoute.route));
        if (source) {
          errors.push(`sitemap.xml URL ${loc} conflicts with _redirects source ${source}; drop one of the two signals`);
        }
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

  if (longTitleRoutes.length > 0) {
    warnings.push(
      `${longTitleRoutes.length} indexable <title>s exceed ${TITLE_WARN_LENGTH} chars (search truncation), e.g. ${longTitleRoutes.slice(0, 5).join(", ")}`,
    );
  }
  validateStablecoinProfileRender(pageRecords, errors);
  validateContractDeploymentSurfaces(pageRecords, errors, warnings);
  if (pageRecords.some((record) => record.route === SAFETY_SCORES_ROUTE)) {
    const expectation = safetyScoresPreviewExpectation
      ?? (safetyScoresPreviewExpectationCache ??= buildSafetyScoresPreviewExpectation());
    validateSafetyScoresPreview(pageRecords, errors, warnings, expectation);
  }
  if (pageRecords.some((record) => record.route === COMPLIANCE_ROUTE)) {
    const expectation = compliancePanelExpectation
      ?? (compliancePanelExpectationCache ??= buildCompliancePanelExpectation());
    validateComplianceRegimePanels(pageRecords, errors, warnings, expectation);
  }

  // Informational warning only: avoids failing CI for transient route count changes.
  warnings.push(`Checked ${pageRecords.length} HTML pages in out/`);

  return { errors, warnings, pageRecords, redirectRules };
}

function parsePageRecordChunk(files, outDir, structuredDataRouteMatrix) {
  return files.map((filePath) => buildSeoPageRecord(filePath, outDir, structuredDataRouteMatrix));
}

function runPageRecordWorker(files, outDir, structuredDataRouteMatrix) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: "pharos-seo-page-records",
        files,
        outDir,
        structuredDataRouteMatrix,
      },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`SEO page-record worker exited ${code}.`));
    });
  });
}

export async function collectSeoStaticCheckResultParallel(options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  if (!fs.existsSync(outDir)) return collectSeoStaticCheckResult(options);
  const indexFiles = [...walkOutFiles(outDir, (name) => name === "index.html")];
  const configuredWorkers = Number.parseInt(process.env.SEO_CHECK_WORKERS ?? "", 10);
  const defaultWorkers = Math.max(1, Math.min(3, availableParallelism() - 1));
  const workerCount = Math.max(
    1,
    Math.min(
      indexFiles.length,
      Number.isFinite(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : defaultWorkers,
    ),
  );
  if (workerCount === 1 || indexFiles.length < 20) {
    return collectSeoStaticCheckResult(options);
  }

  const chunkSize = Math.ceil(indexFiles.length / workerCount);
  const chunks = Array.from({ length: workerCount }, (_, index) =>
    indexFiles.slice(index * chunkSize, (index + 1) * chunkSize),
  ).filter((chunk) => chunk.length > 0);
  const pageRecords = (
    await Promise.all(
      chunks.map((files) =>
        runPageRecordWorker(
          files,
          outDir,
          options.structuredDataRouteMatrix ?? STRUCTURED_DATA_ROUTE_MATRIX,
        ),
      ),
    )
  ).flat();
  return collectSeoStaticCheckResult({ ...options, outDir, pageRecords });
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

async function main() {
  const { errors, warnings, pageRecords, redirectRules } = await collectSeoStaticCheckResultParallel();

  const previousSitemapUrl = process.env.SEO_PREVIOUS_SITEMAP_URL?.trim();
  if (previousSitemapUrl) {
    try {
      const url = new URL(previousSitemapUrl);
      url.searchParams.set("archiveContinuity", String(Date.now()));
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { "Cache-Control": "no-cache", "User-Agent": "PharosSeoArchiveContinuity/1.0" },
      });
      if (!response.ok) throw new Error(`returned ${response.status}`);
      const previousSitemapXml = await response.text();
      const currentSitemapXml = fs.readFileSync(path.join(DEFAULT_OUT_DIR, "sitemap.xml"), "utf8");
      errors.push(
        ...findPublishedArchiveContinuityErrors(
          previousSitemapXml,
          currentSitemapXml,
          redirectRules,
          new Set(pageRecords.map((record) => record.route)),
        ),
      );
    } catch (error) {
      errors.push(
        `failed to verify published archive continuity from ${previousSitemapUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (errors.length > 0) {
    fail(errors, warnings);
  }

  for (const w of warnings) {
    console.log(`OK: ${w}`);
  }
  console.log("OK: SEO static checks passed");
}

if (!isMainThread && workerData?.kind === "pharos-seo-page-records") {
  parentPort?.postMessage(
    parsePageRecordChunk(
      workerData.files,
      workerData.outDir,
      workerData.structuredDataRouteMatrix,
    ),
  );
} else if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
