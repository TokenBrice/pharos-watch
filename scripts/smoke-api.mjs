#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";
import {
  assert,
  formatError,
  parseCliOptions,
  parseNonNegativeInt,
  parsePositiveInt,
  readBooleanEnv,
  readEnvFirst,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
  sleep,
} from "./lib/smoke-runtime.mjs";

export const STRICT_CONTRACT_SMOKE_PATHS = [
  "/api/stablecoins",
  "/api/peg-summary",
  "/api/dex-liquidity",
  "/api/stability-index",
  "/api/report-cards",
  "/api/redemption-backstops",
  "/api/blacklist",
  "/api/blacklist-summary",
  "/api/depeg-events",
  "/api/recent-events",
  "/api/mint-burn-flows",
  "/api/stress-signals",
];

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

function assertHttpUrl(value, pathPrefix) {
  const parsed = new URL(value);
  assert(parsed.protocol === "http:" || parsed.protocol === "https:", `${pathPrefix} is not an http(s) URL`);
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

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  );
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function assertKnownEnum(value, allowed, message) {
  assert(typeof value === "string" && allowed.has(value), message);
}

function assertOptionalScore(value, message) {
  if (value == null) return;
  assert(isFiniteNumber(value), `${message} is not finite`);
  assert(value >= 0 && value <= 100, `${message} out of range`);
}

function assertOptionalNonNegativeNumber(value, message) {
  if (value == null) return;
  assert(isFiniteNumber(value), `${message} is not finite`);
  assert(value >= 0, `${message} is negative`);
}

function assertOptionalRatio(value, message) {
  if (value == null) return;
  assert(isFiniteNumber(value), `${message} is not finite`);
  assert(value >= 0 && value <= 1, `${message} out of range`);
}

function stripMeta(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("_meta" in body)) {
    return body;
  }
  const { _meta: _ignoredMeta, ...rest } = body;
  return rest;
}

function loadStrictContractPaths() {
  const parsed = [...STRICT_CONTRACT_SMOKE_PATHS];
  for (const p of parsed) {
    assert(typeof p === "string" && p.startsWith("/api/"), `Invalid strict API path entry: ${String(p)}`);
  }
  return parsed;
}

const REDEMPTION_ENUMS = {
  routeFamily: new Set([
    "stablecoin-redeem",
    "basket-redeem",
    "collateral-redeem",
    "psm-swap",
    "queue-redeem",
    "offchain-issuer",
  ]),
  accessModel: new Set(["permissionless-onchain", "whitelisted-onchain", "issuer-api", "manual"]),
  settlementModel: new Set(["atomic", "immediate", "same-day", "days", "queued"]),
  executionModel: new Set(["deterministic-onchain", "deterministic-basket", "rules-based-nav", "opaque"]),
  outputAssetType: new Set(["stable-single", "stable-basket", "bluechip-collateral", "mixed-collateral", "nav"]),
  sourceMode: new Set(["dynamic", "estimated", "static"]),
  resolutionState: new Set(["resolved", "missing-cache", "missing-capacity", "failed", "impaired"]),
  routeStatus: new Set(["open", "degraded", "paused", "cohort-limited", "unknown"]),
  routeStatusSource: new Set(["static-config", "market-implied", "operator-notice", "protocol-api", "onchain"]),
  holderEligibility: new Set([
    "any-holder",
    "verified-customer",
    "whitelisted-primary",
    "pre-incident-holder",
    "issuer-discretionary",
    "unknown",
  ]),
  capacityConfidence: new Set(["live-direct", "live-proxy", "dynamic", "documented-bound", "heuristic"]),
  capacityKind: new Set([
    "live-direct",
    "live-direct-bounded",
    "live-queue",
    "live-proxy-validated",
    "documented-bound",
    "documented-eventual",
    "heuristic",
  ]),
  freshnessKind: new Set([
    "verified-source-timestamp",
    "same-run-onchain",
    "same-run-api",
    "reviewed-static",
    "unverified",
  ]),
  capacityBasis: new Set([
    "issuer-term-redemption",
    "full-system-eventual",
    "daily-limit",
    "hot-buffer",
    "psm-balance-share",
    "strategy-buffer",
    "live-direct-telemetry",
    "live-proxy-buffer",
  ]),
  capacitySemantics: new Set(["immediate-bounded", "eventual-only"]),
  capacityScoringHorizon: new Set(["immediate", "daily", "queued", "eventual", "unknown"]),
  feeConfidence: new Set(["fixed", "formula", "undisclosed-reviewed"]),
  feeModelKind: new Set(["fixed-bps", "formula", "documented-variable", "undisclosed-reviewed"]),
  modelConfidence: new Set(["high", "medium", "low"]),
  routeExitCorrelation: new Set([
    "independent-issuer-rail",
    "same-stablecoin-pool-backing",
    "same-protocol-liquidity",
    "wrapper-to-parent-dependency",
    "unknown",
  ]),
  docSupport: new Set(["route", "capacity", "fees", "access", "settlement"]),
};

function assertRedemptionDocs(docs, pathPrefix) {
  if (docs == null) return;
  assert(typeof docs === "object" && !Array.isArray(docs), `${pathPrefix}.docs is invalid`);
  if (docs.url != null) {
    assert(typeof docs.url === "string", `${pathPrefix}.docs.url is not a string`);
    assertHttpUrl(docs.url, `${pathPrefix}.docs.url`);
  }
  if (docs.sources != null) {
    assert(Array.isArray(docs.sources), `${pathPrefix}.docs.sources is not an array`);
    for (const [index, source] of docs.sources.entries()) {
      assert(source && typeof source === "object", `${pathPrefix}.docs.sources[${index}] is invalid`);
      assert(
        typeof source.label === "string" && source.label.length > 0,
        `${pathPrefix}.docs.sources[${index}].label is invalid`,
      );
      assert(typeof source.url === "string", `${pathPrefix}.docs.sources[${index}].url is not a string`);
      assertHttpUrl(source.url, `${pathPrefix}.docs.sources[${index}].url`);
      if (source.supports != null) {
        assert(Array.isArray(source.supports), `${pathPrefix}.docs.sources[${index}].supports is not an array`);
        for (const support of source.supports) {
          assertKnownEnum(
            support,
            REDEMPTION_ENUMS.docSupport,
            `${pathPrefix}.docs.sources[${index}].supports has unknown value`,
          );
        }
      }
    }
  }
}

function assertRedemptionEntry(key, entry) {
  const pathPrefix = `/api/redemption-backstops coins.${key}`;
  assert(entry && typeof entry === "object" && !Array.isArray(entry), `${pathPrefix} is invalid`);
  assert(entry.stablecoinId === key, `${pathPrefix}.stablecoinId does not match map key`);
  assertOptionalScore(entry.score, `${pathPrefix}.score`);
  assertOptionalScore(entry.effectiveExitScore, `${pathPrefix}.effectiveExitScore`);
  assertOptionalScore(entry.dexLiquidityScore, `${pathPrefix}.dexLiquidityScore`);
  assertOptionalScore(entry.accessScore, `${pathPrefix}.accessScore`);
  assertOptionalScore(entry.settlementScore, `${pathPrefix}.settlementScore`);
  assertOptionalScore(entry.executionCertaintyScore, `${pathPrefix}.executionCertaintyScore`);
  assertOptionalScore(entry.capacityScore, `${pathPrefix}.capacityScore`);
  assertOptionalScore(entry.outputAssetQualityScore, `${pathPrefix}.outputAssetQualityScore`);
  assertOptionalScore(entry.costScore, `${pathPrefix}.costScore`);
  assertKnownEnum(entry.routeFamily, REDEMPTION_ENUMS.routeFamily, `${pathPrefix}.routeFamily is invalid`);
  assertKnownEnum(entry.accessModel, REDEMPTION_ENUMS.accessModel, `${pathPrefix}.accessModel is invalid`);
  assertKnownEnum(entry.settlementModel, REDEMPTION_ENUMS.settlementModel, `${pathPrefix}.settlementModel is invalid`);
  assertKnownEnum(entry.executionModel, REDEMPTION_ENUMS.executionModel, `${pathPrefix}.executionModel is invalid`);
  assertKnownEnum(entry.outputAssetType, REDEMPTION_ENUMS.outputAssetType, `${pathPrefix}.outputAssetType is invalid`);
  assert(typeof entry.provider === "string" && entry.provider.length > 0, `${pathPrefix}.provider is invalid`);
  assertKnownEnum(entry.sourceMode, REDEMPTION_ENUMS.sourceMode, `${pathPrefix}.sourceMode is invalid`);
  assertKnownEnum(entry.resolutionState, REDEMPTION_ENUMS.resolutionState, `${pathPrefix}.resolutionState is invalid`);
  assertKnownEnum(entry.routeStatus, REDEMPTION_ENUMS.routeStatus, `${pathPrefix}.routeStatus is invalid`);
  assertKnownEnum(
    entry.routeStatusSource,
    REDEMPTION_ENUMS.routeStatusSource,
    `${pathPrefix}.routeStatusSource is invalid`,
  );
  assertKnownEnum(
    entry.holderEligibility,
    REDEMPTION_ENUMS.holderEligibility,
    `${pathPrefix}.holderEligibility is invalid`,
  );
  assertKnownEnum(
    entry.capacityConfidence,
    REDEMPTION_ENUMS.capacityConfidence,
    `${pathPrefix}.capacityConfidence is invalid`,
  );
  if (entry.capacityKind != null) {
    assertKnownEnum(entry.capacityKind, REDEMPTION_ENUMS.capacityKind, `${pathPrefix}.capacityKind is invalid`);
  }
  if (entry.freshnessKind != null) {
    assertKnownEnum(entry.freshnessKind, REDEMPTION_ENUMS.freshnessKind, `${pathPrefix}.freshnessKind is invalid`);
  }
  if (entry.capacityBasis != null) {
    assertKnownEnum(entry.capacityBasis, REDEMPTION_ENUMS.capacityBasis, `${pathPrefix}.capacityBasis is invalid`);
  }
  assertKnownEnum(
    entry.capacitySemantics,
    REDEMPTION_ENUMS.capacitySemantics,
    `${pathPrefix}.capacitySemantics is invalid`,
  );
  if (entry.capacityProfile != null) {
    assert(
      entry.capacityProfile && typeof entry.capacityProfile === "object" && !Array.isArray(entry.capacityProfile),
      `${pathPrefix}.capacityProfile is invalid`,
    );
    assertOptionalNonNegativeNumber(entry.capacityProfile.immediateUsd, `${pathPrefix}.capacityProfile.immediateUsd`);
    assertOptionalNonNegativeNumber(entry.capacityProfile.dailyLimitUsd, `${pathPrefix}.capacityProfile.dailyLimitUsd`);
    assertOptionalNonNegativeNumber(entry.capacityProfile.queuedUsd, `${pathPrefix}.capacityProfile.queuedUsd`);
    assertOptionalNonNegativeNumber(entry.capacityProfile.eventualUsd, `${pathPrefix}.capacityProfile.eventualUsd`);
    assertOptionalNonNegativeNumber(entry.capacityProfile.scoringUsd, `${pathPrefix}.capacityProfile.scoringUsd`);
    assertKnownEnum(
      entry.capacityProfile.scoringHorizon,
      REDEMPTION_ENUMS.capacityScoringHorizon,
      `${pathPrefix}.capacityProfile.scoringHorizon is invalid`,
    );
    assertKnownEnum(
      entry.capacityProfile.capacityProfileConfidence,
      REDEMPTION_ENUMS.capacityConfidence,
      `${pathPrefix}.capacityProfile.capacityProfileConfidence is invalid`,
    );
    assertOptionalNonNegativeNumber(
      entry.capacityProfile.modeledExitSizeUsd,
      `${pathPrefix}.capacityProfile.modeledExitSizeUsd`,
    );
  }
  assertKnownEnum(entry.feeConfidence, REDEMPTION_ENUMS.feeConfidence, `${pathPrefix}.feeConfidence is invalid`);
  assertKnownEnum(entry.feeModelKind, REDEMPTION_ENUMS.feeModelKind, `${pathPrefix}.feeModelKind is invalid`);
  assertKnownEnum(entry.modelConfidence, REDEMPTION_ENUMS.modelConfidence, `${pathPrefix}.modelConfidence is invalid`);
  if (entry.confidenceDetails != null) {
    assert(
      entry.confidenceDetails && typeof entry.confidenceDetails === "object" && !Array.isArray(entry.confidenceDetails),
      `${pathPrefix}.confidenceDetails is invalid`,
    );
    for (const field of [
      "capacityEvidenceQuality",
      "feeEvidenceQuality",
      "routeStatusFreshness",
      "holderCohortBreadth",
      "sourceQuality",
    ]) {
      assertOptionalScore(entry.confidenceDetails[field], `${pathPrefix}.confidenceDetails.${field}`);
    }
    assertOptionalNonNegativeNumber(
      entry.confidenceDetails.reviewedDocAgeDays,
      `${pathPrefix}.confidenceDetails.reviewedDocAgeDays`,
    );
    if (entry.confidenceDetails.reasons != null) {
      assert(Array.isArray(entry.confidenceDetails.reasons), `${pathPrefix}.confidenceDetails.reasons is not an array`);
      assert(
        entry.confidenceDetails.reasons.every((reason) => typeof reason === "string"),
        `${pathPrefix}.confidenceDetails.reasons contains a non-string`,
      );
    }
  }
  assertOptionalNonNegativeNumber(entry.immediateCapacityUsd, `${pathPrefix}.immediateCapacityUsd`);
  assertOptionalRatio(entry.immediateCapacityRatio, `${pathPrefix}.immediateCapacityRatio`);
  assertOptionalScore(entry.eventualRedeemabilityScore, `${pathPrefix}.eventualRedeemabilityScore`);
  assertOptionalNonNegativeNumber(entry.sourceTimestamp, `${pathPrefix}.sourceTimestamp`);
  if (entry.sourceUrls != null) {
    assert(Array.isArray(entry.sourceUrls), `${pathPrefix}.sourceUrls is not an array`);
    for (const sourceUrl of entry.sourceUrls) {
      assert(typeof sourceUrl === "string", `${pathPrefix}.sourceUrls contains a non-string`);
      assertHttpUrl(sourceUrl, `${pathPrefix}.sourceUrls`);
    }
  }
  assertOptionalNonNegativeNumber(entry.settlementDelaySec, `${pathPrefix}.settlementDelaySec`);
  assertOptionalNonNegativeNumber(entry.queueDepthUsd, `${pathPrefix}.queueDepthUsd`);
  assertOptionalNonNegativeNumber(entry.dailyLimitUsd, `${pathPrefix}.dailyLimitUsd`);
  assertOptionalNonNegativeNumber(entry.minRedeemUsd, `${pathPrefix}.minRedeemUsd`);
  if (entry.liveHolderEligibility != null) {
    assertKnownEnum(
      entry.liveHolderEligibility,
      REDEMPTION_ENUMS.holderEligibility,
      `${pathPrefix}.liveHolderEligibility is invalid`,
    );
  }
  assertOptionalNonNegativeNumber(entry.feeBps, `${pathPrefix}.feeBps`);
  if (entry.costScenarioScores != null) {
    assert(
      entry.costScenarioScores &&
        typeof entry.costScenarioScores === "object" &&
        !Array.isArray(entry.costScenarioScores),
      `${pathPrefix}.costScenarioScores is invalid`,
    );
    assertOptionalScore(entry.costScenarioScores.retail, `${pathPrefix}.costScenarioScores.retail`);
    assertOptionalScore(entry.costScenarioScores.activeUser, `${pathPrefix}.costScenarioScores.activeUser`);
    assertOptionalScore(entry.costScenarioScores.institutional, `${pathPrefix}.costScenarioScores.institutional`);
  }
  if (entry.routeExitCorrelation != null) {
    assertKnownEnum(
      entry.routeExitCorrelation,
      REDEMPTION_ENUMS.routeExitCorrelation,
      `${pathPrefix}.routeExitCorrelation is invalid`,
    );
  }
  assert(typeof entry.queueEnabled === "boolean", `${pathPrefix}.queueEnabled is not boolean`);
  assert(
    typeof entry.methodologyVersion === "string" && entry.methodologyVersion.length > 0,
    `${pathPrefix}.methodologyVersion is invalid`,
  );
  assertOptionalNonNegativeNumber(entry.updatedAt, `${pathPrefix}.updatedAt`);
  assertRedemptionDocs(entry.docs, pathPrefix);
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
      body.methodology.effectiveExitModel && isFiniteNumber(body.methodology.effectiveExitModel.diversificationFactor),
      "/api/redemption-backstops missing effectiveExitModel.diversificationFactor",
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
  "/api/recent-events": (result) => {
    assert(result.status === 200, `/api/recent-events returned ${result.status}`);
    const body = stripMeta(result.body);
    assert(body && Array.isArray(body.events), "/api/recent-events missing events[]");
    for (const event of body.events) {
      assert(typeof event.id === "string" && event.id.length > 0, "/api/recent-events event.id invalid");
      assert(typeof event.type === "string" && event.type.includes("."), "/api/recent-events event.type invalid");
      assert(typeof event.severity === "string", "/api/recent-events event.severity invalid");
      assert(isFiniteNumber(event.ts) && event.ts > 0, "/api/recent-events event.ts invalid");
      assert(typeof event.title === "string" && event.title.length > 0, "/api/recent-events event.title invalid");
      assert(typeof event.href === "string" && event.href.startsWith("/"), "/api/recent-events event.href invalid");
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
  const { baseUrl: rawBaseUrl, requireApiKey, timeoutMs, retryCount, retryDelayMs } = parseArgs(process.argv.slice(2));
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
    "/api/health missing valid status",
  );
  console.log(`[smoke-api] OK /api/health (${health.body.status})`);

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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  run().catch((error) => {
    console.error(`[smoke-api] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
