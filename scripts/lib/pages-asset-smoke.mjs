import { parseAttributes } from "./seo-html-parse.mjs";
import { tsImport } from "tsx/esm/api";

const { buildStablecoinUrl } = await tsImport("../../shared/lib/urls.ts", import.meta.url);

export const DEFAULT_YIELD_RANKING_COUNT = 25;
export const REPRESENTATIVE_YIELD_CANARY_IDS = Object.freeze([
  "usdc-circle",
  "usdt-tether",
  "stusds-sky",
  "syrupusdc-maple",
  "eurcv-societe-generale-forge",
  "buidl-blackrock",
  "apyusd-apyx",
  "susde-ethena",
  "scrvusd-curve",
]);
export const WARM_CACHE_YIELD_CANARY_IDS = Object.freeze(["usdc-circle", "usdt-tether"]);

const FRAMEWORK_ERROR_MARKERS = [
  "This coin's page didn't load.",
  "Application error: a client-side exception has occurred",
  "The data didn't reach this page.",
];

function isStablecoinId(value) {
  if (!value || value.startsWith("-") || value.endsWith("-") || value.includes("--")) return false;
  return Array.from(value).every(
    (char) => char === "-" || (char >= "a" && char <= "z") || (char >= "0" && char <= "9"),
  );
}

export function getTopYieldRankingIds(payload, limit = DEFAULT_YIELD_RANKING_COUNT) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rankings)) {
    throw new Error("Yield rankings response is missing rankings[]");
  }

  const ids = [];
  const seen = new Set();
  for (const ranking of payload.rankings) {
    const id = typeof ranking?.id === "string" ? ranking.id.trim() : "";
    if (!isStablecoinId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }

  if (ids.length < limit) {
    throw new Error(`Yield rankings returned only ${ids.length} valid unique id(s); expected ${limit}`);
  }
  return ids;
}

export function buildYieldDeepRoutes(rankingIds, representativeIds = REPRESENTATIVE_YIELD_CANARY_IDS) {
  const ids = [];
  const seen = new Set();
  for (const rawId of [...rankingIds, ...representativeIds]) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!isStablecoinId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map((id) => ({ id, route: buildStablecoinUrl(id, "yield/") }));
}

export function extractScriptUrls(html, documentUrl) {
  const scriptUrls = [];
  const lowerHtml = html.toLowerCase();
  let offset = 0;
  while (offset < html.length) {
    const scriptStart = lowerHtml.indexOf("<script", offset);
    if (scriptStart < 0) break;
    const tagEnd = html.indexOf(">", scriptStart);
    if (tagEnd < 0) break;
    const tag = html.slice(scriptStart, tagEnd + 1);
    const src = parseAttributes(tag).get("src");
    if (src) {
      try {
        scriptUrls.push(new URL(src, documentUrl).toString());
      } catch {
        // The caller will still exercise the document in a browser. Ignore a
        // malformed URL here instead of hiding the more useful browser error.
      }
    }
    offset = tagEnd + 1;
  }
  return [...new Set(scriptUrls)];
}

export function classifyFirstPartyAsset(url, resourceType, expectedOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin) return null;

  const pathname = parsed.pathname.toLowerCase();
  if (resourceType === "font" || pathname.startsWith("/fonts/") || /\.(?:woff2?|ttf|otf)$/.test(pathname)) {
    return "font";
  }
  if (resourceType === "script" || /\.(?:m?js)$/.test(pathname)) {
    return "script";
  }
  if (resourceType === "stylesheet" || pathname.endsWith(".css")) {
    return "style";
  }
  return null;
}

export function hasExpectedAssetMime(assetType, contentType) {
  const normalized = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (assetType === "script") {
    return /^(?:application|text)\/(?:x-)?javascript$/.test(normalized);
  }
  if (assetType === "style") {
    return normalized === "text/css";
  }
  if (assetType === "font") {
    return normalized.startsWith("font/") || normalized === "application/font-woff";
  }
  return false;
}

export function getUnsafeHtmlCacheDirectives(cacheControl) {
  return (cacheControl ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .filter(
      (directive) =>
        directive === "s-maxage" ||
        directive.startsWith("s-maxage=") ||
        directive === "stale-while-revalidate" ||
        directive.startsWith("stale-while-revalidate="),
    );
}

export function isFatalRuntimeMessage(message) {
  return /ChunkLoadError|Loading (?:CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|Expected a JavaScript-or-Wasm module script|Hydration failed|hydration mismatch|server rendered HTML didn't match|Minified React error #(418|423|425)/i.test(
    message ?? "",
  );
}

export function findFrameworkErrorMarker(bodyText) {
  return FRAMEWORK_ERROR_MARKERS.find((marker) => bodyText?.includes(marker)) ?? null;
}

export function chunkItems(items, workerCount) {
  if (!Array.isArray(items) || items.length === 0 || workerCount <= 0) return [];
  const count = Math.min(items.length, workerCount);
  const chunks = Array.from({ length: count }, () => []);
  items.forEach((item, index) => chunks[index % count].push(item));
  return chunks;
}
