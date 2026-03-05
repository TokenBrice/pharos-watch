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

function readPositiveIntEnv(key, fallback) {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
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
    if (rows > 0 || hasFailedToLoad || hasStablecoins404) {
      return {
        rows,
        hasFailedToLoad,
        hasStablecoins404,
        hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
        title: document.title,
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
    hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
    title: document.title,
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

async function run() {
  const { url: rawUrl, skipOverflow } = parseArgs(process.argv.slice(2));
  const url = ensureUrl(rawUrl);
  const sessionId = `${SESSION_PREFIX}-${Date.now()}`;
  const waitTimeoutMs = getUiWaitTimeoutMs();
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

  console.log(`[smoke-ui] Running browser smoke checks against ${url}`);

  try {
    const openOutput = await runPlaywrightCli(sessionId, ["open", url]);
    ensureNoCliError("open", openOutput);

    const evalOutput = await runPlaywrightCli(sessionId, ["eval", buildUiEval(waitTimeoutMs)]);
    ensureNoCliError("eval", evalOutput);
    const summary = parseResultJson(evalOutput);

    assert(
      !summary.timedOut,
      `Timed out waiting for homepage table data after ${summary.waitTimeoutMs}ms`,
    );
    assert(!summary.hasFailedToLoad, "Found 'Failed to load data' UI banner");
    assert(!summary.hasStablecoins404, "Found '/api/stablecoins:404' style UI error");
    assert(summary.rows > 0, "Expected at least one stablecoin row in the homepage table");
    assert(summary.hasKnownTicker, "Could not find a known ticker (USDT/USDC) in homepage text");

    console.log(`[smoke-ui] OK ${summary.title}`);
    console.log(`[smoke-ui] OK table rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}`);

    if (!skipOverflow) {
      const resizeOutput = await runPlaywrightCli(sessionId, ["resize", String(MOBILE_WIDTH), String(MOBILE_HEIGHT)]);
      ensureNoCliError("resize", resizeOutput);

      const routes = getOverflowRoutes();
      for (const route of routes) {
        const routeUrl = new URL(route, url).toString();
        const gotoOutput = await runPlaywrightCli(sessionId, ["goto", routeUrl]);
        ensureNoCliError(`goto ${route}`, gotoOutput);

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
