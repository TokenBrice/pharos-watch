#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_API_URL = "http://api.pharos.watch/api/health?smoke=transport";
const DEFAULT_SITE_API_URL = "http://site-api.pharos.watch/api/stablecoins?limit=1&smoke=transport";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const args = {
    apiUrl: process.env.SMOKE_TRANSPORT_API_URL ?? DEFAULT_API_URL,
    siteApiUrl: process.env.SMOKE_TRANSPORT_SITE_API_URL ?? DEFAULT_SITE_API_URL,
    timeoutMs: parsePositiveInt(process.env.SMOKE_TRANSPORT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api-url") {
      args.apiUrl = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--site-api-url") {
      args.siteApiUrl = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parsePositiveInt(argv[i + 1], args.timeoutMs);
      i += 1;
    }
  }

  return args;
}

function ensureHttpUrl(input, label) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error(`Missing ${label} URL.`);
  }

  const url = new URL(trimmed);
  assert(url.protocol === "http:", `${label} URL must use http:// so the edge redirect is exercised.`);
  return url;
}

function buildExpectedLocation(url) {
  const expected = new URL(url.toString());
  expected.protocol = "https:";
  return expected.toString();
}

async function fetchRedirect(url, timeoutMs) {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
  };
}

async function runCheck(label, rawUrl, timeoutMs) {
  const url = ensureHttpUrl(rawUrl, label);
  const expectedLocation = buildExpectedLocation(url);

  const result = await fetchRedirect(url.toString(), timeoutMs);

  assert(
    result.status === 308,
    `${label} expected 308 before application auth, got ${result.status} for ${url.toString()}`,
  );
  assert(result.location, `${label} redirect response omitted the Location header`);
  assert(
    result.location === expectedLocation,
    `${label} redirect Location mismatch: expected ${expectedLocation}, got ${result.location}`,
  );

  console.log(`[smoke-transport] OK ${label} ${url.toString()} -> ${result.location}`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  await Promise.all([
    runCheck("api", args.apiUrl, args.timeoutMs),
    runCheck("site-api", args.siteApiUrl, args.timeoutMs),
  ]);

  console.log("[smoke-transport] All checks passed.");
}

run().catch((error) => {
  console.error(`[smoke-transport] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
