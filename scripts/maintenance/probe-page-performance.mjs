#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeFileResolved } from "../lib/cli-args.mjs";

export const VIEWPORTS = [
  { width: 1440, height: 1000, dpr: 1 },
  { width: 1920, height: 960, dpr: 2 },
  { width: 2560, height: 1300, dpr: 1.5 },
  { width: 3072, height: 1600, dpr: 1.25 },
  { width: 390, height: 844, dpr: 3 },
];
export const LONG_DWELL_VIEWPORT = VIEWPORTS[3];
export const MOBILE_ONLY_ROUTES = ["/depeg/", "/safety-scores/", "/stablecoins/"];
// Regression tripwires, not proof of production performance targets.
export const BUDGETS = { jsonBytes: 40_000_000, requests: 450, v9WaitMs: 20_000, bannerClearMs: 25_000, cls: 0.5, clsMobile: 0.10 };
// Failure evidence stays bounded and query-free; success bodies and credentials
// are never retained.
export const MAX_DIAGNOSTIC_ERRORS = 20;
export const MAX_DIAGNOSTIC_BODY_BYTES = 4 * 1024;
/** Query-independent V9 route identity: full, table and detail are distinct routes. */
const V9_ROUTE_FAMILIES = new Map([
  ["/api/report-cards/v9", "v9"],
  ["/api/report-cards/v9-table", "v9-table"],
  ["/api/report-cards/v9-detail", "v9-detail"],
]);
/** Same-origin coin-scoped transports whose failures need a body reason. */
const SCOPED_ROUTE_FAMILIES = new Map([
  ["/api/yield-rankings-coin", "yield-rankings-coin"],
  ["/api/dex-liquidity-coin", "dex-liquidity-coin"],
  ["/api/redemption-backstop-coin", "redemption-backstop-coin"],
  ["/api/report-cards/v9-detail", "report-cards/v9-detail"],
]);
const DIAGNOSTIC_HEADERS = [
  "age",
  "cache-control",
  "date",
  "etag",
  "retry-after",
  "x-data-age",
  "x-data-assessed-at",
  "x-data-freshness",
  "x-data-freshness-budget",
  "x-data-freshness-reason",
  "x-data-updated-at",
  "x-safety-score-assessed-at",
  "x-safety-score-freshness-budget",
  "x-safety-score-generation",
  "x-safety-score-status",
  "x-safety-score-updated-at",
];
const DIAGNOSTIC_REASON = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
let registryCoinIds = null;

function requestUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** Map the public `/_site-data/*` same-origin hop onto its upstream API path. */
function upstreamPathname(pathname) {
  return pathname.startsWith("/_site-data/")
    ? `/api${pathname.slice("/_site-data".length)}`
    : pathname;
}

function routePathname(rawUrl) {
  const url = requestUrl(rawUrl);
  if (!url) return null;
  const pathname = upstreamPathname(url.pathname);
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function v9RouteFamily(rawUrl) {
  const pathname = routePathname(rawUrl);
  return pathname === null ? null : V9_ROUTE_FAMILIES.get(pathname) ?? null;
}

export function scopedRouteFamily(rawUrl) {
  const pathname = routePathname(rawUrl);
  return pathname === null ? null : SCOPED_ROUTE_FAMILIES.get(pathname) ?? null;
}

/** The checked-in canonical order is the registry identity list available to a plain Node script. */
function loadRegistryCoinIds() {
  if (registryCoinIds !== null) return registryCoinIds;
  try {
    const raw = readFileSync(new URL("../../shared/data/stablecoins/canonical-order.json", import.meta.url), "utf8");
    const ids = JSON.parse(raw);
    registryCoinIds = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    registryCoinIds = new Set();
  }
  return registryCoinIds;
}

export function validatedCoinId(rawUrl) {
  const url = requestUrl(rawUrl);
  const candidate = url?.searchParams.get("stablecoin") ?? null;
  return candidate !== null && loadRegistryCoinIds().has(candidate) ? candidate : "unknown";
}

/** Parse only the whitelisted `reason` field from a bounded error body. */
export function parseDiagnosticReason(text) {
  try {
    const parsed = JSON.parse(text);
    const reason = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.reason
      : undefined;
    if (reason === undefined) return { reason: null, malformed: false };
    return typeof reason === "string" && DIAGNOSTIC_REASON.test(reason)
      ? { reason, malformed: false }
      : { reason: null, malformed: true };
  } catch {
    return { reason: null, malformed: true };
  }
}

/** @param {Record<string, string | undefined>} [env] */
export function captureReleaseIdentity(env = process.env) {
  const commit = env.GITHUB_SHA?.trim() || null;
  const runId = env.GITHUB_RUN_ID?.trim() || null;
  const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim() || null;
  return commit || runId || runAttempt ? { commit, runId, runAttempt } : null;
}

function isFailedSameOriginScoped(rawUrl, status, origin) {
  const url = requestUrl(rawUrl);
  return url !== null && typeof status === "number" && status >= 400
    && url.origin === origin && url.pathname.startsWith("/_site-data/")
    && scopedRouteFamily(rawUrl) !== null;
}

function pickDiagnosticHeaders(headers = {}) {
  const picked = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (DIAGNOSTIC_HEADERS.includes(key) && typeof value === "string") picked[key] = value;
  }
  return picked;
}

async function readDiagnosticBody(cdp, requestId) {
  try {
    const { body, base64Encoded } = await cdp.send("Network.getResponseBody", { requestId });
    if (typeof body !== "string") return { status: "failed", truncated: false, error: "response body unavailable", text: null };
    const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
    return {
      status: "read",
      truncated: bytes.length > MAX_DIAGNOSTIC_BODY_BYTES,
      text: bytes.subarray(0, MAX_DIAGNOSTIC_BODY_BYTES).toString("utf8"),
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      truncated: false,
      text: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 200),
    };
  }
}

/** Read only already-observed error bodies; never re-fetches and never records success payloads. */
export async function collectScopedFailureDiagnostics(cdp, records, origin, identity = {}) {
  const candidates = [];
  for (const [requestId, row] of records) {
    if (!isFailedSameOriginScoped(row.url, row.status, origin)) continue;
    candidates.push({ requestId, row });
  }
  const selected = candidates.slice(0, MAX_DIAGNOSTIC_ERRORS);
  const diagnostics = [];
  for (const { requestId, row } of selected) {
    const body = await readDiagnosticBody(cdp, requestId);
    const parsed = body.text === null ? { reason: null, malformed: false } : parseDiagnosticReason(body.text);
    const url = requestUrl(row.url);
    diagnostics.push({
      endpoint: url.pathname,
      coinId: validatedCoinId(row.url),
      status: row.status,
      reason: parsed.reason,
      reasonMalformed: parsed.malformed,
      retryAfter: row.headers?.["retry-after"] ?? null,
      served: row.headers ?? {},
      responseTimeMs: row.responseAt === undefined ? null : Math.round((row.responseAt - row.start) * 1000),
      body: { status: body.status, truncated: body.truncated, error: body.error },
      capturedAt: identity.capturedAt ?? null,
      release: identity.release ?? null,
    });
  }
  return { observed: candidates.length, omitted: candidates.length - selected.length, diagnostics };
}

export function sessionCls(entries) {
  let maximum = 0, sum = 0, first = null, last = null;
  for (const { time, value } of entries) {
    if (first === null || last === null || time - last >= 1000 || time - first >= 5000) { first = time; sum = 0; }
    sum += value;
    last = time;
    maximum = Math.max(maximum, sum);
  }
  return maximum;
}

function installObservers() {
  const state = window.__pharosPerf = { shifts: [], bannerSeenAt: null, bannerClearAt: null, bannerVisible: false };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) state.shifts.push({ time: entry.startTime, value: entry.value });
    }
  }).observe({ type: "layout-shift", buffered: true });
  setInterval(() => {
    if (!document.body) return;
    const visible = [...document.querySelectorAll('[data-health-state], [role="status"]')].some((node) => {
      const health = node.getAttribute("data-health-state");
      return (health != null ? health !== "fresh"
        : /older snapshot|Refresh failed|Refreshing.*saved data|Waiting for.*data|catching up|quality warning/i.test(node.textContent ?? ""))
        && node.getBoundingClientRect().height > 0;
    });
    if (visible && state.bannerSeenAt === null) state.bannerSeenAt = performance.now();
    if (state.bannerVisible && !visible && state.bannerClearAt === null) state.bannerClearAt = performance.now();
    state.bannerVisible = visible;
  }, 50);
}

export function violations(row) {
  const failures = [];
  for (const [key, budget] of Object.entries(BUDGETS)) {
    if (key === "clsMobile") continue;
    // Only cumulative transfer/request totals outgrow initial-load ceilings.
    if (row.dwellMs > 60_000 && (key === "jsonBytes" || key === "requests")) continue;
    if (key === "cls") {
      if (row.bannerVisible) continue;
      const mobile = row.viewport?.width < 500;
      const limit = mobile ? BUDGETS.clsMobile : budget;
      const confirmation = row.clsConfirmation;
      if (row.cls > limit && (!confirmation || (!confirmation.bannerVisible && confirmation.cls > limit))) {
        failures.push(`${mobile ? "clsMobile" : key}=${row.cls}${confirmation ? ` (re-capture ${confirmation.cls})` : ""} > ${limit}`);
      }
      continue;
    }
    if (row[key] !== null && row[key] > budget) failures.push(`${key}=${row[key]} > ${budget}`);
  }
  if (row.bannerVisible) failures.push("detail banner still visible at observation end (not proof of a performance defect; inspect producer health)");
  if (row.failedRequests) failures.push(`${row.failedRequests} JSON requests failed`);
  if (row.clsConfirmation) failures.push(...row.clsConfirmation.violations
    .filter((failure) => !failure.startsWith("clsMobile="))
    .map((failure) => `CLS re-capture: ${failure}`));
  return failures;
}

export async function capture(browser, origin, route, viewport, dwellMs, confirmMobileCls = true) {
  const originRoot = new URL(origin).origin;
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr, isMobile: viewport.width < 500 });
  let row;
  try {
    await context.addInitScript(installObservers);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Performance.enable");
    const records = new Map();
    cdp.on("Network.requestWillBeSent", (e) => records.set(e.requestId, { url: e.request.url, start: e.timestamp, decoded: 0 }));
    cdp.on("Network.responseReceived", (e) => {
      const row = records.get(e.requestId);
      if (!row) return;
      Object.assign(row, { mime: e.response.mimeType, status: e.response.status, responseAt: e.timestamp });
      if (isFailedSameOriginScoped(row.url, e.response.status, originRoot)) {
        row.headers = pickDiagnosticHeaders(e.response.headers);
      }
    });
    cdp.on("Network.dataReceived", (e) => { const row = records.get(e.requestId); if (row) row.decoded += e.dataLength; });
    cdp.on("Network.loadingFinished", (e) => { const row = records.get(e.requestId); if (row) row.end = e.timestamp; });
    cdp.on("Network.loadingFailed", (e) => { const row = records.get(e.requestId); if (row) row.error = e.errorText; });
    const response = await page.goto(new URL(route, origin).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (response?.status() !== 200) throw new Error(`${route}: expected direct 200, received ${response?.status()}`);
    const heapSamples = [];
    const deadline = Date.now() + dwellMs;
    do {
      await page.waitForTimeout(Math.min(10_000, Math.max(1, deadline - Date.now())));
      const { metrics } = await cdp.send("Performance.getMetrics");
      heapSamples.push({ elapsedMs: await page.evaluate(() => performance.now()), bytes: metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null });
    } while (Date.now() < deadline);
    const state = await page.evaluate(() => window.__pharosPerf);
    const capturedAt = new Date().toISOString();
    const release = captureReleaseIdentity();
    // Settle already-observed error-body reads before the context closes; this
    // uses CDP buffers and never issues another request.
    let scopedFailures;
    try {
      scopedFailures = await collectScopedFailureDiagnostics(cdp, records, originRoot, { capturedAt, release });
    } catch (error) {
      scopedFailures = { observed: null, omitted: null, diagnostics: [],
        error: String(error instanceof Error ? error.message : error).slice(0, 200) };
    }
    const requests = [...records.values()];
    const json = requests.filter((row) => /json/i.test(row.mime ?? "") || /\/(?:_site-data|api)\//.test(new URL(row.url).pathname));
    const v9 = requests.filter((row) => v9RouteFamily(row.url) !== null);
    const waits = v9.filter((row) => row.responseAt !== undefined).map((row) => (row.responseAt - row.start) * 1000);
    row = { route, viewport, dwellMs, capturedAt, release,
      jsonBytes: json.reduce((sum, r) => sum + r.decoded, 0), requests: records.size,
      failedRequests: json.filter((r) => r.error || r.status >= 400 || r.end === undefined).length,
      v9Requests: v9.length, v9WaitMs: waits.length ? Math.max(...waits) : null,
      bannerClearMs: state.bannerClearAt, bannerSeenMs: state.bannerSeenAt, bannerVisible: state.bannerVisible,
      cls: sessionCls(state.shifts), heapBytes: heapSamples.at(-1)?.bytes ?? null, heapSamples, resources: requests,
      scopedDiagnostics: scopedFailures.diagnostics, scopedDiagnosticsOmitted: scopedFailures.omitted,
      scopedDiagnosticsError: scopedFailures.error ?? null };
  } finally { await context.close(); }
  let clsConfirmation;
  if (confirmMobileCls && viewport.width < 500 && !row.bannerVisible && row.cls > BUDGETS.clsMobile) {
    clsConfirmation = await capture(browser, origin, route, viewport, dwellMs, false);
  }
  const result = { ...row, clsConfirmation };
  return { ...result, violations: violations(result) };
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    url: { type: "string", default: "https://pharos.watch" }, out: { type: "string", default: ".tmp/page-performance.json" },
    "dwell-seconds": { type: "string" }, advisory: { type: "boolean" },
  } });
  if (values.help) { console.log("Usage: node scripts/maintenance/probe-page-performance.mjs [--url URL] [--out FILE] [--dwell-seconds 1800] [--advisory]\nCold no-scroll home/detail captures at five viewport/DPR pairs, plus mobile depeg/safety-scores/stablecoins; one confirm re-capture for mobile CLS breaches; optional single wide-home dwell capture."); return; }
  const origin = new URL(String(values.url));
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("--url must use HTTP(S)");
  const dwellMs = values["dwell-seconds"] === undefined ? undefined
    : parseCliInteger(values["dwell-seconds"], { name: "--dwell-seconds", min: 60, max: 3600 }) * 1000;
  const browser = await chromium.launch({ headless: true });
  const rows = [];
  try {
    for (const viewport of VIEWPORTS) for (const route of ["/", "/stablecoin/usdt-tether/", ...(viewport.width < 500 ? MOBILE_ONLY_ROUTES : [])]) {
      rows.push(await capture(browser, origin, route, viewport, 30_000));
    }
    if (dwellMs !== undefined) rows.push(await capture(browser, origin, "/", LONG_DWELL_VIEWPORT, dwellMs));
  } finally { await browser.close(); }
  writeFileResolved(String(values.out), JSON.stringify({ capturedAt: new Date().toISOString(), release: captureReleaseIdentity(), budgets: BUDGETS, rows }, null, 2));
  const summary = ["## Production page performance", "Decoded JSON is browser-delivered CDP body bytes (not heap); V9 wait is request→headers. Missing V9/banner timings mean not observed, never zero/fresh. Banner disappearance is not proof all data is fresh. CLS is the maximum 5-second session window.",
    `Regression budgets: ${JSON.stringify(BUDGETS)}. ${values.advisory ? "Advisory" : "Blocking"}.`,
    "Dwell captures over 60 seconds omit only cumulative JSON-byte/request-count ceilings; failed JSON, banner, CLS and per-request timing checks remain blocking.",
    "Mobile CLS uses one fresh-context re-capture and fails only when both exceed its budget. A visible data-health banner fails producer health instead of CLS; re-capture correctness failures remain blocking.",
    `Failed same-origin scoped responses retain endpoint, validated registry coin ID, status, whitelisted JSON reason, Retry-After, served generation/clock headers and response time (at most ${MAX_DIAGNOSTIC_ERRORS} per capture, error bodies only, at most ${MAX_DIAGNOSTIC_BODY_BYTES} bytes). Missing evidence is not an empty result; omitted/truncated/read-failed diagnostics are recorded explicitly.`,
    "| Route | Viewport @ DPR | Dwell s | JSON bytes | Requests | V9 wait ms | Banner clear ms | CLS | CLS re-capture | JS heap bytes | Result |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((r) => `| ${r.route} | ${r.viewport.width}×${r.viewport.height}@${r.viewport.dpr} | ${r.dwellMs / 1000} | ${r.jsonBytes} | ${r.requests} | ${r.v9WaitMs?.toFixed(0) ?? "not observed"} | ${r.bannerClearMs?.toFixed(0) ?? "not observed"} | ${r.cls.toFixed(4)} | ${r.clsConfirmation?.cls.toFixed(4) ?? "not needed"} | ${r.heapBytes ?? "unknown"} | ${r.violations.join("; ") || "within observed budgets"} |`), ""].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!values.advisory && rows.some((r) => r.violations.length)) throw new Error("Production performance budgets exceeded; inspect JSON artifact and producer health.");
});
