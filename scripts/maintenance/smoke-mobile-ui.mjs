#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  captureFailureScreenshot,
  ensureHttpUrl,
  getBoundedWorkerCount,
  isDirectRun,
  launchChromiumBrowser,
  loadChromium,
  normalizeRouteList,
  parseCliOptions,
  parsePositiveInt,
  retrySmokeOperation,
} from "../lib/smoke-runtime.mjs";

const DEFAULT_URL = process.env.SMOKE_MOBILE_UI_URL ?? process.env.SMOKE_UI_URL ?? "http://localhost:3000";
const DEFAULT_WAIT_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOUCH_TARGET_PX = 44;
const DEFAULT_TOUCH_HARD_FLOOR_PX = 24;
const DEFAULT_DESKTOP_VIEWPORT = { label: "desktop-1280x900", width: 1280, height: 900 };
const DEFAULT_MOBILE_UI_WORKERS = 2;
const MAX_MOBILE_UI_WORKERS = 6;

export const DEFAULT_MOBILE_UI_ROUTES = [
  "/",
  "/stablecoins/",
  "/screener/",
  "/stablecoin/usdt-tether/",
  "/timeline/",
  "/compare/",
  "/dependency-map/",
  "/flows/",
  "/alt-pegs/",
  "/liquidity/",
  "/chains/",
  "/yield/",
  "/freezewatch/",
  "/coverage/",
  "/portfolio/",
  "/cemetery/",
  "/pharoswatchbot/",
];

export const DEFAULT_MOBILE_UI_VIEWPORTS = [
  { label: "mobile-360x740", width: 360, height: 740 },
  { label: "mobile-390x844", width: 390, height: 844 },
  { label: "mobile-414x896", width: 414, height: 896 },
];

export function parseArgs(argv) {
  const skipDesktopDefault = (process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP ?? "1") !== "0";
  const args = {
    desktopViewport: process.env.SMOKE_MOBILE_UI_DESKTOP_VIEWPORT ?? "",
    failureScreenshotDir: process.env.SMOKE_MOBILE_UI_FAILURE_SCREENSHOT_DIR ?? "",
    routes: process.env.SMOKE_MOBILE_UI_ROUTES ?? "",
    skipDesktop: skipDesktopDefault,
    skipTouch: process.env.SMOKE_MOBILE_UI_SKIP_TOUCH === "1",
    strictTouchTargets: process.env.SMOKE_MOBILE_UI_STRICT_TOUCH_TARGETS === "1",
    timeoutMs: process.env.SMOKE_MOBILE_UI_TIMEOUT_MS ?? "",
    url: DEFAULT_URL,
    viewports: process.env.SMOKE_MOBILE_UI_VIEWPORTS ?? "",
    waitMs: process.env.SMOKE_MOBILE_UI_WAIT_MS ?? "",
    workers: process.env.SMOKE_MOBILE_UI_WORKERS ?? "",
  };

  parseCliOptions(argv, {
    "--url": ({ readValue }) => {
      args.url = readValue();
      return "value";
    },
    "--routes": ({ readValue }) => {
      args.routes = readValue();
      return "value";
    },
    "--viewports": ({ readValue }) => {
      args.viewports = readValue();
      return "value";
    },
    "--desktop-viewport": ({ readValue }) => {
      args.desktopViewport = readValue();
      return "value";
    },
    "--timeout-ms": ({ readValue }) => {
      args.timeoutMs = readValue();
      return "value";
    },
    "--wait-ms": ({ readValue }) => {
      args.waitMs = readValue();
      return "value";
    },
    "--skip-desktop": () => {
      args.skipDesktop = true;
    },
    "--include-desktop": () => {
      args.skipDesktop = false;
    },
    "--skip-touch": () => {
      args.skipTouch = true;
    },
    "--strict-touch-targets": () => {
      args.strictTouchTargets = true;
    },
    "--workers": ({ readValue }) => {
      args.workers = readValue();
      return "value";
    },
    "--failure-screenshot-dir": ({ readValue }) => {
      args.failureScreenshotDir = readValue();
      return "value";
    },
  });

  return args;
}

function ensureUrl(input) {
  return ensureHttpUrl(input, "Missing URL. Pass --url http://localhost:3000 or set SMOKE_MOBILE_UI_URL.");
}

export function parseRouteList(input, fallback = DEFAULT_MOBILE_UI_ROUTES) {
  return normalizeRouteList(input, fallback);
}

function parseViewportToken(token) {
  const normalized = (token ?? "").trim().toLowerCase();
  const match = normalized.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { label: `${width}x${height}`, width, height };
}

export function parseViewportList(input, fallback = DEFAULT_MOBILE_UI_VIEWPORTS) {
  const viewports = (input ?? "")
    .split(",")
    .map((token) => parseViewportToken(token))
    .filter(Boolean);
  return viewports.length > 0 ? viewports : fallback;
}

function parseDesktopViewport(input) {
  return parseViewportToken(input) ?? DEFAULT_DESKTOP_VIEWPORT;
}

export function isAllowedSmallTouchTarget(target) {
  if (target.explicitAllow) return true;
  if (target.inVisualization) return true;
  if (target.isInlineTextLink) return true;
  if (target.isVisuallyHidden) return true;
  if (target.isFixedStatusStrip) return true;
  if (target.disabled) return true;
  return false;
}

export function isMeasurableTableRow(row) {
  // Skeleton rows are real <tr> elements rendered during loading states; they
  // say nothing about real column geometry.
  return !row.querySelector('[data-slot="skeleton"]');
}

export function getTouchScanOutcome(scan, { strictTouchTargets = false } = {}) {
  const hardFloor = scan.violations.filter((entry) => entry.severity === "hard-floor");
  const targetWarnings = scan.violations.filter((entry) => entry.severity === "target");
  const strictFailures = strictTouchTargets
    ? targetWarnings.filter((entry) => entry.strictRequired !== false && entry.height < DEFAULT_TOUCH_TARGET_PX)
    : [];
  return {
    failCount: hardFloor.length + strictFailures.length,
    hardFloor,
    strictFailures,
    targetWarnings,
  };
}

export function getConsoleScanOutcome(messages = []) {
  return {
    errors: messages.filter((entry) => entry.type === "error"),
    warnings: messages.filter((entry) => entry.type === "warning"),
  };
}

export function getTableScanOutcome(tableScan) {
  return {
    failCount: tableScan?.issues?.length ?? 0,
    issues: tableScan?.issues ?? [],
  };
}

function joinUrl(baseUrl, route) {
  const parsed = new URL(baseUrl);
  if (route === "/") return parsed.toString();
  return new URL(route, parsed).toString();
}

function sanitizeLabel(label) {
  return label.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "route";
}

const SETTLE_POLL_INTERVAL_MS = 250;

async function waitForSettledPage(page, waitMs) {
  if (typeof page.waitForLoadState !== "function") {
    await page.evaluate((timeoutMs) => new Promise((resolve) => window.setTimeout(resolve, timeoutMs)), waitMs);
    return;
  }

  // Adaptive settle: the fixed post-load sleep this replaces existed to let
  // client hydration land data-driven table rows before the geometry scan
  // (/flows captured 0/5 columns under CPU contention). Waiting for network
  // idle plus one stable row/text sample pays only the real hydration time;
  // waitMs remains the hard cap so slow machines degrade to the old behavior
  // instead of flaking.
  const deadline = Date.now() + waitMs;
  try {
    await page.waitForLoadState("networkidle", { timeout: waitMs });
  } catch {
    return;
  }

  let previous = null;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(
      () => `${document.querySelectorAll("tbody tr").length}:${(document.body?.innerText ?? "").length}`,
    );
    if (previous !== null && sample === previous) {
      return;
    }
    previous = sample;
    await page.waitForTimeout(Math.min(SETTLE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

function buildRouteCaptureScript() {
  const allowlistFn = isAllowedSmallTouchTarget.toString();
  const measurableRowFn = isMeasurableTableRow.toString();
  return `async ({ scanTableGeometry, scanTouchTargets, touchHardFloorPx, touchTargetPx }) => {
    const isAllowedSmallTouchTarget = ${allowlistFn};
    const isMeasurableTableRow = ${measurableRowFn};
    const text = document.body?.innerText ?? "";
    const doc = document.documentElement;
    const body = document.body;
    const innerWidth = window.innerWidth;
    const scrollWidth = Math.max(doc?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
    const overlayTexts = [
      "Unhandled Runtime Error",
      "Application error: a client-side exception has occurred",
      "Build Error",
      "Hydration failed",
    ];
    const hasFrameworkOverlay =
      Boolean(document.querySelector("[data-nextjs-dialog]"))
      || Array.from(document.querySelectorAll("nextjs-portal")).some((el) => (el.textContent ?? "").trim().length > 0)
      || overlayTexts.some((value) => text.includes(value));

    const isElementVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && !el.closest("[hidden], [inert], [aria-hidden='true']")
      );
    };

    const safeClassName = (el) => {
      const raw = typeof el.className === "string" ? el.className : "";
      return raw.replace(/\\s+/g, " ").trim();
    };

    const shortSelector = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return \`\${tag}#\${el.id}\`;
      const role = el.getAttribute("role");
      const classes = safeClassName(el).split(" ").filter(Boolean).slice(0, 3).join(".");
      const rolePart = role ? \`[role="\${role}"]\` : "";
      return classes ? \`\${tag}\${rolePart}.\${classes}\` : \`\${tag}\${rolePart}\`;
    };

    const describeTarget = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? "";
      const href = el.getAttribute("href") ?? "";
      const className = safeClassName(el);
      const explicitAllow = Boolean(el.closest("[data-mobile-smoke-allow-small-target]"));
      const inVisualization = Boolean(
        el.closest("svg, canvas, .recharts-wrapper, [class*='chart'], [class*='Chart'], [class*='map'], [class*='Map'], [class*='graph'], [class*='Graph']")
      );
      const inTextBlock = Boolean(el.closest("p, li, article, [class*='prose'], [class*='markdown']"));
      const hasButtonChrome = /(?:^|\\s)(?:border|rounded-full|bg-)/.test(className);
      const isTextAnchor = tagName === "a" && role !== "button" && !hasButtonChrome;
      const isInlineTextLink =
        isTextAnchor
        && (inTextBlock || style.display.startsWith("inline") || (rect.height <= 28 && !hasButtonChrome));
      const isVisuallyHidden = className.split(" ").some((value) => value === "sr-only") && document.activeElement !== el;
      const isFixedStatusStrip =
        style.position === "fixed" && rect.width >= window.innerWidth - 2 && rect.height <= 8;
      const strictRequired = Boolean(
        tagName === "tr"
        || ["input", "select", "textarea"].includes(tagName)
        || /(?:^|\\s)(?:h-11|min-h-11|w-11|min-w-11)(?:\\s|$)/.test(className)
      );
      return {
        className,
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        explicitAllow,
        height: Math.round(rect.height),
        href,
        inVisualization,
        isInlineTextLink,
        isFixedStatusStrip,
        isVisuallyHidden,
        label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
        role,
        selector: shortSelector(el),
        strictRequired,
        tagName,
        width: Math.round(rect.width),
      };
    };

    const intersects = (a, b) => (
      a.right > b.left
      && a.left < b.right
      && a.bottom > b.top
      && a.top < b.bottom
    );

    const getHorizontalViewport = (el) => {
      let current = el.parentElement;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (style.overflowX === "auto" || style.overflowX === "scroll") {
          return current.getBoundingClientRect();
        }
        current = current.parentElement;
      }
      return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    };

    const textLikelyOverflowsCell = (cell) => {
      const text = (cell.innerText ?? "").replace(/\\s+/g, " ").trim();
      if (text.length <= 1) return false;
      const style = getComputedStyle(cell);
      if (style.overflowX !== "visible" && style.overflow !== "visible") return false;
      return cell.scrollWidth > cell.clientWidth + 8 && cell.clientWidth < 96;
    };

    const describeTableCell = (cell) => {
      const rect = cell.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        label: (cell.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 60),
        selector: shortSelector(cell),
        width: Math.round(rect.width),
      };
    };

    const tableScan = {
      checked: 0,
      issues: [],
    };

    if (scanTableGeometry) {
      for (const table of document.querySelectorAll("table")) {
        if (!isElementVisible(table)) continue;
        // Screen-reader chart data tables live inside an sr-only wrapper: the
        // 1px clipped wrapper hides them visually, but the inner <table> keeps
        // its natural layout rects, so it has no visual geometry to check.
        if (table.closest(".sr-only")) continue;
        const measurableRows = Array.from(table.querySelectorAll("tbody tr"))
          .filter(isElementVisible)
          .filter(isMeasurableTableRow);
        // Column geometry is only meaningful once real data rows exist: an
        // empty or skeleton-only tbody (data still loading, or upstream/proxy
        // failure leaving the shell rendered) collapses fixed-layout columns
        // to zero width, so the table is unmeasurable rather than broken.
        if (measurableRows.length === 0) continue;
        tableScan.checked += 1;
        const tableRect = table.getBoundingClientRect();
        const tableViewport = getHorizontalViewport(table);
        const headerCells = Array.from(table.querySelectorAll("thead th")).filter(isElementVisible);
        const visibleHeaderCells = headerCells
          .map((cell) => ({ cell, rect: cell.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 1 && intersects(rect, tableViewport))
          .sort((a, b) => a.rect.left - b.rect.left);

        if (headerCells.length >= 3 && visibleHeaderCells.length < 3) {
          tableScan.issues.push({
            kind: "too-few-visible-columns",
            selector: shortSelector(table),
            detail: \`\${visibleHeaderCells.length}/\${headerCells.length} header columns visible\`,
          });
        }

        for (let index = 0; index < visibleHeaderCells.length - 1; index += 1) {
          const current = visibleHeaderCells[index];
          const next = visibleHeaderCells[index + 1];
          if (current.rect.right > next.rect.left + 1) {
            tableScan.issues.push({
              kind: "header-overlap",
              selector: shortSelector(table),
              detail: \`\${describeTableCell(current.cell).label || "header"} overlaps \${describeTableCell(next.cell).label || "next header"}\`,
            });
            break;
          }
        }

        const overflowingHeader = visibleHeaderCells.find(({ cell }) => textLikelyOverflowsCell(cell));
        if (overflowingHeader) {
          tableScan.issues.push({
            kind: "header-text-overflow",
            selector: shortSelector(table),
            detail: JSON.stringify(describeTableCell(overflowingHeader.cell)),
          });
        }

        for (const row of measurableRows.slice(0, 3)) {
          const visibleCells = Array.from(row.children)
            .filter(isElementVisible)
            .map((cell) => ({ cell, rect: cell.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 1 && intersects(rect, tableViewport))
            .sort((a, b) => a.rect.left - b.rect.left);
          const overflowingCell = visibleCells.find(({ cell }) => textLikelyOverflowsCell(cell));
          if (overflowingCell) {
            tableScan.issues.push({
              kind: "body-cell-text-overflow",
              selector: shortSelector(table),
              detail: JSON.stringify(describeTableCell(overflowingCell.cell)),
            });
            break;
          }
        }

        if (tableRect.width < Math.min(window.innerWidth - 16, 320) && headerCells.length >= 4) {
          tableScan.issues.push({
            kind: "table-too-narrow",
            selector: shortSelector(table),
            detail: \`table width \${Math.round(tableRect.width)}px for \${headerCells.length} columns\`,
          });
        }
      }
    }

    const touchScan = {
      allowedSmallTargets: 0,
      checked: 0,
      skipped: scanTouchTargets ? 0 : null,
      violations: [],
    };

    if (scanTouchTargets) {
      const selector = [
        "a[href]",
        "button",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "summary",
        "[role='button']",
        "[role='link']",
        "[role='combobox']",
        "[role='tab']",
        "[role='menuitem']",
        "[tabindex]:not([tabindex='-1'])",
      ].join(",");
      const seen = new Set();
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !isElementVisible(el)) continue;
        seen.add(el);
        touchScan.checked += 1;
        const target = describeTarget(el);
        const minDimension = Math.min(target.width, target.height);
        if (minDimension >= touchTargetPx) continue;
        if (isAllowedSmallTouchTarget(target)) {
          touchScan.allowedSmallTargets += 1;
          continue;
        }
        touchScan.violations.push({
          ...target,
          minDimension,
          severity: minDimension < touchHardFloorPx ? "hard-floor" : "target",
        });
      }
    }

    return {
      hasFrameworkOverlay,
      innerWidth,
      overflowDelta: scrollWidth - innerWidth,
      scrollWidth,
      textLength: text.replace(/\\s+/g, " ").trim().length,
      textPreview: text.replace(/\\s+/g, " ").trim().slice(0, 160),
      title: document.title,
      tableScan,
      touchScan,
    };
  }`;
}

const ROUTE_CAPTURE_FN = Function(`return (${buildRouteCaptureScript()});`)();

async function captureRoute(page, { route, scanTableGeometry, scanTouchTargets, timeoutMs, url, viewport, waitMs }) {
  const routeUrl = joinUrl(url, route);
  const response = await page.goto(routeUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  await waitForSettledPage(page, waitMs);
  const summary = await page.evaluate(ROUTE_CAPTURE_FN, {
    scanTableGeometry,
    scanTouchTargets,
    touchHardFloorPx: DEFAULT_TOUCH_HARD_FLOOR_PX,
    touchTargetPx: DEFAULT_TOUCH_TARGET_PX,
  });
  return {
    ...summary,
    route,
    routeUrl,
    status: response?.status() ?? null,
    viewport,
  };
}

function formatViewport(viewport) {
  return `${viewport.width}x${viewport.height}`;
}

function formatTouchTarget(entry) {
  const label = entry.label ? ` "${entry.label}"` : "";
  return `${entry.severity} ${entry.selector}${label} ${entry.width}x${entry.height}`;
}

function formatConsoleMessage(entry) {
  return `${entry.type}: ${entry.text}`;
}

export function assertRouteSummary(summary, { strictTouchTargets }) {
  const failures = [];
  if (summary.status != null && summary.status >= 400) {
    failures.push(`HTTP ${summary.status}`);
  }
  if (summary.textLength < 20) {
    failures.push(`blank or nearly blank body (${summary.textLength} chars)`);
  }
  if (summary.hasFrameworkOverlay) {
    failures.push("framework error overlay detected");
  }
  if (summary.overflowDelta > 1) {
    failures.push(`horizontal overflow ${summary.scrollWidth}px > ${summary.innerWidth}px`);
  }
  const tableOutcome = getTableScanOutcome(summary.tableScan);
  if (tableOutcome.failCount > 0) {
    failures.push(
      `table geometry failures=${tableOutcome.failCount} (${tableOutcome.issues
        .slice(0, 3)
        .map((entry) => `${entry.kind} ${entry.detail}`)
        .join("; ")})`,
    );
  }
  if (summary.touchScan) {
    const touchOutcome = getTouchScanOutcome(summary.touchScan, { strictTouchTargets });
    if (touchOutcome.failCount > 0) {
      const blockingEntries = strictTouchTargets
        ? [...touchOutcome.hardFloor, ...touchOutcome.strictFailures]
        : touchOutcome.hardFloor;
      failures.push(
        `touch target failures=${touchOutcome.failCount} (${summary.touchScan.violations
          .filter((entry) => blockingEntries.includes(entry))
          .slice(0, 4)
          .map(formatTouchTarget)
          .join("; ")})`,
      );
    }
  }
  return failures;
}

async function maybeCaptureFailureScreenshot(page, dir, label) {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return null;
  await mkdir(trimmed, { recursive: true });
  const path = join(trimmed, `${sanitizeLabel(label)}.png`);
  return captureFailureScreenshot(page, path);
}

async function runRouteCheck(page, options) {
  const { failureScreenshotDir, strictTouchTargets, viewport } = options;
  await page.setViewportSize({ height: viewport.height, width: viewport.width });
  const consoleMessages = [];
  const onConsole = (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text().slice(0, 240) });
    }
  };
  page.on("console", onConsole);
  try {
    const summary = await retrySmokeOperation(() => captureRoute(page, options), {
      retries: 1,
      onRetry: ({ error: navigationError }) => {
        console.log(
          `[mobile-ui-smoke] RETRY ${options.route} @ ${formatViewport(viewport)} after navigation error: ${
            navigationError instanceof Error ? navigationError.message.split("\n")[0] : String(navigationError)
          }`,
        );
      },
    });
    const failures = assertRouteSummary(summary, { consoleMessages, strictTouchTargets });
    if (failures.length > 0) {
      const screenshotPath = await maybeCaptureFailureScreenshot(
        page,
        failureScreenshotDir,
        `${formatViewport(viewport)}-${options.route}`,
      );
      return { consoleMessages, failures, screenshotPath, summary };
    }
    return { consoleMessages, failures, screenshotPath: null, summary };
  } finally {
    page.off("console", onConsole);
  }
}

function printTouchWarnings(prefix, touchScan) {
  const targetWarnings = touchScan.violations.filter((entry) => entry.severity === "target");
  if (targetWarnings.length === 0) return;
  const preview = targetWarnings.slice(0, 5).map(formatTouchTarget).join("; ");
  console.log(`[mobile-ui-smoke] WARN ${prefix} touch target <44px count=${targetWarnings.length}: ${preview}`);
}

function printConsoleWarnings(prefix, consoleMessages) {
  const { errors, warnings } = getConsoleScanOutcome(consoleMessages);
  if (errors.length > 0) {
    const preview = errors.slice(0, 3).map(formatConsoleMessage).join("; ");
    console.log(`[mobile-ui-smoke] WARN ${prefix} console errors=${errors.length}: ${preview}`);
  }
  if (warnings.length === 0) return;
  const preview = warnings.slice(0, 3).map(formatConsoleMessage).join("; ");
  console.log(`[mobile-ui-smoke] WARN ${prefix} console warnings=${warnings.length}: ${preview}`);
}

function toCheckPlans(routes, viewports) {
  const plans = [];
  for (const viewport of viewports) {
    for (const route of routes) {
      plans.push({ route, viewport });
    }
  }
  return plans;
}

export function getMobileWorkerCount(taskCount, workersInput) {
  if (taskCount <= 0) {
    return 1;
  }
  return getBoundedWorkerCount(taskCount, workersInput, {
    fallback: DEFAULT_MOBILE_UI_WORKERS,
    maximum: MAX_MOBILE_UI_WORKERS,
  });
}

export async function run(argv = process.argv.slice(2)) {
  const rawArgs = parseArgs(argv);
  const url = ensureUrl(rawArgs.url);
  const routes = parseRouteList(rawArgs.routes);
  const viewports = parseViewportList(rawArgs.viewports);
  const mobilePlans = toCheckPlans(routes, viewports);
  const mobileWorkerCount = getMobileWorkerCount(mobilePlans.length, rawArgs.workers);
  const desktopViewport = parseDesktopViewport(rawArgs.desktopViewport);
  const timeoutMs = parsePositiveInt(rawArgs.timeoutMs, DEFAULT_TIMEOUT_MS);
  const waitMs = parsePositiveInt(rawArgs.waitMs, DEFAULT_WAIT_MS);

  console.log(`[mobile-ui-smoke] URL ${url}`);
  console.log(`[mobile-ui-smoke] Routes ${routes.join(", ")}`);
  console.log(`[mobile-ui-smoke] Mobile viewports ${viewports.map(formatViewport).join(", ")}`);
  if (!rawArgs.skipDesktop) {
    console.log(`[mobile-ui-smoke] Desktop spot viewport ${formatViewport(desktopViewport)}`);
  }
  console.log(
    `[mobile-ui-smoke] Touch scan ${
      rawArgs.skipTouch ? "disabled" : rawArgs.strictTouchTargets ? "strict" : "hard-floor fail, 44px warn"
    }`,
  );
  console.log(`[mobile-ui-smoke] Mobile workers ${mobileWorkerCount}`);

  const chromium = await loadChromium();
  const browser = await launchChromiumBrowser(chromium);
  const context = await browser.newContext();
  const failures = [];

  try {
    const runMobileWorker = async (workerIndex) => {
      const page = await context.newPage();
      try {
        for (let planIndex = workerIndex; planIndex < mobilePlans.length; planIndex += mobileWorkerCount) {
          const { route, viewport } = mobilePlans[planIndex];
          const result = await runRouteCheck(page, {
            failureScreenshotDir: rawArgs.failureScreenshotDir,
            route,
            scanTableGeometry: true,
            scanTouchTargets: !rawArgs.skipTouch,
            strictTouchTargets: rawArgs.strictTouchTargets,
            timeoutMs,
            url,
            viewport,
            waitMs,
          });
          const { summary } = result;
          const prefix = `${route} @ ${formatViewport(viewport)}`;
          if (result.failures.length > 0) {
            failures.push({ ...result, prefix });
            console.log(`[mobile-ui-smoke] FAIL mobile ${prefix}: ${result.failures.join("; ")}`);
            if (result.screenshotPath) {
              console.log(`[mobile-ui-smoke] FAIL screenshot ${result.screenshotPath}`);
            }
          } else {
            console.log(
              `[mobile-ui-smoke] OK mobile ${prefix} overflow=${summary.overflowDelta}px tablesChecked=${summary.tableScan.checked} touchChecked=${summary.touchScan.checked}`,
            );
            printConsoleWarnings(prefix, result.consoleMessages);
            if (!rawArgs.skipTouch && !rawArgs.strictTouchTargets) {
              printTouchWarnings(prefix, summary.touchScan);
            }
          }
        }
      } finally {
        await page.close();
      }
    };

    await Promise.all(Array.from({ length: mobileWorkerCount }, (_unused, index) => runMobileWorker(index)));

    if (!rawArgs.skipDesktop) {
      const desktopPage = await context.newPage();
      try {
        for (const route of routes) {
          const result = await runRouteCheck(desktopPage, {
            failureScreenshotDir: rawArgs.failureScreenshotDir,
            route,
            scanTableGeometry: false,
            scanTouchTargets: false,
            strictTouchTargets: false,
            timeoutMs,
            url,
            viewport: desktopViewport,
            waitMs,
          });
          const { summary } = result;
          const prefix = `${route} @ ${formatViewport(desktopViewport)}`;
          if (result.failures.length > 0) {
            failures.push({ ...result, prefix });
            console.log(`[mobile-ui-smoke] FAIL desktop ${prefix}: ${result.failures.join("; ")}`);
            if (result.screenshotPath) {
              console.log(`[mobile-ui-smoke] FAIL screenshot ${result.screenshotPath}`);
            }
          } else {
            console.log(
              `[mobile-ui-smoke] OK desktop ${prefix} overflow=${summary.overflowDelta}px tablesChecked=${summary.tableScan.checked}`,
            );
            printConsoleWarnings(prefix, result.consoleMessages);
          }
        }
      } finally {
        await desktopPage.close();
      }
    }

    if (failures.length > 0) {
      const lines = failures.map((failure) => `- ${failure.prefix}: ${failure.failures.join("; ")}`);
      throw new Error(`Mobile UI smoke found ${failures.length} failing check(s):\n${lines.join("\n")}`);
    }

    console.log("[mobile-ui-smoke] All checks passed.");
  } finally {
    await context.close();
    await browser.close();
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[mobile-ui-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
