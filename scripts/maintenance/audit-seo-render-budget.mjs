#!/usr/bin/env node

import { CliUsageError, parseStrictCliArgs, parseCliInteger, runDirectCli } from "../lib/cli-args.mjs";
import { getBrowserLaunchOptions, loadChromium } from "../lib/smoke-runtime.mjs";
import {
  HISTORY_PREVIEW_PILOT_ROUTES,
  UNENROLLED_SENTINEL_EXPECTATIONS,
  getRouteExpectations,
  classifyRouteSurface,
  isReplayEligibleRoute,
  buildCollectExpression,
  diffInternalHrefs,
  evaluateSentinels,
} from "../lib/seo-render-facts.mjs";

const DEFAULT_BASE_URL = process.env.SEO_RENDER_BUDGET_URL ?? "https://pharos.watch";
const DEFAULT_ROUTES = [
  "/",
  ...HISTORY_PREVIEW_PILOT_ROUTES,
  "/chains/ethereum/",
  "/chains/solana/",
  "/chains/base/",
  "/liquidity/",
  "/depeg/",
  "/yield/",
  "/safety-scores/",
  "/flows/",
  "/api/",
  "/alt-pegs/",
  "/compliance/",
];
const DEFAULT_WAIT_MS = "4000";
const CAPTURE_TIMEOUT_MS = 45_000;
const MOBILE_VIEWPORT = { width: 412, height: 915 };
const TALL_VIEWPORT = { width: 412, height: 12_000 };
const REPLAY_INJECTION_HEADER = "x-pharos-seo-audit-injection";
const REPLAY_INJECTION_BODY = JSON.stringify({ error: "SEO audit injected API failure" });
const PROVENANCE_HEADER_NAMES = [
  "cache-control",
  "cdn-cache-control",
  "cf-cache-status",
  "age",
  "x-data-age",
  "x-data-updated-at",
  "x-data-freshness",
  "x-data-freshness-reason",
  "x-data-assessed-at",
  "x-data-freshness-budget",
  "x-safety-score-status",
  "x-safety-score-updated-at",
  "x-safety-score-generation",
];
const GENERATION_HEADER_NAMES = ["x-safety-score-generation", "x-data-updated-at"];

export const SEO_RENDER_BUDGET_HELP = [
  "Usage: node scripts/maintenance/audit-seo-render-budget.mjs [--url <url>] [--routes <comma-separated-routes>] [--wait-ms <n>] [--api-failure-replay] [--json]",
  "Read-only browser render-budget audit; defaults to the live site and waits 4000 ms.",
  "--api-failure-replay  Replay selected profile, Alt-Pegs and seed-pilot routes with API reads returning an injected 503.",
].join("\n");

export function parseSeoRenderBudgetArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      url: { type: "string", default: DEFAULT_BASE_URL },
      routes: { type: "string" },
      json: { type: "boolean" },
      "wait-ms": { type: "string", default: DEFAULT_WAIT_MS },
      "api-failure-replay": { type: "boolean" },
    },
  });
  const args = {
    baseUrl: values.url,
    routes: values.routes === undefined ? DEFAULT_ROUTES
      : values.routes.split(",").map((route) => route.trim()).filter(Boolean),
    json: values.json === true,
    waitMs: parseCliInteger(values["wait-ms"], { name: "--wait-ms", min: 0 }),
    apiFailureReplay: values["api-failure-replay"] === true,
    help: values.help === true,
  };

  if (args.routes.length === 0) {
    throw new CliUsageError("At least one route is required. Pass --routes /,/stablecoin/usdt-tether/.");
  }

  return args;
}

function normalizeBaseUrl(input) {
  const url = new URL(input || DEFAULT_BASE_URL);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function resolveRoute(baseUrl, route) {
  return new URL(route.startsWith("/") ? route : `/${route}`, baseUrl).toString();
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value, max = 240) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function classifyResource(url, resourceType) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/_site-data/")) return "siteData";
  if (resourceType === "script" || pathname.endsWith(".js")) return "script";
  if (resourceType === "stylesheet" || pathname.endsWith(".css")) return "style";
  if (resourceType === "font" || /\.(woff2?|ttf|otf)$/i.test(pathname)) return "font";
  if (resourceType === "image" || /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(pathname)) return "image";
  return "other";
}

function isDataReadUrl(input, origin) {
  try {
    const url = new URL(input);
    if (origin && url.origin !== origin) return false;
    return url.pathname.startsWith("/_site-data/")
      || url.pathname === "/api"
      || url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function emptyCounters() {
  return {
    requests: 0,
    accountingErrors: 0,
    blockedAnalyticsRequests: 0,
    scriptRequests: 0,
    styleRequests: 0,
    fontRequests: 0,
    imageRequests: 0,
    siteDataRequests: 0,
    knownContentLengthBytes: 0,
    observedTransferBytes: 0,
    scriptKnownBytes: 0,
    scriptObservedBytes: 0,
    styleKnownBytes: 0,
    styleObservedBytes: 0,
    fontKnownBytes: 0,
    fontObservedBytes: 0,
  };
}

function emptyFailures() {
  return {
    httpData: [],
    failedRequests: [],
    pageErrors: [],
    intentionalBlocks: [],
  };
}

function pickProvenanceHeaders(headers) {
  const observed = {};
  for (const name of PROVENANCE_HEADER_NAMES) {
    const value = headers?.[name];
    if (value != null) observed[name] = truncate(value, 160);
  }
  return observed;
}

function recordProvenance(state, response) {
  if (state.provenance.sourceGeneration) return;
  if (!isDataReadUrl(response.url(), state.origin)) return;
  const headers = response.headers();
  for (const name of GENERATION_HEADER_NAMES) {
    const value = headers?.[name];
    if (value) {
      state.provenance.sourceGeneration = truncate(value, 160);
      state.provenance.source = `response-header:${name}`;
      return;
    }
  }
}

/** Keep analytics script cost in the budget without recording synthetic visits. */
export async function blockAnalyticsCollection(page, counters, intentional = {}) {
  await page.route(
    (url) =>
      ["google-analytics.com", "analytics.google.com", "google.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      ) && ["/collect", "/g/collect", "/j/collect", "/mp/collect", "/debug/mp/collect", "/batch"].includes(url.pathname),
    async (route) => {
      counters.blockedAnalyticsRequests += 1;
      const url = route.request().url();
      intentional.analyticsUrls?.add(url);
      await route.abort();
    },
  );
}

function addResponse(counters, response) {
  const type = classifyResource(response.url(), response.request().resourceType());
  const contentLength = Number.parseInt(response.headers()["content-length"] ?? "0", 10);
  const knownBytes = Number.isFinite(contentLength) ? contentLength : 0;

  counters.requests += 1;
  counters.knownContentLengthBytes += knownBytes;

  if (type === "script") {
    counters.scriptRequests += 1;
    counters.scriptKnownBytes += knownBytes;
  } else if (type === "style") {
    counters.styleRequests += 1;
    counters.styleKnownBytes += knownBytes;
  } else if (type === "font") {
    counters.fontRequests += 1;
    counters.fontKnownBytes += knownBytes;
  } else if (type === "image") {
    counters.imageRequests += 1;
  } else if (type === "siteData") {
    counters.siteDataRequests += 1;
  }
}

function addPerformanceResource(counters, resource) {
  const observedBytes = Math.max(resource.transferSize ?? 0, resource.encodedBodySize ?? 0);
  if (!Number.isFinite(observedBytes) || observedBytes <= 0) return;

  const type = classifyResource(resource.name, resource.initiatorType);
  counters.observedTransferBytes += observedBytes;
  if (type === "script") {
    counters.scriptObservedBytes += observedBytes;
  } else if (type === "style") {
    counters.styleObservedBytes += observedBytes;
  } else if (type === "font") {
    counters.fontObservedBytes += observedBytes;
  }
}

function recordResponseFailure(state, response) {
  const status = response.status();
  if (status < 400) return;
  const headers = response.headers();
  if (headers?.[REPLAY_INJECTION_HEADER] === "api-failure-replay") return;
  const url = response.url();
  const resourceType = response.request().resourceType();
  if (isDataReadUrl(url, state.origin)) {
    state.failures.httpData.push({
      url,
      status,
      resourceType,
      headers: pickProvenanceHeaders(headers),
    });
  } else if (resourceType === "script") {
    state.failures.failedRequests.push({ url, resourceType, failure: `http-${status}` });
  }
}

/**
 * Bucket page errors, failed requests and failing data reads. Analytics
 * suppression is an intentional block, not an unexpected production failure.
 */
export function installFailureListeners(page, state) {
  page.on("pageerror", (error) => {
    state.failures.pageErrors.push({ message: truncate(error?.message ?? String(error)) });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (state.intentional?.analyticsUrls?.has(url) || state.intentional?.replayUrls?.has(url)) return;
    state.failures.failedRequests.push({
      url,
      resourceType: request.resourceType(),
      failure: truncate(request.failure()?.errorText ?? null),
    });
  });
  page.on("response", (response) => {
    try {
      addResponse(state.counters, response);
    } catch (error) {
      // Best-effort audit; individual response accounting should not abort the route.
      state.counters.accountingErrors += 1;
      if (process.env.DEBUG) {
        console.warn(
          `[seo-render-budget] response accounting failed for ${response.url()}: ${formatError(error)}`,
        );
      }
    }
    recordResponseFailure(state, response);
    recordProvenance(state, response);
  });
}

async function fetchHtml(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "PharosSeoRenderBudgetAudit/1.0",
    },
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  const html = await response.text();
  return {
    html,
    status: response.status,
    htmlBytes: byteLength(html),
    cacheControl: response.headers.get("cache-control") ?? "",
    cdnCacheControl: response.headers.get("cdn-cache-control") ?? "",
    cfCacheStatus: response.headers.get("cf-cache-status") ?? "",
    contentType: response.headers.get("content-type") ?? "",
  };
}

/**
 * Parse already-fetched bytes as DOM in an isolated, JS-disabled page. Every
 * resource request is blocked before `setContent`, so raw capture neither
 * hydrates nor opens a second outbound fetch fan-out.
 */
export async function captureRawSnapshot(browser, url, html) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    javaScriptEnabled: false,
  });
  let blockedRequests = 0;
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      blockedRequests += 1;
      await route.abort();
    });
    await page.setContent(html, { timeout: CAPTURE_TIMEOUT_MS });
    const snapshot = await page.evaluate(buildCollectExpression({
      documentUrl: url,
      viewport: MOBILE_VIEWPORT,
      visibleTextMode: "raw",
    }));
    return { snapshot, blockedRequests };
  } finally {
    await context.close();
  }
}

async function collectHydratedSnapshot(page, url, viewport) {
  return page.evaluate(buildCollectExpression({
    documentUrl: url,
    viewport,
    visibleTextMode: "styled",
  }));
}

/** Install a 503 API-failure replay before navigation; static assets pass through. */
export function createApiFailureReplayHandler({ origin, failures, intentional }) {
  return async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    if (isDataReadUrl(requestUrl, origin)) {
      intentional.replayUrls?.add(requestUrl);
      failures.intentionalBlocks.push({ kind: "api-failure-replay", url: requestUrl, status: 503 });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          [REPLAY_INJECTION_HEADER]: "api-failure-replay",
        },
        body: REPLAY_INJECTION_BODY,
      });
      return;
    }
    await route.fallback();
  };
}

export async function capturePageSnapshots(browser, url, { waitMs, counters, failures, provenance, replay = false, origin }) {
  const intentional = { analyticsUrls: new Set(), replayUrls: new Set() };
  const state = { counters, failures, intentional, provenance, origin };
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    javaScriptEnabled: true,
  });
  try {
    const page = await context.newPage();
    installFailureListeners(page, state);
    await blockAnalyticsCollection(page, counters, intentional);
    if (replay) {
      await page.route("**/*", createApiFailureReplayHandler({ origin, failures, intentional }));
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT_MS });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const mobile = await collectHydratedSnapshot(page, url, MOBILE_VIEWPORT);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return null;
      return {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
        responseStartMs: Math.round(nav.responseStart),
      };
    }).catch(() => null);
    const resources = (await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: "transferSize" in entry ? entry.transferSize : 0,
        encodedBodySize: "encodedBodySize" in entry ? entry.encodedBodySize : 0,
      })),
    ).catch(() => [])) ?? [];
    for (const resource of resources) {
      addPerformanceResource(counters, resource);
    }
    const title = await page.title();

    await page.setViewportSize(TALL_VIEWPORT);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const tall = await collectHydratedSnapshot(page, url, TALL_VIEWPORT);

    return { mobile, tall, timing, title, intentional };
  } finally {
    await context.close();
  }
}

/** A route that could not be acquired at all still gets one bounded row. */
export function failedRouteRow(route, url, error) {
  return {
    route,
    url,
    title: null,
    elapsedMs: 0,
    mainTextChars: null,
    status: null,
    htmlBytes: null,
    cacheControl: "",
    cdnCacheControl: "",
    cfCacheStatus: "",
    contentType: "",
    ...emptyCounters(),
    timing: null,
    captureStatus: "failed",
    captureReason: `unrecoverable-capture-failure: ${formatError(error)}`,
    snapshots: { raw: null, mobile: null, tall: null },
    hrefLoss: { mobile: null, tall: null },
    failures: emptyFailures(),
    sentinels: [],
    apiFailureReplay: null,
  };
}

async function runApiFailureReplay(browser, url, { waitMs, baseline, origin, surface, expectations = null }) {
  const counters = emptyCounters();
  const failures = emptyFailures();
  const provenance = { sourceGeneration: null, source: null };
  try {
    const captured = await capturePageSnapshots(browser, url, {
      waitMs,
      counters,
      failures,
      provenance,
      replay: true,
      origin,
    });
    const snapshots = { raw: baseline.raw, mobile: captured.mobile, tall: captured.tall };
    const hrefLoss = {
      mobile: diffInternalHrefs(baseline.raw?.internalHrefs, captured.mobile?.internalHrefs),
      tall: diffInternalHrefs(baseline.raw?.internalHrefs, captured.tall?.internalHrefs),
    };
    if (captured.intentional.analyticsUrls.size > 0) {
      failures.intentionalBlocks.push({ kind: "analytics-suppression", count: captured.intentional.analyticsUrls.size });
    }
    const sourceGeneration = provenance.sourceGeneration
      ?? captured.mobile?.observedDates?.find((date) => date.datetime)?.datetime
      ?? null;
    return {
      status: "complete",
      reason: null,
      snapshots,
      hrefLoss,
      failures,
      counters,
      injectedApiFailures: captured.intentional.replayUrls.size,
      sentinels: evaluateSentinels({
        surface,
        snapshots,
        hrefLoss,
        captureStatus: "complete",
        replay: true,
        baseline,
        sourceGeneration,
        expectations,
      }),
    };
  } catch (error) {
    return {
      status: "failed",
      reason: `replay-capture-failed: ${formatError(error)}`,
      snapshots: { raw: baseline.raw, mobile: null, tall: null },
      hrefLoss: { mobile: null, tall: null },
      failures,
      counters,
      injectedApiFailures: 0,
      sentinels: [],
    };
  }
}

export async function auditRoute(browser, baseUrl, route, options = {}) {
  const url = resolveRoute(baseUrl, route);
  const origin = new URL(baseUrl).origin;
  const surface = classifyRouteSurface(route);
  const counters = emptyCounters();
  const failures = emptyFailures();
  const provenance = { sourceGeneration: null, source: null };
  const started = Date.now();
  const row = {
    route,
    url,
    title: null,
    elapsedMs: 0,
    mainTextChars: null,
    status: null,
    htmlBytes: null,
    cacheControl: "",
    cdnCacheControl: "",
    cfCacheStatus: "",
    contentType: "",
    ...counters,
    timing: null,
    captureStatus: "incomplete",
    captureReason: null,
    snapshots: { raw: null, mobile: null, tall: null },
    hrefLoss: { mobile: null, tall: null },
    failures,
    sentinels: [],
    apiFailureReplay: null,
  };

  const fetchHtmlImpl = options.fetchHtmlImpl ?? fetchHtml;
  const captureRawSnapshotImpl = options.captureRawSnapshotImpl ?? captureRawSnapshot;
  const capturePageSnapshotsImpl = options.capturePageSnapshotsImpl ?? capturePageSnapshots;
  const replayImpl = options.runApiFailureReplayImpl ?? runApiFailureReplay;
  const waitMs = options.waitMs ?? Number(DEFAULT_WAIT_MS);
  let fetchedHtml = null;

  try {
    const { html, ...metadata } = await fetchHtmlImpl(url);
    fetchedHtml = html;
    Object.assign(row, metadata);
  } catch (error) {
    row.captureReason = `raw-fetch-failed: ${formatError(error)}`;
  }

  let offlineParseBlocks = 0;
  if (fetchedHtml != null) {
    try {
      const raw = await captureRawSnapshotImpl(browser, url, fetchedHtml);
      row.snapshots.raw = raw.snapshot;
      offlineParseBlocks = raw.blockedRequests;
    } catch (error) {
      row.captureReason = [row.captureReason, `raw-parse-failed: ${formatError(error)}`].filter(Boolean).join("; ");
    }
  }

  try {
    const captured = await capturePageSnapshotsImpl(browser, url, { waitMs, counters, failures, provenance, origin });
    row.snapshots.mobile = captured.mobile;
    row.snapshots.tall = captured.tall;
    row.timing = captured.timing;
    row.title = captured.title;
    row.mainTextChars = captured.mobile?.mainDomTextChars ?? null;
    row.captureStatus = "complete";
  } catch (error) {
    row.captureStatus = "failed";
    row.captureReason = [row.captureReason, `browser-capture-failed: ${formatError(error)}`].filter(Boolean).join("; ");
  }

  if (row.captureStatus !== "failed") {
    const missing = [];
    if (!row.snapshots.raw) missing.push("raw");
    if (!row.snapshots.mobile) missing.push("mobile");
    if (!row.snapshots.tall) missing.push("tall");
    row.captureStatus = missing.length === 0 ? "complete" : "incomplete";
    if (missing.length > 0) {
      row.captureReason = [row.captureReason, `missing-observations: ${missing.join(",")}`].filter(Boolean).join("; ");
    }
  }

  if (row.captureStatus === "complete") row.captureReason = null;

  row.hrefLoss.mobile = diffInternalHrefs(row.snapshots.raw?.internalHrefs, row.snapshots.mobile?.internalHrefs);
  row.hrefLoss.tall = diffInternalHrefs(row.snapshots.raw?.internalHrefs, row.snapshots.tall?.internalHrefs);

  if (counters.blockedAnalyticsRequests > 0) {
    failures.intentionalBlocks.push({ kind: "analytics-suppression", count: counters.blockedAnalyticsRequests });
  }
  if (offlineParseBlocks > 0) {
    failures.intentionalBlocks.push({ kind: "offline-raw-parser", count: offlineParseBlocks });
  }

  const sourceGeneration = provenance.sourceGeneration
    ?? row.snapshots.mobile?.observedDates?.find((date) => date.datetime)?.datetime
    ?? null;
  row.sourceGeneration = sourceGeneration;
  row.sourceGenerationSource = provenance.source ?? (sourceGeneration ? "dom:time[datetime]" : null);
  const expectations = getRouteExpectations(route);

  row.sentinels = evaluateSentinels({
    surface,
    snapshots: row.snapshots,
    hrefLoss: row.hrefLoss,
    captureStatus: row.captureStatus,
    sourceGeneration,
    expectations,
  });

  if (options.apiFailureReplay === true) {
    const replayBaseline = { raw: row.snapshots.raw, mobile: row.snapshots.mobile, tall: row.snapshots.tall };
    row.apiFailureReplay = isReplayEligibleRoute(route)
      ? await replayImpl(browser, url, { waitMs, baseline: replayBaseline, origin, surface, expectations })
      : { status: "not-applicable", reason: "route-not-replay-eligible", snapshots: null, hrefLoss: null, sentinels: [], failures: emptyFailures(), counters: emptyCounters(), injectedApiFailures: 0 };
  }

  Object.assign(row, counters);
  row.elapsedMs = Date.now() - started;
  return row;
}

export function formatTable(rows) {
  const headers = [
    "route",
    "status",
    "htmlKB",
    "mainChars",
    "req",
    "acctErr",
    "gaBlocked",
    "jsReq",
    "cssReq",
    "fontReq",
    "siteData",
    "byteKB",
    "cfCache",
    "capture",
    "missing",
    "notObs",
    "hrefLost",
    "dataFail",
    "inject",
  ];
  const lines = [headers.join("\t")];
  for (const row of rows) {
    const sentinels = Array.isArray(row.sentinels) ? row.sentinels : [];
    const hrefLoss = (row.hrefLoss?.mobile?.length ?? 0) + (row.hrefLoss?.tall?.length ?? 0);
    const dataFailures = (row.failures?.httpData?.length ?? 0)
      + (row.failures?.failedRequests?.length ?? 0)
      + (row.failures?.pageErrors?.length ?? 0);
    const injections = (row.failures?.intentionalBlocks ?? [])
      .filter((block) => block.kind === "api-failure-replay")
      .length;
    lines.push(
      [
        row.route,
        row.status,
        Math.round((row.htmlBytes ?? 0) / 1024),
        row.mainTextChars,
        row.requests ?? 0,
        row.accountingErrors ?? 0,
        row.blockedAnalyticsRequests ?? 0,
        row.scriptRequests ?? 0,
        row.styleRequests ?? 0,
        row.fontRequests ?? 0,
        row.siteDataRequests ?? 0,
        Math.round(((row.htmlBytes ?? 0) + Math.max(row.knownContentLengthBytes ?? 0, row.observedTransferBytes ?? 0)) / 1024),
        row.cfCacheStatus || "-",
        row.captureStatus,
        sentinels.filter((entry) => entry.status === "missing").length,
        sentinels.filter((entry) => entry.status === "not-observed").length,
        hrefLoss,
        dataFailures,
        injections,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

/** One row per requested route; an unrecoverable capture never drops later rows. */
export async function collectAuditRows(browser, baseUrl, routes, options = {}, { auditRouteImpl = auditRoute } = {}) {
  const rows = [];
  let unrecoverable = false;
  for (const route of routes) {
    try {
      const row = await auditRouteImpl(browser, baseUrl, route, options);
      if (row?.captureStatus === "failed" || row?.apiFailureReplay?.status === "failed") unrecoverable = true;
      rows.push(row);
    } catch (error) {
      unrecoverable = true;
      rows.push(failedRouteRow(route, resolveRoute(baseUrl, route), error));
    }
  }
  return { rows, unrecoverable };
}

export async function runSeoRenderBudget(argv = process.argv.slice(2)) {
  const args = parseSeoRenderBudgetArgs(argv);
  if (args.help) {
    console.log(SEO_RENDER_BUDGET_HELP);
    return;
  }
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const chromium = await loadChromium();
  const browser = await chromium.launch(getBrowserLaunchOptions({
    SMOKE_UI_BROWSER_EXECUTABLE_PATH: process.env.SEO_AUDIT_BROWSER_EXECUTABLE_PATH,
    SMOKE_UI_BROWSER_CHANNEL: process.env.SEO_AUDIT_BROWSER_CHANNEL,
  }));

  try {
    const { rows, unrecoverable } = await collectAuditRows(browser, baseUrl, args.routes, {
      waitMs: args.waitMs,
      apiFailureReplay: args.apiFailureReplay,
    });

    if (args.json) {
      console.log(JSON.stringify({
        baseUrl: baseUrl.toString(),
        generatedAt: new Date().toISOString(),
        apiFailureReplay: args.apiFailureReplay,
        unenrolledExpectations: UNENROLLED_SENTINEL_EXPECTATIONS,
        rows,
      }, null, 2));
    } else {
      console.log(formatTable(rows));
    }
    if (unrecoverable) process.exitCode = 1;
    return rows;
  } finally {
    await browser.close();
  }
}

runDirectCli(import.meta.url, runSeoRenderBudget);
