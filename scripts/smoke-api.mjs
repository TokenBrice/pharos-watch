#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";

const strictContractModule = await import("../shared/lib/api-endpoints/index.ts");
const STRICT_CONTRACT_PATHS_LIST =
  strictContractModule.STRICT_CONTRACT_PATHS_LIST
  ?? strictContractModule.default?.STRICT_CONTRACT_PATHS_LIST
  ?? strictContractModule["module.exports"]?.STRICT_CONTRACT_PATHS_LIST
  ?? [];

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_RETRY_DELAY_MS = 1_500;

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.SMOKE_API_BASE ?? process.env.API_BASE_URL ?? "",
    timeoutMs: parsePositiveInt(process.env.SMOKE_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    retryCount: parseNonNegativeInt(process.env.SMOKE_API_RETRY_COUNT, DEFAULT_RETRY_COUNT),
    retryDelayMs: parsePositiveInt(process.env.SMOKE_API_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url" || arg === "--base") {
      args.baseUrl = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parsePositiveInt(argv[i + 1], args.timeoutMs);
      i += 1;
    } else if (arg === "--retry-count") {
      args.retryCount = parseNonNegativeInt(argv[i + 1], args.retryCount);
      i += 1;
    } else if (arg === "--retry-delay-ms") {
      args.retryDelayMs = parsePositiveInt(argv[i + 1], args.retryDelayMs);
      i += 1;
    }
  }
  return args;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

async function fetchJson(baseUrl, endpointPath, timeoutMs) {
  const url = `${baseUrl}${endpointPath}`;
  const smokeApiKey = (process.env.SMOKE_API_KEY ?? "").trim();
  const headers = new Headers();
  if (smokeApiKey) {
    headers.set("X-API-Key", smokeApiKey);
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { url, status: res.status, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJsonWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs) {
  const totalAttempts = retryCount + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const result = await fetchJson(baseUrl, endpointPath, timeoutMs);
      if (attempt < totalAttempts && isRetryableStatus(result.status)) {
        console.log(
          `[smoke-api] WARN ${endpointPath} returned ${result.status} on attempt ${attempt}/${totalAttempts}; retrying in ${retryDelayMs}ms`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < totalAttempts && isRetryableError(error)) {
        console.log(
          `[smoke-api] WARN ${endpointPath} failed on attempt ${attempt}/${totalAttempts} (${formatError(error)}); retrying in ${retryDelayMs}ms`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`${endpointPath} request failed: ${formatError(error)}`);
    }
  }

  throw new Error(`${endpointPath} request failed after ${totalAttempts} attempts: ${formatError(lastError)}`);
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
  const parsed = [...STRICT_CONTRACT_PATHS_LIST];
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
  "/api/redemption-backstops": (result) => {
    assert(result.status === 200, `/api/redemption-backstops returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && body.coins && typeof body.coins === "object", "/api/redemption-backstops missing coins map");
    const entries = Object.entries(body.coins);
    assert(entries.length > 0, "/api/redemption-backstops returned empty coins map");
    const [, sample] = entries[0];
    assert(sample && typeof sample === "object", "/api/redemption-backstops sample item is invalid");
    if (sample.score !== null) {
      assert(isFiniteNumber(sample.score), "/api/redemption-backstops sample score is not finite");
      assert(sample.score >= 0 && sample.score <= 100, "/api/redemption-backstops sample score out of range");
    }
    if (sample.effectiveExitScore !== null) {
      assert(isFiniteNumber(sample.effectiveExitScore), "/api/redemption-backstops sample effectiveExitScore is not finite");
      assert(
        sample.effectiveExitScore >= 0 && sample.effectiveExitScore <= 100,
        "/api/redemption-backstops sample effectiveExitScore out of range",
      );
    }
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/redemption-backstops missing methodology.version",
    );
    return `${entries.length} redemption entries`;
  },
  "/api/treasury-stable-exposure": (result) => {
    assert(result.status === 200, `/api/treasury-stable-exposure returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.entities), "/api/treasury-stable-exposure missing entities[]");
    assert(body.coverage && typeof body.coverage === "object", "/api/treasury-stable-exposure missing coverage");
    assert(
      Number.isInteger(body.coverage.entityCount) && body.coverage.entityCount >= 0,
      "/api/treasury-stable-exposure missing coverage.entityCount",
    );
    assert(
      Number.isInteger(body.coverage.registryCount) && body.coverage.registryCount > 0,
      "/api/treasury-stable-exposure missing coverage.registryCount",
    );
    assert(
      Number.isInteger(body.updatedAt) && body.updatedAt >= 0,
      "/api/treasury-stable-exposure missing updatedAt",
    );
    return `${body.entities.length} treasury entities`;
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
  const { baseUrl: rawBaseUrl, timeoutMs, retryCount, retryDelayMs } = parseArgs(process.argv.slice(2));
  const baseUrl = ensureBaseUrl(rawBaseUrl);
  const strictPaths = loadStrictContractPaths();
  assertPathCoverage(strictPaths, ENDPOINT_ASSERTIONS);
  console.log(
    `[smoke-api] Running checks against ${baseUrl} (timeout=${timeoutMs}ms, retries=${retryCount}, retryDelay=${retryDelayMs}ms)`,
  );

  const health = await fetchJsonWithRetry(baseUrl, "/api/health", timeoutMs, retryCount, retryDelayMs);
  assert(health.status === 200, `/api/health returned ${health.status}`);
  assert(
    health.body && ["healthy", "degraded", "stale"].includes(health.body.status),
    "/api/health missing valid status"
  );
  console.log(`[smoke-api] OK /api/health (${health.body.status})`);

  for (const endpointPath of strictPaths) {
    const result = await fetchJsonWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs);
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
