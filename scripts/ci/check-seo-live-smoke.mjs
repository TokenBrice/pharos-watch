#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findDuplicateSitemapLocs, parseSitemapLocs } from "../lib/seo-sitemap.mjs";
import { parseCliOptions, parseNonNegativeInt, readEnvFirst } from "../lib/smoke-runtime.mjs";

const SITEMAP_CONCURRENCY = 8;
const JS_DISABLED_ROUTES = [
  { route: "/", minMainChars: 800, minLinks: 20 },
  { route: "/stablecoin/usdt-tether/", minMainChars: 500, minLinks: 10 },
  { route: "/chains/ethereum/", minMainChars: 350, minLinks: 10 },
];

function parseArgs(argv) {
  const args = {
    baseUrl: readEnvFirst("SEO_LIVE_SMOKE_URL", "https://pharos.watch"),
    sitemapLimit: Number.POSITIVE_INFINITY,
    skipSitemap: false,
    skipBrowser: false,
  };

  parseCliOptions(argv, {
    "--url": ({ readValue }) => {
      args.baseUrl = readValue();
      return "value";
    },
    "--sitemap-limit": ({ readValue }) => {
      args.sitemapLimit = parseNonNegativeInt(readValue(), args.sitemapLimit);
      return "value";
    },
    "--skip-sitemap": () => {
      args.skipSitemap = true;
    },
    "--skip-browser": () => {
      args.skipBrowser = true;
    },
  });

  return args;
}

function normalizeBaseUrl(input) {
  const url = new URL(input);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function resolveRoute(baseUrl, route) {
  return new URL(route.startsWith("/") ? route : `/${route}`, baseUrl).toString();
}

function extractRobots(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return tags
    .map((tag) => {
      const name = tag.match(/\bname=["']robots["']/i);
      const content = tag.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i);
      return name ? (content?.[1] ?? content?.[2] ?? "") : "";
    })
    .filter(Boolean)
    .join(",");
}

function hasImmutableCache(headers) {
  return /\bimmutable\b/i.test(headers.get("cache-control") ?? "");
}

async function fetchManual(url, init = {}) {
  return fetch(url, {
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "PharosSeoLiveSmoke/1.0",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

async function cancelResponseBody(response) {
  await response.body?.cancel?.().catch(() => {});
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function checkSitemap(baseUrl, errors) {
  const sitemapUrl = resolveRoute(baseUrl, "/sitemap.xml");
  const sitemapResponse = await fetchManual(sitemapUrl, {
    headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" },
  });
  if (sitemapResponse.status !== 200) {
    errors.push(`sitemap.xml returned ${sitemapResponse.status}`);
    return [];
  }

  const locs = parseSitemapLocs(await sitemapResponse.text());
  if (locs.length === 0) {
    errors.push("sitemap.xml has no <loc> entries");
  }
  const duplicateLocs = findDuplicateSitemapLocs(locs);
  if (duplicateLocs.length > 0) {
    errors.push(
      `sitemap.xml contains duplicate <loc> entries: ${duplicateLocs.slice(0, 10).join(", ")}${duplicateLocs.length > 10 ? " ..." : ""}`,
    );
  }
  return locs;
}

export async function checkSitemapUrls(locs, limit, errors) {
  const selected = Number.isFinite(limit) ? locs.slice(0, limit) : locs;
  await mapWithConcurrency(selected, SITEMAP_CONCURRENCY, async (loc) => {
    const response = await fetchManual(loc);
    try {
      if (response.status >= 300 && response.status < 400) {
        errors.push(`${loc}: sitemap URL redirects with ${response.status}`);
        return;
      }
      if (response.status === 404) {
        errors.push(`${loc}: sitemap URL returns 404`);
        return;
      }
      if (response.status >= 400) {
        errors.push(`${loc}: sitemap URL returns ${response.status}`);
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        const robots = extractRobots(await response.text());
        if (/\bnoindex\b/i.test(robots)) {
          errors.push(`${loc}: sitemap URL is noindexed (${robots})`);
        }
      }
    } finally {
      await cancelResponseBody(response);
    }
  });
}

async function checkHeaders(baseUrl, errors) {
  for (const route of ["/chains/", "/chains/ethereum/"]) {
    const response = await fetchManual(resolveRoute(baseUrl, route));
    if (response.status !== 200) {
      errors.push(`${route}: expected 200, got ${response.status}`);
    }
    if (hasImmutableCache(response.headers)) {
      errors.push(`${route}: HTML response has immutable cache-control`);
    }
  }

  for (const route of ["/stablecoin/usdt-tether/index.md", "/methodology/index.md"]) {
    const response = await fetchManual(resolveRoute(baseUrl, route), {
      headers: { Accept: "text/markdown,*/*;q=0.8" },
    });
    if (response.status !== 200) {
      errors.push(`${route}: expected direct markdown asset 200, got ${response.status}`);
      continue;
    }
    const robots = response.headers.get("x-robots-tag") ?? "";
    const link = response.headers.get("link") ?? "";
    if (!/\bnoindex\b/i.test(robots)) {
      errors.push(`${route}: missing X-Robots-Tag noindex`);
    }
    if (!/\brel="?canonical"?/i.test(link)) {
      errors.push(`${route}: missing canonical Link header`);
    }
  }
}

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new Error(`Failed to load Playwright: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkJsDisabled(baseUrl, errors) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    for (const check of JS_DISABLED_ROUTES) {
      const page = await context.newPage();
      const response = await page.goto(resolveRoute(baseUrl, check.route), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (!response || response.status() >= 400) {
        errors.push(`${check.route}: JS-disabled navigation returned ${response?.status() ?? "no response"}`);
        await page.close();
        continue;
      }
      const h1Count = await page.locator("h1").count();
      const mainChars = await page
        .locator("main")
        .evaluate((main) => main.textContent?.replace(/\s+/g, " ").trim().length ?? 0)
        .catch(() => 0);
      const linkCount = await page
        .locator("main a[href]")
        .count()
        .catch(() => 0);
      if (h1Count !== 1) {
        errors.push(`${check.route}: JS-disabled page has ${h1Count} h1 elements`);
      }
      if (mainChars < check.minMainChars) {
        errors.push(`${check.route}: JS-disabled main text too short (${mainChars} chars)`);
      }
      if (linkCount < check.minLinks) {
        errors.push(`${check.route}: JS-disabled link count too low (${linkCount})`);
      }
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const errors = [];

  const locs = args.skipSitemap ? [] : await checkSitemap(baseUrl, errors);
  if (!args.skipSitemap && locs.length > 0) {
    await checkSitemapUrls(locs, args.sitemapLimit, errors);
  }
  await checkHeaders(baseUrl, errors);
  if (!args.skipBrowser) {
    await checkJsDisabled(baseUrl, errors);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exit(1);
  }

  const sitemapLabel = args.skipSitemap
    ? "sitemap skipped"
    : `${Number.isFinite(args.sitemapLimit) ? Math.min(locs.length, args.sitemapLimit) : locs.length} sitemap URLs`;
  console.log(`OK: SEO live smoke passed for ${baseUrl.toString()} (${sitemapLabel})`);
}

export function isMainEntrypoint(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) {
    return false;
  }
  try {
    const modulePath = realpathSync(fileURLToPath(importMetaUrl));
    return pathToFileURL(modulePath).href === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isMainEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
