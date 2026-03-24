#!/usr/bin/env node

import { execFile } from "child_process";
import { rmSync } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI_PREFIX = ["--yes", "--package", "@playwright/cli", "playwright-cli"];
const DEFAULT_URL = process.env.SMOKE_UI_URL ?? "https://pharos.watch";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SESSION_PREFIX = "prod-ui-smoke";
const DEFAULT_UI_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_UI_RETRY_COUNT = 1;
const DEFAULT_UI_RETRY_DELAY_MS = 1500;
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const DEFAULT_OVERFLOW_WAIT_MS = 2000;
const DEFAULT_OVERFLOW_SETTLE_SAMPLES = 4;
const DEFAULT_OVERFLOW_SAMPLE_INTERVAL_MS = 350;
const DEFAULT_STYLE_READY_TIMEOUT_MS = 4000;
const DEFAULT_OVERFLOW_RETRY_EXTRA_WAIT_MS = 2000;
const OVERFLOW_ROUTE_DEFAULTS = [
  "/",
  "/dependency-map/",
  "/flows/",
  "/yield/",
  "/liquidity/",
  "/depeg/",
  "/blacklist/",
  "/stability-index/",
  "/safety-scores/",
];

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, skipOverflow: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      args.url = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--skip-overflow") {
      args.skipOverflow = true;
    }
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing URL. Pass --url https://... or set SMOKE_UI_URL.");
  }
  const parsed = new URL(trimmed);
  return parsed.toString();
}

async function runPlaywrightCli(sessionId, args) {
  const { stdout, stderr } = await execFileAsync(
    "npx",
    [...PLAYWRIGHT_CLI_PREFIX, `-s=${sessionId}`, ...args],
    { maxBuffer: MAX_BUFFER_BYTES },
  );
  return `${stdout ?? ""}${stderr ?? ""}`;
}

function ensureNoCliError(step, output) {
  if (output.includes("### Error")) {
    throw new Error(`[smoke-ui] ${step} failed.\n${output}`);
  }
}

function parseResultJson(output) {
  const match =
    output.match(/### Result\s*([\s\S]*?)\n### Ran Playwright code/m) ??
    output.match(/### Result\s*([\s\S]*)$/m);
  if (!match) {
    throw new Error(`[smoke-ui] Could not parse Playwright result output.\n${output}`);
  }
  return JSON.parse(match[1].trim());
}

function removePlaywrightArtifacts() {
  rmSync(".playwright-cli", { recursive: true, force: true });
}

function getUiWaitTimeoutMs() {
  return readPositiveIntEnv("SMOKE_UI_WAIT_TIMEOUT_MS", DEFAULT_UI_WAIT_TIMEOUT_MS);
}

function getUiRetryCount() {
  return readNonNegativeIntEnv("SMOKE_UI_RETRY_COUNT", DEFAULT_UI_RETRY_COUNT);
}

function getUiRetryDelayMs() {
  return readPositiveIntEnv("SMOKE_UI_RETRY_DELAY_MS", DEFAULT_UI_RETRY_DELAY_MS);
}

function getExpectedGaId() {
  const configured = (process.env.SMOKE_UI_EXPECT_GA_ID ?? "").trim();
  return configured || null;
}

function readPositiveIntEnv(key, fallback) {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function readNonNegativeIntEnv(key, fallback) {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
}

function buildUiEval(waitTimeoutMs) {
  return `async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timeoutAt = Date.now() + ${waitTimeoutMs};
  while (Date.now() < timeoutAt) {
    const text = document.body?.innerText ?? "";
    const rows = document.querySelectorAll("table tbody tr").length;
    const hasFailedToLoad = text.includes("Failed to load data");
    const hasStablecoins404 = text.includes("stablecoins:404");
    const hasDataNotYetAvailable = text.includes("Data not yet available");
    const hasConnectionIssue = text.includes("Connection issue");
    const hasLiveRefreshDelayed = text.includes("Live refresh delayed");
    const hasNoStablecoinData = text.includes("No stablecoin data available");
    const hasTerminalError = hasFailedToLoad || hasStablecoins404 || hasDataNotYetAvailable || hasConnectionIssue || hasNoStablecoinData;
    if (rows > 0 || hasTerminalError) {
      return {
        rows,
        hasFailedToLoad,
        hasStablecoins404,
        hasDataNotYetAvailable,
        hasConnectionIssue,
        hasLiveRefreshDelayed,
        hasNoStablecoinData,
        hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
        title: document.title,
        textPreview: text.replace(/\\s+/g, " ").trim().slice(0, 180),
        waitTimeoutMs: ${waitTimeoutMs},
        timedOut: false
      };
    }
    await delay(500);
  }
  const text = document.body?.innerText ?? "";
  return {
    rows: document.querySelectorAll("table tbody tr").length,
    hasFailedToLoad: text.includes("Failed to load data"),
    hasStablecoins404: text.includes("stablecoins:404"),
    hasDataNotYetAvailable: text.includes("Data not yet available"),
    hasConnectionIssue: text.includes("Connection issue"),
    hasLiveRefreshDelayed: text.includes("Live refresh delayed"),
    hasNoStablecoinData: text.includes("No stablecoin data available"),
    hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
    title: document.title,
    textPreview: text.replace(/\\s+/g, " ").trim().slice(0, 180),
    waitTimeoutMs: ${waitTimeoutMs},
    timedOut: true
  };
}`;
}

function getOverflowRoutes() {
  const fromEnv = (process.env.SMOKE_UI_OVERFLOW_ROUTES ?? "")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : OVERFLOW_ROUTE_DEFAULTS;
}

function buildOverflowEval(waitMs, settleSamples, sampleIntervalMs, styleReadyTimeoutMs) {
  return `async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const measure = () => {
    const doc = document.documentElement;
    const body = document.body;
    const innerWidth = window.innerWidth;
    const scrollWidth = Math.max(
      doc?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0
    );
    return {
      innerWidth,
      scrollWidth,
      delta: scrollWidth - innerWidth
    };
  };
  const isCssReady = () => {
    const rootStyles = getComputedStyle(document.documentElement);
    const bodyStyles = getComputedStyle(document.body);
    const hasRootToken = (rootStyles.getPropertyValue("--background") ?? "").trim().length > 0;
    const hasMarginReset = bodyStyles.marginLeft === "0px" && bodyStyles.marginRight === "0px";
    return hasRootToken && hasMarginReset;
  };

  await delay(${waitMs});

  const cssReadyDeadline = Date.now() + ${styleReadyTimeoutMs};
  let cssReady = isCssReady();
  while (!cssReady && Date.now() < cssReadyDeadline) {
    await delay(100);
    cssReady = isCssReady();
  }

  const samples = [];
  for (let i = 0; i < ${settleSamples}; i += 1) {
    samples.push(measure());
    if (i < ${settleSamples} - 1) {
      await delay(${sampleIntervalMs});
    }
  }
  const finalSample = samples[samples.length - 1];
  const sampledDeltas = samples.map((sample) => sample.delta);
  const maxDelta = Math.max(...sampledDeltas);
  const hasOverflow = sampledDeltas.every((value) => value > 1);

  const offenders = [];
  if (maxDelta > 1) {
    const walker = document.querySelectorAll("body *");
    for (const el of walker) {
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.right) || !Number.isFinite(rect.left) || rect.width <= 0) {
        continue;
      }
      if (rect.right > finalSample.innerWidth + 1 || rect.left < -1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          className: (el.className || "").toString().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        });
        if (offenders.length >= 8) break;
      }
    }
  }

  const bodyStyles = getComputedStyle(document.body);
  return {
    path: window.location.pathname,
    innerWidth: finalSample.innerWidth,
    scrollWidth: finalSample.scrollWidth,
    delta: finalSample.delta,
    sampledDeltas,
    maxDelta,
    hasOverflow,
    cssReady,
    bodyMarginLeft: bodyStyles.marginLeft,
    bodyMarginRight: bodyStyles.marginRight,
    offenders
  };
}`;
}

function formatOverflowFailure(summary) {
  const sampledDeltas = Array.isArray(summary.sampledDeltas)
    ? summary.sampledDeltas.join(",")
    : "n/a";
  const offenders = Array.isArray(summary.offenders) && summary.offenders.length > 0
    ? summary.offenders
      .map((offender) => {
        const idPart = offender.id ? `#${offender.id}` : "";
        const classPart = typeof offender.className === "string" && offender.className.trim().length > 0
          ? `.${offender.className.trim().replace(/\s+/g, ".")}`
          : "";
        return `${offender.tag}${idPart}${classPart}[${offender.left},${offender.right}]`;
      })
      .join("; ")
    : "none";
  return `Horizontal overflow detected on ${summary.path} (${summary.scrollWidth}px > ${summary.innerWidth}px, sampledDeltas=${sampledDeltas}, cssReady=${summary.cssReady}, bodyMargins=${summary.bodyMarginLeft}/${summary.bodyMarginRight}, offenders=${offenders})`;
}

async function runOverflowCheck(sessionId, waitMs, settleSamples, sampleIntervalMs, styleReadyTimeoutMs, route) {
  const overflowOutput = await runPlaywrightCli(sessionId, [
    "eval",
    buildOverflowEval(waitMs, settleSamples, sampleIntervalMs, styleReadyTimeoutMs),
  ]);
  ensureNoCliError(`overflow check ${route}`, overflowOutput);
  return parseResultJson(overflowOutput);
}

function formatUiSummary(summary) {
  const markers = [];
  if (summary.hasFailedToLoad) markers.push("Failed to load data");
  if (summary.hasStablecoins404) markers.push("stablecoins:404");
  if (summary.hasDataNotYetAvailable) markers.push("Data not yet available");
  if (summary.hasConnectionIssue) markers.push("Connection issue");
  if (summary.hasLiveRefreshDelayed) markers.push("Live refresh delayed");
  if (summary.hasNoStablecoinData) markers.push("No stablecoin data available");
  const markerSummary = markers.length > 0 ? markers.join(", ") : "none";
  const preview =
    typeof summary.textPreview === "string" && summary.textPreview.length > 0
      ? summary.textPreview.replace(/"/g, "'")
      : "n/a";
  return `title="${summary.title}", rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}, markers=${markerSummary}, preview="${preview}"`;
}

async function runHomepageCheck(sessionId, waitTimeoutMs) {
  const evalOutput = await runPlaywrightCli(sessionId, ["eval", buildUiEval(waitTimeoutMs)]);
  ensureNoCliError("eval", evalOutput);
  return parseResultJson(evalOutput);
}

async function navigateWithRetry(sessionId, targetUrl, label, retryCount, retryDelayMs) {
  const totalAttempts = retryCount + 1;
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const gotoOutput = await runPlaywrightCli(sessionId, ["goto", targetUrl]);
      ensureNoCliError(label, gotoOutput);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= totalAttempts - 1) {
        break;
      }
      console.log(
        `[smoke-ui] WARN ${label} attempt ${attempt + 1}/${totalAttempts} failed; retrying in ${retryDelayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function verifyAnalyticsSnippet(url, expectedGaId) {
  if (!expectedGaId) {
    return;
  }

  const response = await fetch(url);
  assert(response.ok, `Failed to fetch ${url} while checking analytics snippet (${response.status})`);
  const html = await response.text();

  assert(
    html.includes(`https://www.googletagmanager.com/gtag/js?id=${expectedGaId}`),
    `Expected GA script tag for ${expectedGaId} in ${url}`,
  );
  assert(
    html.includes(`gtag('config', '${expectedGaId}')`),
    `Expected GA config init for ${expectedGaId} in ${url}`,
  );
}

async function run() {
  const { url: rawUrl, skipOverflow } = parseArgs(process.argv.slice(2));
  const url = ensureUrl(rawUrl);
  const sessionId = `${SESSION_PREFIX}-${Date.now()}`;
  const waitTimeoutMs = getUiWaitTimeoutMs();
  const uiRetryCount = getUiRetryCount();
  const uiRetryDelayMs = getUiRetryDelayMs();
  const safeOverflowWaitMs = readPositiveIntEnv("SMOKE_UI_OVERFLOW_WAIT_MS", DEFAULT_OVERFLOW_WAIT_MS);
  const overflowSettleSamples = Math.max(
    2,
    readPositiveIntEnv("SMOKE_UI_OVERFLOW_SETTLE_SAMPLES", DEFAULT_OVERFLOW_SETTLE_SAMPLES),
  );
  const overflowSampleIntervalMs = readPositiveIntEnv(
    "SMOKE_UI_OVERFLOW_SAMPLE_INTERVAL_MS",
    DEFAULT_OVERFLOW_SAMPLE_INTERVAL_MS,
  );
  const styleReadyTimeoutMs = readPositiveIntEnv(
    "SMOKE_UI_STYLE_READY_TIMEOUT_MS",
    DEFAULT_STYLE_READY_TIMEOUT_MS,
  );
  const expectedGaId = getExpectedGaId();

  console.log(`[smoke-ui] Running browser smoke checks against ${url}`);

  try {
    await verifyAnalyticsSnippet(url, expectedGaId);
    if (expectedGaId) {
      console.log(`[smoke-ui] OK analytics snippet ${expectedGaId}`);
    }

    const openOutput = await runPlaywrightCli(sessionId, ["open", url]);
    ensureNoCliError("open", openOutput);

    let summary = null;
    const totalAttempts = uiRetryCount + 1;
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      summary = await runHomepageCheck(sessionId, waitTimeoutMs);
      if (!summary.timedOut) {
        break;
      }
      if (attempt < totalAttempts - 1) {
        console.log(
          `[smoke-ui] WARN homepage data timeout on attempt ${attempt + 1}/${totalAttempts} (${formatUiSummary(summary)}); retrying in ${uiRetryDelayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, uiRetryDelayMs));
        const retryGotoOutput = await runPlaywrightCli(sessionId, ["goto", url]);
        ensureNoCliError(`goto retry ${attempt + 1}`, retryGotoOutput);
      }
    }

    assert(summary, "Homepage smoke check did not produce a summary result");

    assert(
      !summary.timedOut,
      `Timed out waiting for homepage table data after ${summary.waitTimeoutMs}ms (${formatUiSummary(summary)})`,
    );
    assert(!summary.hasFailedToLoad, "Found 'Failed to load data' UI banner");
    assert(!summary.hasStablecoins404, "Found '/api/stablecoins:404' style UI error");
    assert(!summary.hasDataNotYetAvailable, "Found 'Data not yet available' UI banner");
    assert(!summary.hasConnectionIssue, "Found 'Connection issue' UI banner");
    assert(!summary.hasNoStablecoinData, "Found 'No stablecoin data available' empty state");
    assert(summary.rows > 0, "Expected at least one stablecoin row in the homepage table");
    assert(summary.hasKnownTicker, "Could not find a known ticker (USDT/USDC) in homepage text");

    if (summary.hasLiveRefreshDelayed) {
      console.log(`[smoke-ui] WARN homepage shows 'Live refresh delayed' (${formatUiSummary(summary)})`);
    }
    console.log(`[smoke-ui] OK ${summary.title}`);
    console.log(`[smoke-ui] OK table rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}`);

    if (!skipOverflow) {
      const resizeOutput = await runPlaywrightCli(sessionId, ["resize", String(MOBILE_WIDTH), String(MOBILE_HEIGHT)]);
      ensureNoCliError("resize", resizeOutput);

      const routes = getOverflowRoutes();
      let currentRoute = new URL(url).pathname || "/";
      for (const route of routes) {
        const routeUrl = new URL(route, url).toString();
        if (route !== currentRoute) {
          await navigateWithRetry(sessionId, routeUrl, `goto ${route}`, uiRetryCount, uiRetryDelayMs);
          currentRoute = route;
        }

        let overflowSummary = await runOverflowCheck(
          sessionId,
          safeOverflowWaitMs,
          overflowSettleSamples,
          overflowSampleIntervalMs,
          styleReadyTimeoutMs,
          route,
        );
        if (overflowSummary.hasOverflow) {
          const retrySummary = await runOverflowCheck(
            sessionId,
            safeOverflowWaitMs + DEFAULT_OVERFLOW_RETRY_EXTRA_WAIT_MS,
            overflowSettleSamples,
            overflowSampleIntervalMs,
            styleReadyTimeoutMs,
            route,
          );
          if (retrySummary.hasOverflow) {
            throw new Error(formatOverflowFailure(retrySummary));
          }
          console.log(
            `[smoke-ui] WARN transient overflow resolved on ${retrySummary.path} (initial=${overflowSummary.scrollWidth}/${overflowSummary.innerWidth}, retry=${retrySummary.scrollWidth}/${retrySummary.innerWidth})`,
          );
          overflowSummary = retrySummary;
        }
        console.log(`[smoke-ui] OK overflow ${overflowSummary.path} (${overflowSummary.scrollWidth}/${overflowSummary.innerWidth})`);
      }
    }

    console.log("[smoke-ui] All checks passed.");
  } finally {
    try {
      await runPlaywrightCli(sessionId, ["close"]);
    } catch {
      // Best-effort cleanup; stale sessions can be killed by playwright-cli kill-all if needed.
    }
    removePlaywrightArtifacts();
  }
}

run().catch((error) => {
  console.error(`[smoke-ui] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  removePlaywrightArtifacts();
  process.exit(1);
});
