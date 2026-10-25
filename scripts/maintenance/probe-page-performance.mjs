#!/usr/bin/env node

import { appendFileSync } from "node:fs";
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
      if (row) Object.assign(row, { mime: e.response.mimeType, status: e.response.status, responseAt: e.timestamp });
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
    const requests = [...records.values()];
    const json = requests.filter((row) => /json/i.test(row.mime ?? "") || /\/(?:_site-data|api)\//.test(new URL(row.url).pathname));
    const v9 = requests.filter((row) => /\/report-cards\/v9(?:\/|\?|$)/.test(row.url));
    const waits = v9.filter((row) => row.responseAt !== undefined).map((row) => (row.responseAt - row.start) * 1000);
    row = { route, viewport, dwellMs, jsonBytes: json.reduce((sum, r) => sum + r.decoded, 0), requests: records.size,
      failedRequests: json.filter((r) => r.error || r.status >= 400 || r.end === undefined).length,
      v9Requests: v9.length, v9WaitMs: waits.length ? Math.max(...waits) : null,
      bannerClearMs: state.bannerClearAt, bannerSeenMs: state.bannerSeenAt, bannerVisible: state.bannerVisible,
      cls: sessionCls(state.shifts), heapBytes: heapSamples.at(-1)?.bytes ?? null, heapSamples, resources: requests };
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
  writeFileResolved(String(values.out), JSON.stringify({ capturedAt: new Date().toISOString(), budgets: BUDGETS, rows }, null, 2));
  const summary = ["## Production page performance", "Decoded JSON is browser-delivered CDP body bytes (not heap); V9 wait is request→headers. Missing V9/banner timings mean not observed, never zero/fresh. Banner disappearance is not proof all data is fresh. CLS is the maximum 5-second session window.",
    `Regression budgets: ${JSON.stringify(BUDGETS)}. ${values.advisory ? "Advisory" : "Blocking"}.`,
    "Dwell captures over 60 seconds omit only cumulative JSON-byte/request-count ceilings; failed JSON, banner, CLS and per-request timing checks remain blocking.",
    "Mobile CLS uses one fresh-context re-capture and fails only when both exceed its budget. A visible data-health banner fails producer health instead of CLS; re-capture correctness failures remain blocking.",
    "| Route | Viewport @ DPR | Dwell s | JSON bytes | Requests | V9 wait ms | Banner clear ms | CLS | CLS re-capture | JS heap bytes | Result |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((r) => `| ${r.route} | ${r.viewport.width}×${r.viewport.height}@${r.viewport.dpr} | ${r.dwellMs / 1000} | ${r.jsonBytes} | ${r.requests} | ${r.v9WaitMs?.toFixed(0) ?? "not observed"} | ${r.bannerClearMs?.toFixed(0) ?? "not observed"} | ${r.cls.toFixed(4)} | ${r.clsConfirmation?.cls.toFixed(4) ?? "not needed"} | ${r.heapBytes ?? "unknown"} | ${r.violations.join("; ") || "within observed budgets"} |`), ""].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!values.advisory && rows.some((r) => r.violations.length)) throw new Error("Production performance budgets exceeded; inspect JSON artifact and producer health.");
});
