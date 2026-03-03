#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 12_000;

function parseArgs(argv) {
  const args = { baseUrl: process.env.SMOKE_API_BASE ?? process.env.API_BASE_URL ?? "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      args.baseUrl = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return args;
}

function ensureBaseUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "Missing API base URL. Pass --base-url https://... or set SMOKE_API_BASE/API_BASE_URL."
    );
  }

  const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  new URL(normalized);
  return normalized;
}

async function fetchJson(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { url, status: res.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const { baseUrl: rawBaseUrl } = parseArgs(process.argv.slice(2));
  const baseUrl = ensureBaseUrl(rawBaseUrl);
  console.log(`[smoke-api] Running checks against ${baseUrl}`);

  const health = await fetchJson(baseUrl, "/api/health");
  assert(health.status === 200, `/api/health returned ${health.status}`);
  assert(
    health.body && ["healthy", "degraded", "stale"].includes(health.body.status),
    "/api/health missing valid status"
  );
  console.log(`[smoke-api] OK /api/health (${health.body.status})`);

  const stablecoins = await fetchJson(baseUrl, "/api/stablecoins");
  assert(stablecoins.status === 200, `/api/stablecoins returned ${stablecoins.status}`);
  assert(
    stablecoins.body && Array.isArray(stablecoins.body.peggedAssets),
    "/api/stablecoins missing peggedAssets[]"
  );
  assert(
    stablecoins.body.peggedAssets.length > 0,
    "/api/stablecoins returned empty peggedAssets[]"
  );
  console.log(`[smoke-api] OK /api/stablecoins (${stablecoins.body.peggedAssets.length} assets)`);

  const pegSummary = await fetchJson(baseUrl, "/api/peg-summary");
  assert(pegSummary.status === 200, `/api/peg-summary returned ${pegSummary.status}`);
  assert(pegSummary.body && Array.isArray(pegSummary.body.coins), "/api/peg-summary missing coins[]");
  assert(pegSummary.body.coins.length > 0, "/api/peg-summary returned empty coins[]");
  console.log(`[smoke-api] OK /api/peg-summary (${pegSummary.body.coins.length} coins)`);

  console.log("[smoke-api] All checks passed.");
}

run().catch((error) => {
  console.error(`[smoke-api] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
