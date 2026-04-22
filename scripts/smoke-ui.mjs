#!/usr/bin/env node

import { execFile } from "child_process";
import { rmSync } from "fs";
import { pathToFileURL } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI_PREFIX = ["--yes", "--package", "@playwright/cli", "playwright-cli"];
const DEFAULT_URL = process.env.SMOKE_UI_URL ?? "https://pharos.watch";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SESSION_PREFIX = "ui";
const DEFAULT_MODE = process.env.SMOKE_UI_MODE ?? "local";
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
const DEFAULT_LIVE_CANARY_ROUTE = "/yield/";
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
  const args = { mode: DEFAULT_MODE, skipOverflow: false, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      args.url = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--mode") {
      args.mode = argv[i + 1] ?? "";
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

function ensureMode(input) {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "local" || normalized === "live") {
    return normalized;
  }
  throw new Error(`Invalid mode "${input}". Expected "local" or "live".`);
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
  rmSync(".playwright-cli", { force: true, recursive: true });
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

function normalizeRoute(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getOverflowRoutes(mode) {
  const fromEnv = (process.env.SMOKE_UI_OVERFLOW_ROUTES ?? "")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
    .map((route) => normalizeRoute(route));
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (mode === "live") {
    return [normalizeRoute(process.env.SMOKE_UI_CANARY_ROUTE ?? DEFAULT_LIVE_CANARY_ROUTE)];
  }
  return OVERFLOW_ROUTE_DEFAULTS;
}

function buildSmokeRunCode(config) {
  const serialized = JSON.stringify(config);
  return `async (page) => {
  const config = ${serialized};
  const waitForRetryDelay = async (ms) => {
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(ms);
      return;
    }
    await page.evaluate((timeoutMs) => new Promise((resolve) => window.setTimeout(resolve, timeoutMs)), ms);
  };
  const joinUrl = (baseUrl, route) => {
    const normalizedRoute = !route || route === "/" ? "/" : route.startsWith("/") ? route : \`/\${route}\`;
    if (normalizedRoute === "/") {
      return baseUrl;
    }
    return baseUrl.endsWith("/") ? \`\${baseUrl.slice(0, -1)}\${normalizedRoute}\` : \`\${baseUrl}\${normalizedRoute}\`;
  };

  async function captureHomepageSummary() {
    return page.evaluate(async ({ waitTimeoutMs }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const matchesAny = (text, values) => values.some((value) => text.includes(value));
      const timeoutAt = Date.now() + waitTimeoutMs;

      while (Date.now() < timeoutAt) {
        const text = document.body?.innerText ?? "";
        const rows = document.querySelectorAll("table tbody tr").length;
        const hasFailedToLoad = matchesAny(text, ["Failed to load data", "Failed to load this dataset"]);
        const hasStablecoins404 = text.includes("stablecoins:404");
        const hasDataNotYetAvailable = matchesAny(text, ["Data not yet available", "Waiting for first sync"]);
        const hasConnectionIssue = matchesAny(text, ["Connection issue", "Unable to reach the Pharos data API right now."]);
        const hasLiveRefreshDelayed = matchesAny(text, ["Live refresh delayed", "Live refresh is running behind"]);
        const hasNoStablecoinData = text.includes("No stablecoin data available");
        const hasTerminalError =
          hasFailedToLoad
          || hasStablecoins404
          || hasDataNotYetAvailable
          || hasConnectionIssue
          || hasNoStablecoinData;

        if (rows > 0 || hasTerminalError) {
          return {
            hasConnectionIssue,
            hasDataNotYetAvailable,
            hasFailedToLoad,
            hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
            hasLiveRefreshDelayed,
            hasNoStablecoinData,
            hasStablecoins404,
            rows,
            textPreview: text.replace(/\\s+/g, " ").trim().slice(0, 180),
            timedOut: false,
            title: document.title,
            waitTimeoutMs,
          };
        }

        await delay(500);
      }

      const text = document.body?.innerText ?? "";
      return {
        hasConnectionIssue: matchesAny(text, ["Connection issue", "Unable to reach the Pharos data API right now."]),
        hasDataNotYetAvailable: matchesAny(text, ["Data not yet available", "Waiting for first sync"]),
        hasFailedToLoad: matchesAny(text, ["Failed to load data", "Failed to load this dataset"]),
        hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
        hasLiveRefreshDelayed: matchesAny(text, ["Live refresh delayed", "Live refresh is running behind"]),
        hasNoStablecoinData: text.includes("No stablecoin data available"),
        hasStablecoins404: text.includes("stablecoins:404"),
        rows: document.querySelectorAll("table tbody tr").length,
        textPreview: text.replace(/\\s+/g, " ").trim().slice(0, 180),
        timedOut: true,
        title: document.title,
        waitTimeoutMs,
      };
    }, { waitTimeoutMs: config.waitTimeoutMs });
  }

  async function measureOverflow(route, waitMs, options = {}) {
    const routeUrl = joinUrl(config.baseUrl, route);
    await page.goto(routeUrl, { timeout: config.waitTimeoutMs, waitUntil: "domcontentloaded" });

    return page.evaluate(
      async ({ openHomepageFilters, route, sampleIntervalMs, settleSamples, styleReadyTimeoutMs, summaryLabel, waitMs }) => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const measure = () => {
          const doc = document.documentElement;
          const body = document.body;
          const innerWidth = window.innerWidth;
          const scrollWidth = Math.max(
            doc?.scrollWidth ?? 0,
            body?.scrollWidth ?? 0,
          );
          return {
            delta: scrollWidth - innerWidth,
            innerWidth,
            scrollWidth,
          };
        };
        const isCssReady = () => {
          const rootStyles = getComputedStyle(document.documentElement);
          const bodyStyles = getComputedStyle(document.body);
          const hasRootToken = (rootStyles.getPropertyValue("--background") ?? "").trim().length > 0;
          const hasMarginReset = bodyStyles.marginLeft === "0px" && bodyStyles.marginRight === "0px";
          return hasRootToken && hasMarginReset;
        };

        await delay(waitMs);

        const cssReadyDeadline = Date.now() + styleReadyTimeoutMs;
        let cssReady = isCssReady();
        while (!cssReady && Date.now() < cssReadyDeadline) {
          await delay(100);
          cssReady = isCssReady();
        }

        if (openHomepageFilters && route === "/") {
          const filterToggle = Array.from(document.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "Filters" || button.textContent?.trim() === "Hide");
          filterToggle?.click();
          await delay(200);
        }

        const samples = [];
        for (let i = 0; i < settleSamples; i += 1) {
          samples.push(measure());
          if (i < settleSamples - 1) {
            await delay(sampleIntervalMs);
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
                className: (el.className || "").toString().slice(0, 80),
                id: el.id || "",
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                tag: el.tagName.toLowerCase(),
                width: Math.round(rect.width),
              });
              if (offenders.length >= 8) {
                break;
              }
            }
          }
        }

        const bodyStyles = getComputedStyle(document.body);
        return {
          bodyMarginLeft: bodyStyles.marginLeft,
          bodyMarginRight: bodyStyles.marginRight,
          cssReady,
          delta: finalSample.delta,
          hasOverflow,
          innerWidth: finalSample.innerWidth,
          maxDelta,
          offenders,
          path: summaryLabel,
          sampledDeltas,
          scrollWidth: finalSample.scrollWidth,
        };
      },
      {
        openHomepageFilters: options.openHomepageFilters === true,
        route,
        sampleIntervalMs: config.overflowSampleIntervalMs,
        settleSamples: config.overflowSettleSamples,
        summaryLabel: options.summaryLabel ?? route,
        styleReadyTimeoutMs: config.styleReadyTimeoutMs,
        waitMs,
      },
    );
  }

  await page.goto(config.baseUrl, { timeout: config.waitTimeoutMs, waitUntil: "domcontentloaded" });

  let homepage = null;
  for (let attempt = 0; attempt <= config.uiRetryCount; attempt += 1) {
    homepage = await captureHomepageSummary();
    if (!homepage.timedOut) {
      break;
    }
    if (attempt < config.uiRetryCount) {
      await waitForRetryDelay(config.uiRetryDelayMs);
      await page.goto(config.baseUrl, { timeout: config.waitTimeoutMs, waitUntil: "domcontentloaded" });
    }
  }

  const overflowChecks = [];
  if (!config.skipOverflow && config.routes.length > 0) {
    await page.setViewportSize({ height: config.mobileHeight, width: config.mobileWidth });

    for (const route of config.routes) {
      const initial = await measureOverflow(route, config.overflowWaitMs, {
        openHomepageFilters: route === "/",
      });
      let retry = null;
      if (initial.hasOverflow) {
        retry = await measureOverflow(route, config.overflowWaitMs + config.overflowRetryExtraWaitMs, {
          openHomepageFilters: route === "/",
        });
      }
      overflowChecks.push({ initial, retry, route });
    }

    if (config.routes.includes("/")) {
      await page.setViewportSize({ height: 900, width: 1280 });
      const initial = await measureOverflow("/", config.overflowWaitMs, {
        openHomepageFilters: true,
        summaryLabel: "/ [desktop filters]",
      });
      let retry = null;
      if (initial.hasOverflow) {
        retry = await measureOverflow("/", config.overflowWaitMs + config.overflowRetryExtraWaitMs, {
          openHomepageFilters: true,
          summaryLabel: "/ [desktop filters]",
        });
      }
      overflowChecks.push({ initial, retry, route: "/ [desktop filters]" });
    }
  }

  return { homepage, overflowChecks };
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

function formatUiSummary(summary) {
  const markers = [];
  if (summary.hasFailedToLoad) markers.push("Failed to load data / Failed to load this dataset");
  if (summary.hasStablecoins404) markers.push("stablecoins:404");
  if (summary.hasDataNotYetAvailable) markers.push("Data not yet available / Waiting for first sync");
  if (summary.hasConnectionIssue) markers.push("Connection issue / Unable to reach the Pharos data API right now.");
  if (summary.hasLiveRefreshDelayed) markers.push("Live refresh delayed / Live refresh is running behind");
  if (summary.hasNoStablecoinData) markers.push("No stablecoin data available");
  const markerSummary = markers.length > 0 ? markers.join(", ") : "none";
  const preview =
    typeof summary.textPreview === "string" && summary.textPreview.length > 0
      ? summary.textPreview.replace(/"/g, "'")
      : "n/a";
  return `title="${summary.title}", rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}, markers=${markerSummary}, preview="${preview}"`;
}

export function hasGaConfigInit(html, expectedGaId) {
  const compactHtml = html
    .replace(/\s+/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
  return [
    `gtag('config','${expectedGaId}')`,
    `gtag('config',"${expectedGaId}")`,
    `gtag("config",'${expectedGaId}')`,
    `gtag("config","${expectedGaId}")`,
  ].some((candidate) => compactHtml.includes(candidate));
}

export function getAnalyticsPayloadUrls(url) {
  const parsed = new URL(url);
  return Array.from(
    new Set([
      new URL("index.txt", parsed).toString(),
      new URL("__next._index.txt", parsed).toString(),
      new URL("__next._full.txt", parsed).toString(),
    ]),
  );
}

async function hasGaConfigInitInPayload(url, expectedGaId, fetchImpl = fetch) {
  for (const payloadUrl of getAnalyticsPayloadUrls(url)) {
    const response = await fetchImpl(payloadUrl).catch(() => null);
    if (!response?.ok) continue;
    const text = await response.text();
    if (hasGaConfigInit(text, expectedGaId)) {
      return true;
    }
  }
  return false;
}

export async function verifyAnalyticsSnippet(url, expectedGaId, fetchImpl = fetch) {
  if (!expectedGaId) {
    return;
  }

  const response = await fetchImpl(url);
  assert(response.ok, `Failed to fetch ${url} while checking analytics snippet (${response.status})`);
  const html = await response.text();

  assert(
    html.includes(`https://www.googletagmanager.com/gtag/js?id=${expectedGaId}`),
    `Expected GA script tag for ${expectedGaId} in ${url}`,
  );
  if (hasGaConfigInit(html, expectedGaId)) {
    return;
  }
  assert(
    await hasGaConfigInitInPayload(url, expectedGaId, fetchImpl),
    `Expected GA config init for ${expectedGaId} in ${url} or its static payload`,
  );
}

export async function run() {
  const { mode: rawMode, skipOverflow, url: rawUrl } = parseArgs(process.argv.slice(2));
  const url = ensureUrl(rawUrl);
  const mode = ensureMode(rawMode);
  const sessionId = `${SESSION_PREFIX}-${Date.now().toString(36)}`;
  const waitTimeoutMs = getUiWaitTimeoutMs();
  const uiRetryCount = getUiRetryCount();
  const uiRetryDelayMs = getUiRetryDelayMs();
  const expectedGaId = getExpectedGaId();

  const config = {
    baseUrl: url,
    mobileHeight: MOBILE_HEIGHT,
    mobileWidth: MOBILE_WIDTH,
    overflowRetryExtraWaitMs: DEFAULT_OVERFLOW_RETRY_EXTRA_WAIT_MS,
    overflowSampleIntervalMs: readPositiveIntEnv(
      "SMOKE_UI_OVERFLOW_SAMPLE_INTERVAL_MS",
      DEFAULT_OVERFLOW_SAMPLE_INTERVAL_MS,
    ),
    overflowSettleSamples: Math.max(
      2,
      readPositiveIntEnv("SMOKE_UI_OVERFLOW_SETTLE_SAMPLES", DEFAULT_OVERFLOW_SETTLE_SAMPLES),
    ),
    overflowWaitMs: readPositiveIntEnv("SMOKE_UI_OVERFLOW_WAIT_MS", DEFAULT_OVERFLOW_WAIT_MS),
    routes: getOverflowRoutes(mode),
    skipOverflow,
    styleReadyTimeoutMs: readPositiveIntEnv(
      "SMOKE_UI_STYLE_READY_TIMEOUT_MS",
      DEFAULT_STYLE_READY_TIMEOUT_MS,
    ),
    uiRetryCount,
    uiRetryDelayMs,
    waitTimeoutMs,
  };

  console.log(`[smoke-ui] Running ${mode} browser smoke checks against ${url}`);

  try {
    await verifyAnalyticsSnippet(url, expectedGaId);
    if (expectedGaId) {
      console.log(`[smoke-ui] OK analytics snippet ${expectedGaId}`);
    }

    const openOutput = await runPlaywrightCli(sessionId, ["open", url]);
    ensureNoCliError("open", openOutput);

    const smokeOutput = await runPlaywrightCli(sessionId, ["run-code", buildSmokeRunCode(config)]);
    ensureNoCliError("run-code", smokeOutput);
    const result = parseResultJson(smokeOutput);
    const summary = result.homepage;

    assert(summary, "Homepage smoke check did not produce a summary result");
    assert(
      !summary.timedOut,
      `Timed out waiting for homepage table data after ${summary.waitTimeoutMs}ms (${formatUiSummary(summary)})`,
    );
    assert(!summary.hasFailedToLoad, "Found generic dataset-load failure UI banner");
    assert(!summary.hasStablecoins404, "Found '/api/stablecoins:404' style UI error");
    assert(!summary.hasDataNotYetAvailable, "Found first-sync unavailable UI banner");
    assert(!summary.hasConnectionIssue, "Found API-connection failure UI banner");
    assert(!summary.hasNoStablecoinData, "Found 'No stablecoin data available' empty state");
    assert(summary.rows > 0, "Expected at least one stablecoin row in the homepage table");
    assert(summary.hasKnownTicker, "Could not find a known ticker (USDT/USDC) in homepage text");

    if (summary.hasLiveRefreshDelayed) {
      console.log(`[smoke-ui] WARN homepage shows a stale-data banner (${formatUiSummary(summary)})`);
    }
    console.log(`[smoke-ui] OK ${summary.title}`);
    console.log(`[smoke-ui] OK table rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}`);

    for (const check of result.overflowChecks ?? []) {
      const finalSummary = check.retry ?? check.initial;
      if (check.initial?.hasOverflow && check.retry?.hasOverflow) {
        throw new Error(formatOverflowFailure(check.retry));
      }
      if (check.initial?.hasOverflow && check.retry && !check.retry.hasOverflow) {
        console.log(
          `[smoke-ui] WARN transient overflow resolved on ${check.route} (initial=${check.initial.scrollWidth}/${check.initial.innerWidth}, retry=${check.retry.scrollWidth}/${check.retry.innerWidth})`,
        );
      }
      console.log(
        `[smoke-ui] OK overflow ${finalSummary.path} (${finalSummary.scrollWidth}/${finalSummary.innerWidth})`,
      );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`[smoke-ui] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    removePlaywrightArtifacts();
    process.exit(1);
  });
}
