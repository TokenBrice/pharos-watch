#!/usr/bin/env node

import {
  assert,
  formatError,
  isDirectRun,
  parseCliOptions,
  parseNonNegativeInt,
  parsePositiveInt,
  readBooleanEnv,
  readEnvFirst,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
  retrySmokeResult,
} from "../lib/smoke-runtime.mjs";
import { REDEMPTION_ENUMS, assertRedemptionEntry } from "../lib/smoke-redemption-assertions.mjs";

// Kept as part of this module's public surface so callers can read the enum
// catalogue the smoke assertions validate against.
export { REDEMPTION_ENUMS };

export const STRICT_CONTRACT_SMOKE_PATHS = [
  "/api/stablecoins",
  "/api/peg-summary",
  "/api/dex-liquidity",
  "/api/stability-index",
  "/api/report-cards/v9",
  "/api/depeg-resolver",
  "/api/depeg-resolver-review",
  "/api/redemption-backstops",
  "/api/blacklist",
  "/api/blacklist-summary",
  "/api/depeg-events",
  "/api/events",
  "/api/mint-burn-flows",
  "/api/stress-signals",
];

export const CANARY_CONTRACT_SMOKE_PATHS = [
  "/api/stablecoins",
  "/api/peg-summary",
  "/api/report-cards/v9",
  "/api/depeg-resolver-review",
  "/api/mint-burn-flows",
  "/api/stress-signals",
];

// OG image endpoints are public PNG routes outside the JSON contract set.
// The per-coin route once 503ed for every coin in production for weeks with
// nothing watching it (satori threw on the card template), so the smoke
// probes one coin card, one per-chain card, and one aggregate card on every run.
export const OG_SMOKE_PATHS = ["/api/og/stablecoin/usdt-tether", "/api/og/chain/ethereum", "/api/og/depeg"];

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_RETRY_DELAY_MS = 1_500;

function parseArgs(argv) {
  const args = {
    baseUrl: readEnvFirst(["SMOKE_API_BASE", "API_BASE_URL"]),
    requireApiKey: readBooleanEnv("SMOKE_API_REQUIRE_KEY", process.env.CI === "true"),
    timeoutMs: readPositiveIntEnv("SMOKE_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    retryCount: readNonNegativeIntEnv("SMOKE_API_RETRY_COUNT", DEFAULT_RETRY_COUNT),
    retryDelayMs: readPositiveIntEnv("SMOKE_API_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS),
    scope: (process.env.SMOKE_API_SCOPE ?? "full").trim().toLowerCase() || "full",
  };
  parseCliOptions(argv, {
    "--base-url": ({ readValue }) => {
      args.baseUrl = readValue();
      return "value";
    },
    "--base": ({ readValue }) => {
      args.baseUrl = readValue();
      return "value";
    },
    "--timeout-ms": ({ readValue }) => {
      args.timeoutMs = parsePositiveInt(readValue(), args.timeoutMs);
      return "value";
    },
    "--retry-count": ({ readValue }) => {
      args.retryCount = parseNonNegativeInt(readValue(), args.retryCount);
      return "value";
    },
    "--retry-delay-ms": ({ readValue }) => {
      args.retryDelayMs = parsePositiveInt(readValue(), args.retryDelayMs);
      return "value";
    },
    "--scope": ({ readValue }) => {
      args.scope = readValue().trim().toLowerCase();
      return "value";
    },
    "--canary": () => {
      args.scope = "canary";
    },
    "--full": () => {
      args.scope = "full";
    },
    "--require-api-key": () => {
      args.requireApiKey = true;
    },
    "--allow-unauthenticated": () => {
      args.requireApiKey = false;
    },
  });
  return args;
}

function ensureBaseUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing API base URL. Pass --base-url https://... or set SMOKE_API_BASE/API_BASE_URL.");
  }

  const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  new URL(normalized);
  return normalized;
}

function ensureScope(input) {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "full" || normalized === "canary") {
    return normalized;
  }
  throw new Error(`Invalid smoke scope "${input}". Use "full" or "canary".`);
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

export function isRetryableStatus(status) {
  // api.pharos.watch has a 10-second zone WAF block. Shared CI egress can
  // inherit another runner's block, so the production smoke must outwait it.
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

async function fetchWithRetry(fetcher, endpointPath, timeoutMs, retryCount, retryDelayMs) {
  const totalAttempts = retryCount + 1;
  const outcome = await retrySmokeResult(
    async () => {
      try {
        return { ok: true, result: await fetcher(timeoutMs) };
      } catch (error) { return { ok: false, error }; }
    },
    {
      retries: retryCount,
      delayMs: retryDelayMs,
      shouldRetry: (outcome) =>
        outcome.ok ? isRetryableStatus(outcome.result.status) : isRetryableError(outcome.error),
      onRetry: ({ attempt, result: outcome }) => {
        const detail = outcome.ok
          ? `returned ${outcome.result.status}`
          : `failed (${formatError(outcome.error)})`;
        console.log(
          `[smoke-api] WARN ${endpointPath} ${detail} on attempt ${attempt}/${totalAttempts}; retrying in ${retryDelayMs}ms`,
        );
      },
    },
  );
  if (!outcome.ok) throw new Error(`${endpointPath} request failed: ${formatError(outcome.error)}`);
  return outcome.result;
}

function fetchJsonWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs) {
  return fetchWithRetry(
    (timeout) => fetchJson(baseUrl, endpointPath, timeout),
    endpointPath,
    timeoutMs,
    retryCount,
    retryDelayMs,
  );
}

async function fetchPng(baseUrl, endpointPath, timeoutMs) {
  // Cache-buster query: OG responses are edge-cacheable, and a stale cached
  // PNG must not mask a render path broken by the deploy under test.
  const url = `${baseUrl}${endpointPath}?smoke=${Date.now()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const buffer = await res.arrayBuffer();
  return {
    url,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    renderErrorClass: res.headers.get("x-render-error-class"),
    bytes: buffer.byteLength,
  };
}

function fetchPngWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs) {
  return fetchWithRetry(
    (timeout) => fetchPng(baseUrl, endpointPath, timeout),
    endpointPath,
    timeoutMs,
    retryCount,
    retryDelayMs,
  );
}

export function assertOgImageResult(endpointPath, result) {
  const errorHint = result.renderErrorClass ? ` (x-render-error-class: ${result.renderErrorClass})` : "";
  assert(result.status === 200, `${endpointPath} returned ${result.status}${errorHint}`);
  assert(
    result.contentType.includes("image/png"),
    `${endpointPath} returned content-type "${result.contentType}"; expected image/png`,
  );
  assert(result.bytes > 10_000, `${endpointPath} returned a suspiciously small image (${result.bytes}b)`);
  return `${Math.round(result.bytes / 1024)}kb png`;
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

export function resolveContractSmokePaths(scope = "full") {
  const selected = scope === "canary" ? CANARY_CONTRACT_SMOKE_PATHS : STRICT_CONTRACT_SMOKE_PATHS;
  const parsed = [...selected];
  for (const p of parsed) {
    assert(typeof p === "string" && p.startsWith("/api/"), `Invalid strict API path entry: ${String(p)}`);
  }
  return parsed;
}

async function assertProtectedRoutesRejectAnonymous(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs) {
  const result = await fetchJsonWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs);
  assert(
    result.status === 401,
    `${endpointPath} returned ${result.status} without SMOKE_API_KEY; expected protected public routes to return 401`,
  );
  return result;
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
  "/api/report-cards/v9": (result) => {
    assert(result.status === 200, `/api/report-cards/v9 returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.cards), "/api/report-cards/v9 missing cards[]");
    assert(body.cards.length > 0, "/api/report-cards/v9 returned empty cards[]");
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/report-cards/v9 missing methodology.version",
    );
    return `${body.cards.length} cards`;
  },
  "/api/depeg-resolver": (result) => {
    assert(result.status === 200, `/api/depeg-resolver returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.rows), "/api/depeg-resolver missing rows[]");
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/depeg-resolver missing methodology.version",
    );
    return `${body.rows.length} active`;
  },
  "/api/depeg-resolver-review": (result) => {
    assert(result.status === 200, `/api/depeg-resolver-review returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.rows), "/api/depeg-resolver-review missing rows[]");
    assert(body.summary && typeof body.summary === "object", "/api/depeg-resolver-review missing summary");
    assert(
      body.summary.headline && typeof body.summary.headline === "object",
      "/api/depeg-resolver-review missing summary.headline",
    );
    assert(
      typeof body.summary.headline.recoveryLikelihoodScoredCount === "number",
      "/api/depeg-resolver-review missing recovery likelihood scored count",
    );
    assert(
      typeof body.summary.headline.durationScoredCount === "number",
      "/api/depeg-resolver-review missing duration scored count",
    );
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/depeg-resolver-review missing methodology.version",
    );
    return `${body.rows.length} reviewed`;
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
      assert(
        typeof body.current.band === "string" && body.current.band.length > 0,
        "/api/stability-index missing current.band",
      );
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
    assert(isFiniteNumber(body.updatedAt) && body.updatedAt >= 0, "/api/redemption-backstops updatedAt is invalid");
    const entries = Object.entries(body.coins);
    assert(entries.length > 0, "/api/redemption-backstops returned empty coins map");
    for (const [key, entry] of entries.slice(0, 10)) {
      assertRedemptionEntry(key, entry);
    }
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/redemption-backstops missing methodology.version",
    );
    assert(
      body.methodology.componentWeights && typeof body.methodology.componentWeights === "object",
      "/api/redemption-backstops missing methodology.componentWeights",
    );
    assert(
      body.methodology.routeFamilyCaps && typeof body.methodology.routeFamilyCaps === "object",
      "/api/redemption-backstops missing methodology.routeFamilyCaps",
    );
    return `${entries.length} redemption entries`;
  },
  "/api/blacklist": (result) => {
    assert(result.status === 200, `/api/blacklist returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.events), "/api/blacklist missing events[]");
    assert(isFiniteNumber(body.total) && body.total >= 0, "/api/blacklist total is invalid");
    for (const event of body.events) {
      assert(
        typeof event.stablecoin === "string" && event.stablecoin.length > 0,
        "/api/blacklist event missing stablecoin",
      );
      assert(typeof event.amountSource === "string", "/api/blacklist event missing amountSource");
      assert(typeof event.amountStatus === "string", "/api/blacklist event missing amountStatus");
      assert("contractAddress" in event, "/api/blacklist event missing contractAddress field");
      assert("configKey" in event, "/api/blacklist event missing configKey field");
      assert("eventSignature" in event, "/api/blacklist event missing eventSignature field");
    }
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/blacklist missing methodology.version",
    );
    return `${body.events.length}/${body.total} events`;
  },
  "/api/blacklist-summary": (result) => {
    assert(result.status === 200, `/api/blacklist-summary returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && body.stats && typeof body.stats === "object", "/api/blacklist-summary missing stats");
    assert(Array.isArray(body.chart), "/api/blacklist-summary missing chart[]");
    assert(Array.isArray(body.chains), "/api/blacklist-summary missing chains[]");
    assert(isFiniteNumber(body.totalEvents) && body.totalEvents >= 0, "/api/blacklist-summary totalEvents invalid");
    assert(
      isFiniteNumber(body.stats.recoverableGapCount) && body.stats.recoverableGapCount >= 0,
      "/api/blacklist-summary missing recoverableGapCount",
    );
    if (body.stats.trackedFrozenTotal != null) {
      assert(
        isFiniteNumber(body.stats.trackedFrozenTotal) && body.stats.trackedFrozenTotal >= 0,
        "/api/blacklist-summary trackedFrozenTotal invalid",
      );
    }
    return `${body.totalEvents} events, ${body.chains.length} chains`;
  },
  "/api/depeg-events": (result) => {
    assert(result.status === 200, `/api/depeg-events returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.events), "/api/depeg-events missing events[]");
    assert(isFiniteNumber(body.total) && body.total >= 0, "/api/depeg-events total is invalid");
    if ("totalExact" in body) {
      assert(typeof body.totalExact === "boolean", "/api/depeg-events totalExact is invalid");
    }
    if ("nextCursor" in body) {
      assert(
        body.nextCursor === null || typeof body.nextCursor === "string",
        "/api/depeg-events nextCursor is invalid",
      );
    }
    if (body.pending !== undefined) {
      assert(Array.isArray(body.pending), "/api/depeg-events pending is invalid");
    }
    assert(
      body.methodology && typeof body.methodology.version === "string" && body.methodology.version.length > 0,
      "/api/depeg-events missing methodology.version",
    );
    return `${body.events.length}/${body.total} events`;
  },
  "/api/events": (result) => {
    assert(result.status === 200, `/api/events returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.events), "/api/events missing events[]");
    assert(body.total === null || isFiniteNumber(body.total), "/api/events total is invalid");
    assert(typeof body.totalExact === "boolean", "/api/events totalExact is invalid");
    assert(
      body.nextCursor === null || (typeof body.nextCursor === "string" && body.nextCursor.length > 0),
      "/api/events nextCursor is invalid",
    );
    for (const event of body.events) {
      assert(typeof event.id === "string" && event.id.length > 0, "/api/events event.id invalid");
      assert(typeof event.type === "string" && event.type.includes("."), "/api/events event.type invalid");
      assert(typeof event.severity === "string", "/api/events event.severity invalid");
      assert(isFiniteNumber(event.ts) && event.ts > 0, "/api/events event.ts invalid");
      assert(typeof event.title === "string" && event.title.length > 0, "/api/events event.title invalid");
      assert(typeof event.transition === "string", "/api/events event.transition invalid");
    }
    return `${body.events.length} events`;
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

export function assertPathCoverage(strictPaths, endpointAssertions, { allowExtraAssertions = false } = {}) {
  const strict = new Set(strictPaths);
  const defined = new Set(Object.keys(endpointAssertions));
  const missing = [...strict].filter((p) => !defined.has(p));
  const extra = [...defined].filter((p) => !strict.has(p));

  assert(
    missing.length === 0 && (allowExtraAssertions || extra.length === 0),
    `Smoke assertion drift detected (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
}

async function run() {
  const {
    baseUrl: rawBaseUrl,
    requireApiKey,
    timeoutMs,
    retryCount,
    retryDelayMs,
    scope: rawScope,
  } = parseArgs(process.argv.slice(2));
  const baseUrl = ensureBaseUrl(rawBaseUrl);
  const scope = ensureScope(rawScope);
  const strictPaths = resolveContractSmokePaths(scope);
  if (scope === "full") {
    assertPathCoverage(resolveContractSmokePaths("full"), ENDPOINT_ASSERTIONS);
  } else {
    assertPathCoverage(strictPaths, ENDPOINT_ASSERTIONS, { allowExtraAssertions: true });
  }
  console.log(
    `[smoke-api] Running ${scope} checks against ${baseUrl} (timeout=${timeoutMs}ms, retries=${retryCount}, retryDelay=${retryDelayMs}ms)`,
  );

  const health = await fetchJsonWithRetry(baseUrl, "/api/health", timeoutMs, retryCount, retryDelayMs);
  assert(health.status === 200, `/api/health returned ${health.status}`);
  assert(
    health.body && ["healthy", "degraded", "stale"].includes(health.body.status),
    "/api/health missing valid status",
  );
  console.log(`[smoke-api] OK /api/health (${health.body.status})`);

  // OG probes run before the API-key gate: the routes are public, so both
  // authenticated and unauthenticated smoke runs cover them.
  for (const ogPath of OG_SMOKE_PATHS) {
    const ogResult = await fetchPngWithRetry(baseUrl, ogPath, timeoutMs, retryCount, retryDelayMs);
    const ogDetails = assertOgImageResult(ogPath, ogResult);
    console.log(`[smoke-api] OK ${ogPath} (${ogDetails})`);
  }

  const smokeApiKey = (process.env.SMOKE_API_KEY ?? "").trim();
  if (!smokeApiKey) {
    if (requireApiKey) {
      throw new Error(
        "Missing SMOKE_API_KEY. Strict API smoke checks require X-API-Key; set SMOKE_API_KEY or pass --allow-unauthenticated for health/auth-gate checks only.",
      );
    }
    const protectedPath = strictPaths[0];
    await assertProtectedRoutesRejectAnonymous(baseUrl, protectedPath, timeoutMs, retryCount, retryDelayMs);
    console.log(`[smoke-api] OK ${protectedPath} rejected anonymous request with 401`);
    console.log("[smoke-api] SKIP strict contract paths because SMOKE_API_KEY is unset.");
    console.log("[smoke-api] Unauthenticated health/auth-gate checks passed.");
    return;
  }

  for (const endpointPath of strictPaths) {
    const result = await fetchJsonWithRetry(baseUrl, endpointPath, timeoutMs, retryCount, retryDelayMs);
    const details = ENDPOINT_ASSERTIONS[endpointPath](result);
    console.log(`[smoke-api] OK ${endpointPath} (${details})`);
  }

  console.log("[smoke-api] All checks passed.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[smoke-api] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
