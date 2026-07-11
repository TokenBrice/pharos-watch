#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  WARM_CACHE_YIELD_CANARY_IDS,
  buildYieldDeepRoutes,
  chunkItems,
  classifyFirstPartyAsset,
  extractScriptUrls,
  findFrameworkErrorMarker,
  getTopYieldRankingIds,
  getUnsafeHtmlCacheDirectives,
  hasExpectedAssetMime,
  isFatalRuntimeMessage,
} from "../lib/pages-asset-smoke.mjs";
import { assert, isDirectRun, readPositiveIntEnv, sleep } from "../lib/smoke-runtime.mjs";
import { launchChromiumBrowser, loadChromium } from "./smoke-ui.mjs";

const ENV_FILE = resolve(".env.local");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const DEFAULT_URL = process.env.SMOKE_PAGES_ASSET_URL ?? "https://pharos.watch";
const DEFAULT_MODE = process.env.SMOKE_PAGES_ASSET_MODE ?? "local";
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_LOCAL_WORKERS = 4;
const DEFAULT_LIVE_WORKERS = 4;

function parseArgs(argv) {
  const args = { mode: DEFAULT_MODE, url: DEFAULT_URL };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--url") {
      args.url = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--mode") {
      args.mode = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return args;
}

function ensureMode(value) {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "local" || mode === "live") return mode;
  throw new Error(`Invalid mode "${value}". Expected "local" or "live".`);
}

function ensureBaseUrl(value) {
  const url = new URL((value ?? "").trim());
  return url.toString();
}

function resolveRankingsUrl(baseUrl, mode) {
  const explicit = process.env.SMOKE_PAGES_ASSET_RANKINGS_URL?.trim();
  if (explicit) return new URL(explicit).toString();
  if (mode === "local") return new URL("/api/yield-rankings", baseUrl).toString();

  const apiBase =
    process.env.SMOKE_API_BASE_URL?.trim() || process.env.NEXT_PUBLIC_API_BASE?.trim() || "https://api.pharos.watch";
  return new URL("/api/yield-rankings", apiBase).toString();
}

function getApiKey() {
  return [process.env.SMOKE_API_KEY, process.env.PHAROS_API_KEY, process.env.STATIC_EXPORT_API_KEY]
    .map((value) => value?.trim())
    .find(Boolean);
}

async function fetchTopYieldIds(baseUrl, mode, rankingCount) {
  const rankingsUrl = resolveRankingsUrl(baseUrl, mode);
  const apiKey = getApiKey();
  const response = await fetch(rankingsUrl, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
    },
  });
  const bodyText = await response.text();
  assert(response.ok, `Yield rankings request failed (${response.status}) at ${rankingsUrl}`);

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`Yield rankings returned invalid JSON at ${rankingsUrl}`);
  }
  return getTopYieldRankingIds(payload, rankingCount);
}

function parseRouteOverride() {
  const raw = process.env.SMOKE_PAGES_ASSET_ROUTES?.trim();
  if (!raw) return null;
  const routes = raw
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
    .map((route) => {
      const pathname = new URL(route, "https://pharos.watch").pathname;
      const match = /^\/stablecoin\/([^/]+)\/yield\/$/.exec(pathname);
      if (!match) throw new Error(`Invalid yield asset-smoke route: ${route}`);
      return { id: match[1], route: pathname };
    });
  assert(routes.length > 0, "SMOKE_PAGES_ASSET_ROUTES did not contain any routes");
  return routes;
}

function isExpectedFinalPath(finalUrl, originalRoute) {
  const pathname = new URL(finalUrl).pathname;
  return pathname === originalRoute || pathname === originalRoute.slice(0, -1) || pathname === "/yield/";
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Headers and status are the contract under test; the body is unnecessary.
  }
}

async function verifyReferencedScript(scriptUrl, expectedOrigin) {
  const parsed = new URL(scriptUrl);
  if (parsed.origin !== expectedOrigin) return;

  const response = await fetch(scriptUrl, {
    headers: { Accept: "application/javascript,text/javascript,*/*;q=0.1" },
  });
  const contentType = response.headers.get("content-type") ?? "";
  await cancelBody(response);
  assert(response.ok, `Referenced script returned ${response.status}: ${scriptUrl}`);
  assert(
    hasExpectedAssetMime("script", contentType),
    `Referenced script returned non-JavaScript MIME "${contentType || "missing"}": ${scriptUrl}`,
  );
}

async function verifyDocument(routeInfo, baseUrl, mode, scriptChecks) {
  const routeUrl = new URL(routeInfo.route, baseUrl).toString();
  const response = await fetch(routeUrl, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const cacheControl = response.headers.get("cache-control") ?? "";
  const finalUrl = response.url;
  const html = await response.text();

  assert(response.ok, `${routeInfo.route} returned ${response.status}`);
  assert(contentType.toLowerCase().startsWith("text/html"), `${routeInfo.route} returned MIME ${contentType}`);
  assert(
    isExpectedFinalPath(finalUrl, routeInfo.route),
    `${routeInfo.route} redirected to unexpected path ${new URL(finalUrl).pathname}`,
  );
  if (mode === "live") {
    const unsafeCacheDirectives = getUnsafeHtmlCacheDirectives(cacheControl);
    assert(
      unsafeCacheDirectives.length === 0,
      `${routeInfo.route} HTML permits deployment-skewed stale serving: ${unsafeCacheDirectives.join(", ")}`,
    );
  }

  const scriptUrls = extractScriptUrls(html, finalUrl).filter(
    (scriptUrl) => new URL(scriptUrl).origin === new URL(baseUrl).origin,
  );
  assert(scriptUrls.length > 0, `${routeInfo.route} HTML did not reference any first-party scripts`);
  await Promise.all(
    scriptUrls.map((scriptUrl) => {
      if (!scriptChecks.has(scriptUrl)) {
        scriptChecks.set(scriptUrl, verifyReferencedScript(scriptUrl, new URL(baseUrl).origin));
      }
      return scriptChecks.get(scriptUrl);
    }),
  );

  return scriptUrls.length;
}

function createDiagnostics() {
  return {
    assetFailures: [],
    assetResponses: 0,
    consoleErrors: [],
    pageErrors: [],
  };
}

async function verifyBrowserPass(page, routeInfo, baseUrl, diagnostics, label, waitTimeoutMs, settleMs) {
  const routeUrl = new URL(routeInfo.route, baseUrl).toString();
  const response = await page.goto(routeUrl, {
    timeout: waitTimeoutMs,
    waitUntil: "domcontentloaded",
  });
  assert(response, `${routeInfo.route} ${label} navigation returned no response`);
  assert(response.status() < 400, `${routeInfo.route} ${label} navigation returned ${response.status()}`);

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(5000, waitTimeoutMs) });
  } catch {
    // Live data polling can keep the page non-idle; the bounded settle below is
    // enough for chunk and hydration failures to surface.
  }
  await sleep(settleMs);
  await page.evaluate(async () => {
    if (!document.fonts) return;
    await Promise.race([document.fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 2000))]);
  });

  const bodyText = await page.locator("body").innerText();
  const errorMarker = findFrameworkErrorMarker(bodyText);
  assert(!errorMarker, `${routeInfo.route} ${label} rendered framework error boundary: ${errorMarker}`);
  assert(
    isExpectedFinalPath(page.url(), routeInfo.route),
    `${routeInfo.route} ${label} landed on unexpected path ${new URL(page.url()).pathname}`,
  );
  assert(
    diagnostics.assetFailures.length === 0,
    `${routeInfo.route} ${label} first-party asset failure(s): ${diagnostics.assetFailures.join("; ")}`,
  );
  assert(
    diagnostics.pageErrors.length === 0,
    `${routeInfo.route} ${label} runtime error(s): ${diagnostics.pageErrors.join("; ")}`,
  );
  assert(
    diagnostics.consoleErrors.length === 0,
    `${routeInfo.route} ${label} console runtime error(s): ${diagnostics.consoleErrors.join("; ")}`,
  );
}

async function verifyBrowserRoute(browser, routeInfo, baseUrl, warmCacheIds, waitTimeoutMs, settleMs) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const expectedOrigin = new URL(baseUrl).origin;
  let diagnostics = createDiagnostics();

  page.on("response", (response) => {
    const request = response.request();
    const assetType = classifyFirstPartyAsset(response.url(), request.resourceType(), expectedOrigin);
    if (!assetType) return;
    diagnostics.assetResponses += 1;
    const contentType = response.headers()["content-type"] ?? "";
    if (response.status() >= 400) {
      diagnostics.assetFailures.push(`${response.status()} ${response.url()}`);
    } else if (!hasExpectedAssetMime(assetType, contentType)) {
      diagnostics.assetFailures.push(`${assetType} MIME "${contentType || "missing"}" ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const assetType = classifyFirstPartyAsset(request.url(), request.resourceType(), expectedOrigin);
    if (!assetType) return;
    diagnostics.assetFailures.push(`${request.failure()?.errorText ?? "request failed"} ${request.url()}`);
  });
  page.on("pageerror", (error) => {
    if (isFatalRuntimeMessage(error.message)) diagnostics.pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && isFatalRuntimeMessage(message.text())) {
      diagnostics.consoleErrors.push(message.text());
    }
  });

  try {
    await verifyBrowserPass(page, routeInfo, baseUrl, diagnostics, "fresh-cache", waitTimeoutMs, settleMs);
    assert(
      diagnostics.assetResponses > 0,
      `${routeInfo.route} fresh-cache navigation observed no first-party script/style/font responses`,
    );

    if (warmCacheIds.has(routeInfo.id)) {
      diagnostics = createDiagnostics();
      await verifyBrowserPass(page, routeInfo, baseUrl, diagnostics, "warm-cache", waitTimeoutMs, settleMs);
    }
  } finally {
    await context.close();
  }
}

export async function run() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = ensureBaseUrl(args.url);
  const mode = ensureMode(args.mode);
  const rankingCount = readPositiveIntEnv("SMOKE_PAGES_ASSET_RANKING_COUNT", 25);
  const waitTimeoutMs = readPositiveIntEnv("SMOKE_PAGES_ASSET_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS);
  const settleMs = readPositiveIntEnv("SMOKE_PAGES_ASSET_SETTLE_MS", DEFAULT_SETTLE_MS);
  const workerCount = readPositiveIntEnv(
    "SMOKE_PAGES_ASSET_WORKERS",
    mode === "live" ? DEFAULT_LIVE_WORKERS : DEFAULT_LOCAL_WORKERS,
  );
  const routeOverride = parseRouteOverride();
  const routes = routeOverride ?? buildYieldDeepRoutes(await fetchTopYieldIds(baseUrl, mode, rankingCount));
  const routeChunks = chunkItems(routes, workerCount);
  const warmCacheIds = new Set(WARM_CACHE_YIELD_CANARY_IDS);

  console.log(
    `[smoke-pages-assets] Checking ${routes.length} Yield deep route(s) (${rankingCount} live rankings + source-family canaries) against ${baseUrl}`,
  );

  const scriptChecks = new Map();
  const documentResults = await Promise.all(
    routeChunks.map(async (chunk) => {
      let scriptReferenceCount = 0;
      for (const routeInfo of chunk) {
        try {
          scriptReferenceCount += await verifyDocument(routeInfo, baseUrl, mode, scriptChecks);
        } catch (error) {
          throw new Error(
            `${routeInfo.route} document asset check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return scriptReferenceCount;
    }),
  );
  await Promise.all(scriptChecks.values());
  console.log(
    `[smoke-pages-assets] OK HTML/script coherence (${documentResults.reduce((sum, count) => sum + count, 0)} references, ${scriptChecks.size} unique scripts)`,
  );

  const chromium = await loadChromium();
  const browser = await launchChromiumBrowser(chromium);
  try {
    await Promise.all(
      routeChunks.map(async (chunk, index) => {
        for (const routeInfo of chunk) {
          try {
            await verifyBrowserRoute(browser, routeInfo, baseUrl, warmCacheIds, waitTimeoutMs, settleMs);
          } catch (error) {
            throw new Error(
              `${routeInfo.route} browser check failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        console.log(
          `[smoke-pages-assets] OK browser worker ${index + 1}/${routeChunks.length} (${chunk.length} routes)`,
        );
      }),
    );
  } finally {
    await browser.close();
  }

  console.log("[smoke-pages-assets] All checks passed.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[smoke-pages-assets] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
