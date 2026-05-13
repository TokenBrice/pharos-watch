#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.SEO_RENDER_BUDGET_URL ?? "https://pharos.watch";
const DEFAULT_ROUTES = [
  "/",
  "/stablecoin/usdt-tether/",
  "/stablecoin/usdc-circle/",
  "/chains/ethereum/",
  "/liquidity/",
  "/depeg/",
  "/yield/",
  "/safety-scores/",
  "/flows/",
  "/api/",
];

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    routes: DEFAULT_ROUTES,
    json: false,
    waitMs: 4000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      args.baseUrl = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--routes") {
      args.routes = (argv[i + 1] ?? "")
        .split(",")
        .map((route) => route.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--wait-ms") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(value) && value >= 0) args.waitMs = value;
      i += 1;
    }
  }

  if (args.routes.length === 0) {
    throw new Error("At least one route is required. Pass --routes /,/stablecoin/usdt-tether/.");
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

function classifyResource(url, resourceType) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/_site-data/")) return "siteData";
  if (resourceType === "script" || pathname.endsWith(".js")) return "script";
  if (resourceType === "stylesheet" || pathname.endsWith(".css")) return "style";
  if (resourceType === "font" || /\.(woff2?|ttf|otf)$/i.test(pathname)) return "font";
  if (resourceType === "image" || /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(pathname)) return "image";
  return "other";
}

function emptyCounters() {
  return {
    requests: 0,
    scriptRequests: 0,
    styleRequests: 0,
    fontRequests: 0,
    imageRequests: 0,
    siteDataRequests: 0,
    knownContentLengthBytes: 0,
    scriptKnownBytes: 0,
    styleKnownBytes: 0,
    fontKnownBytes: 0,
  };
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

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "PharosSeoRenderBudgetAudit/1.0",
    },
  });
  const html = await response.text();
  return {
    status: response.status,
    htmlBytes: byteLength(html),
    cacheControl: response.headers.get("cache-control") ?? "",
    cdnCacheControl: response.headers.get("cdn-cache-control") ?? "",
    cfCacheStatus: response.headers.get("cf-cache-status") ?? "",
    contentType: response.headers.get("content-type") ?? "",
  };
}

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new Error(
      `Failed to load Playwright from workspace dependencies: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getLaunchOptions() {
  const executablePath = (process.env.SEO_AUDIT_BROWSER_EXECUTABLE_PATH ?? "").trim();
  if (executablePath) return { executablePath, headless: true };

  const channel = (process.env.SEO_AUDIT_BROWSER_CHANNEL ?? "").trim();
  if (channel) return { channel, headless: true };

  return { headless: true };
}

async function auditRoute(browser, baseUrl, route, waitMs) {
  const url = resolveRoute(baseUrl, route);
  const counters = emptyCounters();
  const html = await fetchHtml(url);
  const page = await browser.newPage();
  page.on("response", (response) => {
    try {
      addResponse(counters, response);
    } catch {
      // Best-effort audit; individual response accounting should not abort the route.
    }
  });

  const started = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    if (!nav) return null;
    return {
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadMs: Math.round(nav.loadEventEnd),
      responseStartMs: Math.round(nav.responseStart),
    };
  });
  const title = await page.title();
  const textLength = await page.locator("main").evaluate((main) => main.textContent?.replace(/\s+/g, " ").trim().length ?? 0).catch(() => 0);
  await page.close();

  return {
    route,
    url,
    title,
    elapsedMs: Date.now() - started,
    mainTextChars: textLength,
    ...html,
    ...counters,
    timing,
  };
}

function formatTable(rows) {
  const headers = [
    "route",
    "status",
    "htmlKB",
    "mainChars",
    "req",
    "jsReq",
    "cssReq",
    "fontReq",
    "siteData",
    "knownKB",
    "cfCache",
  ];
  const lines = [headers.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.route,
        row.status,
        Math.round(row.htmlBytes / 1024),
        row.mainTextChars,
        row.requests,
        row.scriptRequests,
        row.styleRequests,
        row.fontRequests,
        row.siteDataRequests,
        Math.round(row.knownContentLengthBytes / 1024),
        row.cfCacheStatus || "-",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const chromium = await loadChromium();
  const browser = await chromium.launch(getLaunchOptions());

  try {
    const rows = [];
    for (const route of args.routes) {
      rows.push(await auditRoute(browser, baseUrl, route, args.waitMs));
    }

    if (args.json) {
      console.log(JSON.stringify({ baseUrl: baseUrl.toString(), generatedAt: new Date().toISOString(), rows }, null, 2));
    } else {
      console.log(formatTable(rows));
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

