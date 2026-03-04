#!/usr/bin/env node

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_TIMEOUT_MS = 12_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRICT_PATHS_FILE = path.join(__dirname, "../src/lib/strict-contract-paths.json");

function parseArgs(argv) {
  const args = { baseUrl: process.env.SMOKE_API_BASE ?? process.env.API_BASE_URL ?? "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url" || arg === "--base") {
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stripMeta(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("_meta" in body)) {
    return body;
  }
  const { _meta: _ignoredMeta, ...rest } = body;
  return rest;
}

function loadStrictContractPaths() {
  const raw = readFileSync(STRICT_PATHS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  assert(Array.isArray(parsed), `Invalid strict path file: ${STRICT_PATHS_FILE}`);
  for (const p of parsed) {
    assert(typeof p === "string" && p.startsWith("/api/"), `Invalid strict API path entry: ${String(p)}`);
  }
  return parsed;
}

export const ENDPOINT_ASSERTIONS = {
  "/api/stablecoins": (result) => {
    assert(result.status === 200, `/api/stablecoins returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.peggedAssets), "/api/stablecoins missing peggedAssets[]");
    assert(body.peggedAssets.length > 0, "/api/stablecoins returned empty peggedAssets[]");
    return `${body.peggedAssets.length} assets`;
  },
  "/api/peg-summary": (result) => {
    assert(result.status === 200, `/api/peg-summary returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.coins), "/api/peg-summary missing coins[]");
    assert(body.coins.length > 0, "/api/peg-summary returned empty coins[]");
    return `${body.coins.length} coins`;
  },
  "/api/report-cards": (result) => {
    assert(result.status === 200, `/api/report-cards returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.cards), "/api/report-cards missing cards[]");
    assert(body.cards.length > 0, "/api/report-cards returned empty cards[]");
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/report-cards missing methodology.version",
    );
    return `${body.cards.length} cards`;
  },
  "/api/stability-index": (result) => {
    assert(result.status === 200, `/api/stability-index returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.history), "/api/stability-index missing history[]");
    assert(body.history.length > 0, "/api/stability-index returned empty history[]");
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/stability-index missing methodology.version",
    );
    if (body.current) {
      assert(isFiniteNumber(body.current.score), "/api/stability-index current.score is not finite");
      assert(body.current.score >= 0 && body.current.score <= 100, "/api/stability-index current.score out of range");
      assert(typeof body.current.band === "string" && body.current.band.length > 0, "/api/stability-index missing current.band");
    }
    return body.current
      ? `score ${body.current.score.toFixed(1)} (${body.current.band})`
      : `${body.history.length} historical points`;
  },
  "/api/dex-liquidity": (result) => {
    assert(result.status === 200, `/api/dex-liquidity returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && typeof body === "object" && !Array.isArray(body), "/api/dex-liquidity body is not an object");
    const entries = Object.entries(body).filter(([key]) => key !== "_meta");
    assert(entries.length > 0, "/api/dex-liquidity returned empty map");
    const [, sample] = entries[0];
    assert(sample && typeof sample === "object", "/api/dex-liquidity sample item is invalid");
    assert(isFiniteNumber(sample.totalTvlUsd), "/api/dex-liquidity sample missing finite totalTvlUsd");
    assert(sample.totalTvlUsd >= 0, "/api/dex-liquidity sample totalTvlUsd is negative");
    return `${entries.length} coins with liquidity`;
  },
  "/api/stress-signals": (result) => {
    assert(result.status === 200, `/api/stress-signals returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && body.signals && typeof body.signals === "object", "/api/stress-signals missing signals map");
    const entries = Object.entries(body.signals);
    assert(entries.length > 0, "/api/stress-signals returned empty signals map");
    const [, sample] = entries[0];
    assert(isFiniteNumber(sample.score), "/api/stress-signals sample score is not finite");
    assert(sample.score >= 0 && sample.score <= 100, "/api/stress-signals sample score out of range");
    assert(typeof sample.band === "string" && sample.band.length > 0, "/api/stress-signals sample missing band");
    return `${entries.length} stress signals`;
  },
  "/api/mint-burn-flows": (result) => {
    assert(result.status === 200, `/api/mint-burn-flows returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && body.gauge && typeof body.gauge === "object", "/api/mint-burn-flows missing gauge");
    assert(Array.isArray(body.coins), "/api/mint-burn-flows missing coins[]");
    assert(body.coins.length > 0, "/api/mint-burn-flows returned empty coins[]");
    if (body.gauge.score !== null) {
      assert(isFiniteNumber(body.gauge.score), "/api/mint-burn-flows gauge.score is not finite");
      assert(body.gauge.score >= -100 && body.gauge.score <= 100, "/api/mint-burn-flows gauge.score out of range");
    }
    for (const coin of body.coins) {
      if (coin.flowIntensity === null) continue;
      assert(isFiniteNumber(coin.flowIntensity), "/api/mint-burn-flows coin.flowIntensity is not finite");
      assert(
        coin.flowIntensity >= -100 && coin.flowIntensity <= 100,
        "/api/mint-burn-flows coin.flowIntensity out of range",
      );
    }
    return `${body.coins.length} tracked flow coins`;
  },
};

export function assertPathCoverage(strictPaths, endpointAssertions) {
  const strict = new Set(strictPaths);
  const defined = new Set(Object.keys(endpointAssertions));
  const missing = [...strict].filter((p) => !defined.has(p));
  const extra = [...defined].filter((p) => !strict.has(p));

  assert(
    missing.length === 0 && extra.length === 0,
    `Smoke assertion drift detected (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
}

async function run() {
  const { baseUrl: rawBaseUrl } = parseArgs(process.argv.slice(2));
  const baseUrl = ensureBaseUrl(rawBaseUrl);
  const strictPaths = loadStrictContractPaths();
  assertPathCoverage(strictPaths, ENDPOINT_ASSERTIONS);
  console.log(`[smoke-api] Running checks against ${baseUrl}`);

  const health = await fetchJson(baseUrl, "/api/health");
  assert(health.status === 200, `/api/health returned ${health.status}`);
  assert(
    health.body && ["healthy", "degraded", "stale"].includes(health.body.status),
    "/api/health missing valid status"
  );
  console.log(`[smoke-api] OK /api/health (${health.body.status})`);

  const strictResults = await Promise.all(
    strictPaths.map(async (endpointPath) => ({ path: endpointPath, result: await fetchJson(baseUrl, endpointPath) })),
  );
  for (const { path: endpointPath, result } of strictResults) {
    const details = ENDPOINT_ASSERTIONS[endpointPath](result);
    console.log(`[smoke-api] OK ${endpointPath} (${details})`);
  }

  console.log("[smoke-api] All checks passed.");
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  run().catch((error) => {
    console.error(`[smoke-api] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
