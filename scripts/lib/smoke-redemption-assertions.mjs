/**
 * Runtime contract assertions for the /api/redemption-backstops smoke check.
 *
 * Extracted from scripts/maintenance/smoke-api.mjs so the redemption enum
 * catalogue and per-entry validator can grow independently of the general
 * smoke runner (fetch/retry plumbing, OG-image checks, scope logic).
 *
 * REDEMPTION_ENUMS mirrors the RedemptionRouteFamily/etc. TypeScript unions in
 * shared/types/redemption. The mirror is hand-maintained: deriving it from the
 * Zod schemas would remove the drift risk entirely and is the better fix.
 */

import { assert } from "./smoke-runtime.mjs";

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

function assertHttpUrl(value, pathPrefix) {
  const parsed = new URL(value);
  assert(parsed.protocol === "http:" || parsed.protocol === "https:", `${pathPrefix} is not an http(s) URL`);
}

export const REDEMPTION_ENUMS = {
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
    "fixed-buffer",
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

export function assertRedemptionDocs(docs, pathPrefix) {
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

export function assertRedemptionEntry(key, entry) {
  const pathPrefix = `/api/redemption-backstops coins.${key}`;
  assert(entry && typeof entry === "object" && !Array.isArray(entry), `${pathPrefix} is invalid`);
  assert(entry.stablecoinId === key, `${pathPrefix}.stablecoinId does not match map key`);
  assertOptionalScore(entry.score, `${pathPrefix}.score`);
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
