#!/usr/bin/env node

import {
  assert,
  chunkWorkerItems,
  ensureHttpUrl,
  isDirectRun,
  launchChromiumBrowser,
  loadChromium,
  normalizeRoute,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
  sleep,
} from "../lib/smoke-runtime.mjs";

export { getBrowserLaunchOptions, launchChromiumBrowser, loadChromium } from "../lib/smoke-runtime.mjs";

const DEFAULT_URL = process.env.SMOKE_UI_URL ?? "https://pharos.watch";
const DEFAULT_MODE = process.env.SMOKE_UI_MODE ?? "local";
const DEFAULT_UI_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_UI_RETRY_COUNT = 1;
const DEFAULT_UI_RETRY_DELAY_MS = 1500;
const DEFAULT_LIVE_ANALYTICS_RETRY_COUNT = 1;
const DEFAULT_LIVE_ANALYTICS_RETRY_DELAY_MS = 5000;
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const DEFAULT_OVERFLOW_WAIT_MS = 2000;
const DEFAULT_OVERFLOW_SETTLE_SAMPLES = 4;
const DEFAULT_OVERFLOW_SAMPLE_INTERVAL_MS = 350;
const DEFAULT_STYLE_READY_TIMEOUT_MS = 4000;
const DEFAULT_OVERFLOW_RETRY_EXTRA_WAIT_MS = 2000;
const DEFAULT_LOCAL_OVERFLOW_WORKERS = 2;
const DEFAULT_LIVE_OVERFLOW_WORKERS = 1;
const MAX_OVERFLOW_WORKERS = 6;
// Homepage tape now hits the unified events endpoint; the smoke check pings
// it to verify the site-data lane is reachable from the page host.
export const HOMEPAGE_RECENT_EVENTS_SMOKE_PATH = "/_site-data/events?limit=1";
const DEFAULT_LIVE_CANARY_ROUTES = [
  "/yield/",
  "/alt-pegs/",
  "/freezewatch/",
  "/stability-index/",
  "/pharoswatchbot/",
];
const OVERFLOW_ROUTE_DEFAULTS = [
  "/",
  "/alt-pegs/",
  "/dependency-map/",
  "/flows/",
  "/yield/",
  "/liquidity/",
  "/depeg/",
  "/freezewatch/",
  "/stability-index/",
  "/safety-scores/",
  "/api/",
  "/pharoswatchbot/",
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

function ensureUrl(input) {
  return ensureHttpUrl(input, "Missing URL. Pass --url https://... or set SMOKE_UI_URL.");
}

function ensureMode(input) {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "local" || normalized === "live") {
    return normalized;
  }
  throw new Error(`Invalid mode "${input}". Expected "local" or "live".`);
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

export function getOverflowWorkerCount(mode, routeCount, skipOverflow = false) {
  if (skipOverflow || routeCount <= 0) {
    return 0;
  }

  const fallback = mode === "live" ? DEFAULT_LIVE_OVERFLOW_WORKERS : DEFAULT_LOCAL_OVERFLOW_WORKERS;
  const requested = readPositiveIntEnv("SMOKE_UI_OVERFLOW_WORKERS", fallback);
  return Math.min(MAX_OVERFLOW_WORKERS, routeCount, requested);
}

export function chunkOverflowRoutes(routes, workerCount) {
  return chunkWorkerItems(routes, workerCount);
}

export function getOverflowRoutes(mode) {
  const fromEnv = (process.env.SMOKE_UI_OVERFLOW_ROUTES ?? "")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
    .map((route) => normalizeRoute(route));
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (mode === "live") {
    const liveCanaries = (process.env.SMOKE_UI_CANARY_ROUTE ?? "")
      .split(",")
      .map((route) => route.trim())
      .filter(Boolean)
      .map((route) => normalizeRoute(route));
    if (liveCanaries.length > 0) {
      return liveCanaries;
    }
    return DEFAULT_LIVE_CANARY_ROUTES;
  }
  return OVERFLOW_ROUTE_DEFAULTS;
}

async function runSmokeRun(page, config) {
  const waitForRetryDelay = async (ms) => {
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(ms);
      return;
    }
    await page.evaluate((timeoutMs) => new Promise((resolve) => window.setTimeout(resolve, timeoutMs)), ms);
  };
  const joinUrl = (baseUrl, route) => {
    const normalizedRoute = !route || route === "/" ? "/" : route.startsWith("/") ? route : `/${route}`;
    if (normalizedRoute === "/") {
      return baseUrl;
    }
    return baseUrl.endsWith("/") ? `${baseUrl.slice(0, -1)}${normalizedRoute}` : `${baseUrl}${normalizedRoute}`;
  };

  async function captureHomepageSummary() {
    return page.evaluate(async ({ recentEventsPath, waitTimeoutMs }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const matchesAny = (text, values) => values.some((value) => text.includes(value));
      const timeoutAt = Date.now() + waitTimeoutMs;
      const captureRecentEventsContract = async () => {
        try {
          const response = await fetch(recentEventsPath, {
            cache: "no-store",
            headers: { Accept: "application/json" },
          });
          const text = await response.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            return {
              bodyPreview: text.slice(0, 180),
              count: null,
              ok: false,
              status: response.status,
              error: "invalid JSON",
            };
          }
          const events = body && Array.isArray(body.events) ? body.events : null;
          return {
            bodyPreview: text.slice(0, 180),
            count: events ? events.length : null,
            ok: response.ok && events !== null,
            status: response.status,
            error: response.ok && events === null ? "missing events[]" : null,
          };
        } catch (error) {
          return {
            bodyPreview: "",
            count: null,
            ok: false,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      };

      const maybeRevealHomepageTable = () => {
        const tableAnchor = document.getElementById("home-alt-rankings") || document.getElementById("data");
        if (tableAnchor) {
          tableAnchor.scrollIntoView({ behavior: "instant", block: "start" });
          return;
        }
        window.scrollTo(0, document.body.scrollHeight);
      };

      const buildSummary = async (text, rows, timedOut) => ({
        hasConnectionIssue: matchesAny(text, ["Connection issue", "Unable to reach the Pharos data API right now."]),
        hasDataNotYetAvailable: matchesAny(text, ["Data not yet available", "Waiting for first sync"]),
        hasFailedToLoad: matchesAny(text, ["Failed to load data", "Failed to load this dataset"]),
        hasKnownTicker: /\bUSDT\b|\bUSDC\b/.test(text),
        hasLiveRefreshDelayed: matchesAny(text, ["Live refresh delayed", "Live refresh is running behind"]),
        hasNoStablecoinData: text.includes("No stablecoin data available"),
        hasStablecoins404: text.includes("stablecoins:404"),
        recentEvents: await captureRecentEventsContract(),
        rows,
        textPreview: text.replace(/\s+/g, " ").trim().slice(0, 180),
        timedOut,
        title: document.title,
        waitTimeoutMs,
      });

      while (Date.now() < timeoutAt) {
        const text = document.body?.innerText ?? "";
        const rows = document.querySelectorAll("table tbody tr").length;
        const hasFailedToLoad = matchesAny(text, ["Failed to load data", "Failed to load this dataset"]);
        const hasStablecoins404 = text.includes("stablecoins:404");
        const hasDataNotYetAvailable = matchesAny(text, ["Data not yet available", "Waiting for first sync"]);
        const hasConnectionIssue = matchesAny(text, ["Connection issue", "Unable to reach the Pharos data API right now."]);
        const hasNoStablecoinData = text.includes("No stablecoin data available");
        const hasTerminalError =
          hasFailedToLoad
          || hasStablecoins404
          || hasDataNotYetAvailable
          || hasConnectionIssue
          || hasNoStablecoinData;

        if (rows > 0 || hasTerminalError) {
          return buildSummary(text, rows, false);
        }

        maybeRevealHomepageTable();
        await delay(500);
      }

      const text = document.body?.innerText ?? "";
      return buildSummary(text, document.querySelectorAll("table tbody tr").length, true);
    }, { recentEventsPath: HOMEPAGE_RECENT_EVENTS_SMOKE_PATH, waitTimeoutMs: config.waitTimeoutMs });
  }

  async function captureAnalyticsRuntime() {
    if (!config.expectedGaId) {
      return null;
    }

    return page.evaluate(async ({ expectedGaId, waitTimeoutMs }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const serializeValue = (value) => {
        if (value instanceof Date) return "[Date]";
        if (value && typeof value === "object") {
          try {
            return JSON.parse(JSON.stringify(value));
          } catch {
            return "[unserializable]";
          }
        }
        return value;
      };
      const summarize = () => {
        const dataLayer = Array.isArray(window.dataLayer) ? window.dataLayer : [];
        const entries = dataLayer.map((entry) => Array.from(entry).map(serializeValue));
        const pageViewEntry = entries.find((entry) => entry[0] === "event" && entry[1] === "page_view");
        return {
          dataLayerLength: dataLayer.length,
          gtagType: typeof window.gtag,
          hasExpectedConfig: entries.some((entry) => entry[0] === "config" && entry[1] === expectedGaId),
          hasPageView: Boolean(pageViewEntry),
          pageViewPath:
            pageViewEntry && pageViewEntry[2] && typeof pageViewEntry[2] === "object"
              ? pageViewEntry[2].page_path ?? null
              : null,
          timedOut: false,
        };
      };

      const timeoutAt = Date.now() + waitTimeoutMs;
      while (Date.now() < timeoutAt) {
        const summary = summarize();
        if (summary.gtagType === "function" && summary.hasExpectedConfig && summary.hasPageView) {
          await delay(3000);
          return summary;
        }
        await delay(250);
      }

      return { ...summarize(), timedOut: true };
    }, { expectedGaId: config.expectedGaId, waitTimeoutMs: config.waitTimeoutMs });
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

  let homepage = null;
  let analyticsRuntime = null;
  if (config.runHomepage !== false) {
    await page.goto(config.baseUrl, { timeout: config.waitTimeoutMs, waitUntil: "domcontentloaded" });

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

    analyticsRuntime = await captureAnalyticsRuntime();
    if (config.expectedGaId) {
      await waitForRetryDelay(1000);
    }
  }

  const overflowChecks = [];
  if (config.runOverflow !== false && !config.skipOverflow && config.routes.length > 0) {
    await page.setViewportSize({ height: config.mobileHeight, width: config.mobileWidth });

    for (const route of config.routes) {
      const initial = await measureOverflow(route, config.overflowWaitMs);
      let retry = null;
      if (initial.hasOverflow) {
        retry = await measureOverflow(route, config.overflowWaitMs + config.overflowRetryExtraWaitMs);
      }
      overflowChecks.push({ initial, retry, route });

      if (route === "/") {
        const mobileFiltersOpen = await measureOverflow(route, config.overflowWaitMs, {
          openHomepageFilters: true,
          summaryLabel: "/ [filters open]",
        });
        let mobileFiltersRetry = null;
        if (mobileFiltersOpen.hasOverflow) {
          mobileFiltersRetry = await measureOverflow(route, config.overflowWaitMs + config.overflowRetryExtraWaitMs, {
            openHomepageFilters: true,
            summaryLabel: "/ [filters open]",
          });
        }
        overflowChecks.push({ initial: mobileFiltersOpen, retry: mobileFiltersRetry, route: "/ [filters open]" });
      }
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

  return { analyticsRuntime, homepage, overflowChecks };
}

function formatRecentEventsSmoke(summary) {
  if (!summary || typeof summary !== "object") {
    return "missing recent-events smoke result";
  }
  const status = summary.status == null ? "n/a" : String(summary.status);
  const count = summary.count == null ? "n/a" : String(summary.count);
  const error = typeof summary.error === "string" && summary.error.length > 0 ? summary.error : "none";
  const preview =
    typeof summary.bodyPreview === "string" && summary.bodyPreview.length > 0
      ? summary.bodyPreview.replace(/\s+/g, " ").replace(/"/g, "'").slice(0, 180)
      : "n/a";
  return `status=${status}, events=${count}, error=${error}, preview="${preview}"`;
}

function formatOverflowFailure(summary) {
  const sampledDeltas = Array.isArray(summary.sampledDeltas) ? summary.sampledDeltas.join(",") : "n/a";
  const offenders =
    Array.isArray(summary.offenders) && summary.offenders.length > 0
      ? summary.offenders
          .map((offender) => {
            const idPart = offender.id ? `#${offender.id}` : "";
            const classPart =
              typeof offender.className === "string" && offender.className.trim().length > 0
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
  return `title="${summary.title}", rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}, markers=${markerSummary}, recentEvents=(${formatRecentEventsSmoke(summary.recentEvents)}), preview="${preview}"`;
}

export function hasGaConfigInit(html, expectedGaId) {
  const compactHtml = html.replace(/\s+/g, "").replace(/\\"/g, '"').replace(/\\'/g, "'");
  const callHeads = [
    `gtag('config','${expectedGaId}')`,
    `gtag('config',"${expectedGaId}")`,
    `gtag("config",'${expectedGaId}')`,
    `gtag("config","${expectedGaId}")`,
  ];
  const callHeadsWithOptions = callHeads.map((callHead) => callHead.slice(0, -1) + ",");
  return [...callHeads, ...callHeadsWithOptions].some((candidate) => compactHtml.includes(candidate));
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

export function isExpectedGaCollectUrl(url, expectedGaId) {
  if (!expectedGaId || !/\/g\/collect\b/.test(url)) return false;
  if (!/google-analytics\.com|analytics\.google\.com/.test(url)) return false;

  const collectUrl = new URL(url);
  return collectUrl.searchParams.get("tid") === expectedGaId;
}

export function isExpectedGaPageViewCollectUrl(url, expectedGaId) {
  if (!isExpectedGaCollectUrl(url, expectedGaId)) return false;

  const collectUrl = new URL(url);
  return collectUrl.searchParams.get("en") === "page_view";
}

export function isToleratedGaCollectFailure(failure, successfulCollectUrls) {
  return (
    failure?.errorText === "net::ERR_ABORTED" &&
    typeof failure.url === "string" &&
    successfulCollectUrls.has(failure.url)
  );
}

export function isExpectedGaCollectAbort(failure, expectedGaId) {
  return (
    failure?.errorText === "net::ERR_ABORTED" &&
    typeof failure.url === "string" &&
    isExpectedGaCollectUrl(failure.url, expectedGaId)
  );
}

export function getUnexpectedGaAnalyticsFailures(
  failures,
  successfulCollectUrls,
  expectedGaId,
  { tolerateExpectedCollectAbort = false } = {},
) {
  return failures.filter(
    (failure) =>
      !isToleratedGaCollectFailure(failure, successfulCollectUrls) &&
      !(tolerateExpectedCollectAbort && isExpectedGaCollectAbort(failure, expectedGaId)),
  );
}

export function isAnalyticsCspViolation(violation, expectedGaId) {
  if (!expectedGaId || !violation) {
    return false;
  }

  const values = [violation.blockedURI, violation.sourceFile, violation.violatedDirective, violation.effectiveDirective]
    .filter((value) => typeof value === "string")
    .join(" ");
  return /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com\/g\/collect/.test(values);
}

export function getUnexpectedGaCspViolations(violations, expectedGaId) {
  return violations.filter((violation) => isAnalyticsCspViolation(violation, expectedGaId));
}

export function hasExpectedGaRuntimeState(runtime) {
  return runtime?.gtagType === "function" && runtime.hasExpectedConfig === true && runtime.hasPageView === true;
}

export function hasAnyGaAnalyticsSignal(network) {
  return (
    (Array.isArray(network?.requests) && network.requests.length > 0) ||
    (Array.isArray(network?.responses) && network.responses.length > 0) ||
    (Array.isArray(network?.failures) && network.failures.length > 0) ||
    (Array.isArray(network?.violations) && network.violations.length > 0)
  );
}

export function hasRetryBlockingGaAnalyticsSignal(network, expectedGaId) {
  return (
    (Array.isArray(network?.requests) && network.requests.length > 0) ||
    (Array.isArray(network?.responses) && network.responses.length > 0) ||
    (Array.isArray(network?.failures) && network.failures.length > 0) ||
    getUnexpectedGaCspViolations(network?.violations ?? [], expectedGaId).length > 0
  );
}

export function shouldRetryLiveAnalyticsSmoke({ expectedGaId, mode, network, runtime }) {
  return (
    mode === "live"
    && Boolean(expectedGaId)
    && !hasExpectedGaRuntimeState(runtime)
    && !hasRetryBlockingGaAnalyticsSignal(network, expectedGaId)
  );
}

export function getExpectedGaNetworkSignals(network, expectedGaId, { tolerateCollectAbortAsSignal = false } = {}) {
  const responses = Array.isArray(network?.responses) ? network.responses : [];
  const failures = Array.isArray(network?.failures) ? network.failures : [];
  const collectResponses = responses.filter(
    (entry) => isExpectedGaPageViewCollectUrl(entry.url, expectedGaId) && entry.status >= 200 && entry.status < 400,
  );
  const collectAborts = tolerateCollectAbortAsSignal
    ? failures.filter((failure) => isExpectedGaCollectAbort(failure, expectedGaId))
    : [];
  const hasGtagScriptResponse = responses.some(
    (entry) => entry.url.includes("googletagmanager.com/gtag/js") && entry.status === 200,
  );

  return {
    collectAborts,
    collectResponses,
    hasCollectSignal: collectResponses.length + collectAborts.length > 0,
    hasGtagScriptResponse,
  };
}

export async function verifyAnalyticsSnippet(url, expectedGaId, fetchImpl = fetch) {
  if (!expectedGaId) {
    return;
  }

  const response = await fetchImpl(url);
  assert(response.ok, `Failed to fetch ${url} while checking analytics HTML contract (${response.status})`);
  const html = await response.text();
  const gaUrl = `https://www.googletagmanager.com/gtag/js?id=${expectedGaId}`;
  const hasPreload =
    html.includes(`rel="preload" href="${gaUrl}"`) ||
    html.includes(`href="${gaUrl}" rel="preload"`) ||
    html.includes(`href="${gaUrl}" as="script"`);

  assert(
    !hasPreload,
    `Expected GA ${expectedGaId} to load from the runtime component, not a first-paint HTML preload in ${url}`,
  );
}

export async function run() {
  const { mode: rawMode, skipOverflow, url: rawUrl } = parseArgs(process.argv.slice(2));
  const url = ensureUrl(rawUrl);
  const mode = ensureMode(rawMode);
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
    styleReadyTimeoutMs: readPositiveIntEnv("SMOKE_UI_STYLE_READY_TIMEOUT_MS", DEFAULT_STYLE_READY_TIMEOUT_MS),
    uiRetryCount,
    uiRetryDelayMs,
    waitTimeoutMs,
    expectedGaId,
    liveAnalyticsRetryCount:
      mode === "live" && expectedGaId
        ? readNonNegativeIntEnv("SMOKE_UI_LIVE_ANALYTICS_RETRY_COUNT", DEFAULT_LIVE_ANALYTICS_RETRY_COUNT)
        : 0,
    liveAnalyticsRetryDelayMs: readPositiveIntEnv(
      "SMOKE_UI_LIVE_ANALYTICS_RETRY_DELAY_MS",
      DEFAULT_LIVE_ANALYTICS_RETRY_DELAY_MS,
    ),
  };
  const overflowWorkerCount = getOverflowWorkerCount(mode, config.routes.length, skipOverflow);
  const overflowRouteChunks = chunkOverflowRoutes(config.routes, overflowWorkerCount);

  console.log(`[smoke-ui] Running ${mode} browser smoke checks against ${url}`);

  let browser = null;
  try {
    await verifyAnalyticsSnippet(url, expectedGaId);
    if (expectedGaId) {
      console.log(`[smoke-ui] OK analytics HTML preload contract ${expectedGaId}`);
    }

    const chromium = await loadChromium();
    browser = await launchChromiumBrowser(chromium);

    const runSmokeSession = async (smokeConfig, stepLabel) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const analyticsNetwork = {
        failures: [],
        requests: [],
        responses: [],
        violations: [],
      };
      const isAnalyticsUrl = (requestUrl) =>
        Boolean(smokeConfig.expectedGaId) && /googletagmanager|google-analytics|analytics\.google/.test(requestUrl);

      if (smokeConfig.expectedGaId) {
        await page.addInitScript(() => {
          window.__pharosSmokeCspViolations = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            window.__pharosSmokeCspViolations.push({
              blockedURI: event.blockedURI,
              effectiveDirective: event.effectiveDirective,
              sourceFile: event.sourceFile,
              violatedDirective: event.violatedDirective,
            });
          });
        });
      }

      page.on("request", (request) => {
        if (isAnalyticsUrl(request.url())) {
          analyticsNetwork.requests.push({
            method: request.method(),
            resourceType: request.resourceType(),
            url: request.url(),
          });
        }
      });
      page.on("response", (response) => {
        if (isAnalyticsUrl(response.url())) {
          analyticsNetwork.responses.push({
            status: response.status(),
            url: response.url(),
          });
        }
      });
      page.on("requestfailed", (request) => {
        if (isAnalyticsUrl(request.url())) {
          analyticsNetwork.failures.push({
            errorText: request.failure()?.errorText ?? "unknown",
            url: request.url(),
          });
        }
      });

      try {
        const result = await runSmokeRun(page, smokeConfig);
        if (smokeConfig.expectedGaId) {
          analyticsNetwork.violations = await page.evaluate(() => window.__pharosSmokeCspViolations ?? []);
        }
        return { ...result, analyticsNetwork };
      } catch (error) {
        throw new Error(`[smoke-ui] ${stepLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await context.close();
      }
    };

    const runHomepageSmokeSession = (stepLabel) =>
      runSmokeSession(
        {
          ...config,
          runOverflow: false,
        },
        stepLabel,
      );

    let homepageResult = await runHomepageSmokeSession("homepage");
    for (let attempt = 0; attempt < config.liveAnalyticsRetryCount; attempt += 1) {
      if (
        !shouldRetryLiveAnalyticsSmoke({
          expectedGaId,
          mode,
          network: homepageResult.analyticsNetwork,
          runtime: homepageResult.analyticsRuntime,
        })
      ) {
        break;
      }
      const retryNumber = attempt + 1;
      console.log(
        `[smoke-ui] WARN live analytics produced no runtime or network signal for ${expectedGaId}; retrying homepage smoke ${retryNumber}/${config.liveAnalyticsRetryCount}`,
      );
      await sleep(config.liveAnalyticsRetryDelayMs);
      homepageResult = await runHomepageSmokeSession(`homepage analytics retry ${retryNumber}`);
    }
    const summary = homepageResult.homepage;

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
    assert(
      summary.recentEvents?.ok === true,
      `Homepage recent-events site-data check failed (${formatRecentEventsSmoke(summary.recentEvents)}; ${formatUiSummary(summary)})`,
    );

    if (summary.hasLiveRefreshDelayed) {
      console.log(`[smoke-ui] WARN homepage shows a stale-data banner (${formatUiSummary(summary)})`);
    }
    console.log(`[smoke-ui] OK ${summary.title}`);
    console.log(`[smoke-ui] OK table rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}`);
    console.log(`[smoke-ui] OK recent-events site-data ${formatRecentEventsSmoke(summary.recentEvents)}`);

    if (expectedGaId) {
      const runtime = homepageResult.analyticsRuntime;
      assert(runtime, `Expected analytics runtime result for ${expectedGaId}`);
      const network = homepageResult.analyticsNetwork ?? { failures: [], requests: [], responses: [] };
      const tolerateCollectAbortAsSignal = mode === "local";
      const { collectResponses, hasCollectSignal, hasGtagScriptResponse } = getExpectedGaNetworkSignals(
        network,
        expectedGaId,
        { tolerateCollectAbortAsSignal },
      );
      const diagnostics = `runtime=${JSON.stringify(runtime)}, network=${JSON.stringify(network)}`;
      const hasRuntimeState = hasExpectedGaRuntimeState(runtime);
      if (mode === "local") {
        assert(hasRuntimeState, `Expected local analytics runtime state for ${expectedGaId}; ${diagnostics}`);
      } else if (!hasRuntimeState) {
        console.log(
          `[smoke-ui] WARN live analytics runtime global not observable for ${expectedGaId}; requiring network signal instead (${JSON.stringify(runtime)})`,
        );
      }
      assert(hasGtagScriptResponse, `Expected successful gtag.js load for ${expectedGaId}; ${diagnostics}`);
      assert(hasCollectSignal, `Expected GA4 page_view collect signal for ${expectedGaId}; ${diagnostics}`);
      const successfulCollectUrls = new Set(collectResponses.map((entry) => entry.url));
      const tolerateExpectedCollectAbort = tolerateCollectAbortAsSignal || collectResponses.length > 0;
      const unexpectedFailures = getUnexpectedGaAnalyticsFailures(
        network.failures,
        successfulCollectUrls,
        expectedGaId,
        { tolerateExpectedCollectAbort },
      );
      assert(
        unexpectedFailures.length === 0,
        `Found failed analytics request(s) for ${expectedGaId}; failures=${JSON.stringify(unexpectedFailures)}`,
      );
      const unexpectedCspViolations = getUnexpectedGaCspViolations(network.violations, expectedGaId);
      assert(
        unexpectedCspViolations.length === 0,
        `Found analytics CSP violation(s) for ${expectedGaId}; violations=${JSON.stringify(unexpectedCspViolations)}`,
      );
      const expectedCollectAbortCount = network.failures.filter((failure) =>
        isExpectedGaCollectAbort(failure, expectedGaId),
      ).length;
      if (tolerateExpectedCollectAbort && expectedCollectAbortCount > 0) {
        console.log(
          `[smoke-ui] WARN tolerated ${expectedCollectAbortCount} ${mode} GA collect abort(s) for ${expectedGaId}`,
        );
      }
      console.log(`[smoke-ui] OK analytics runtime ${expectedGaId}`);
    }

    const overflowChecks = [];
    if (!skipOverflow && overflowRouteChunks.length > 0) {
      console.log(
        `[smoke-ui] Running overflow sweep for ${config.routes.length} route(s) across ${overflowRouteChunks.length} worker(s)`,
      );

      const overflowResults = await Promise.allSettled(
        overflowRouteChunks.map(async (routes, index) => {
          const workerNumber = index + 1;
          const result = await runSmokeSession(
            {
              ...config,
              routes,
              runHomepage: false,
            },
            `overflow worker ${workerNumber}`,
          );
          return {
            checks: result.overflowChecks ?? [],
            routes,
            workerNumber,
          };
        }),
      );

      const failedWorker = overflowResults.find((result) => result.status === "rejected");
      if (failedWorker) {
        throw failedWorker.reason;
      }

      for (const result of overflowResults) {
        if (result.status === "fulfilled") {
          console.log(
            `[smoke-ui] OK overflow worker ${result.value.workerNumber}/${overflowRouteChunks.length} routes=${result.value.routes.join(", ")}`,
          );
          overflowChecks.push(...result.value.checks);
        }
      }
    }

    for (const check of overflowChecks) {
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
    await browser?.close();
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[smoke-ui] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
