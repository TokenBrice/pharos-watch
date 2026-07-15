import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";

const AS_OF_SEC = 1_783_944_000;
const OBSERVED_AT_SEC = AS_OF_SEC - 100;
const ASSET_ID = "alpha";

function exactFixedInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [ASSET_ID],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: "report-cards:fixture:ver-011",
    dexGenerationId: `dex-liquidity-${OBSERVED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: AS_OF_SEC,
    updatedAt: AS_OF_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: OBSERVED_AT_SEC, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {
      [ASSET_ID]: {
        id: ASSET_ID,
        symbol: "ALPHA",
        name: "Alpha",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 1,
        pegScore: 99,
        priceSource: "fixture-price",
        priceObservedAt: OBSERVED_AT_SEC,
        pegPct: 99,
        severityScore: 0,
        spreadPenalty: 0,
        eventCount: 0,
        worstDeviationBps: 1,
        activeDepeg: false,
        lastEventAt: null,
        trackingSpanDays: 365,
        methodologyVersion: "peg:fixture-v1",
      },
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      [ASSET_ID]: {
        liquidityScore: 0,
        concentrationHhi: null,
        poolCount: 0,
        chainCount: 0,
        coverageClass: "unobserved",
        coverageConfidence: 0,
        liquidityEvidenceClass: "unobserved",
        hasMeasuredLiquidityEvidence: false,
        effectiveTvlUsd: 0,
        balanceMeasuredTvlUsd: 0,
        organicMeasuredTvlUsd: 0,
        exitRouteObservations: [],
        methodologyVersion: "dex:fixture-v1",
        updatedAt: OBSERVED_AT_SEC,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [ASSET_ID]: false },
    liveReserveMap: { [ASSET_ID]: [] },
    liveReserveProvenanceMap: {
      [ASSET_ID]: { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
    },
    chainCirculatingById: {
      [ASSET_ID]: {
        ethereum: {
          current: 1,
          circulatingPrevDay: 1,
          circulatingPrevWeek: 1,
          circulatingPrevMonth: 1,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

// VER-011: documented-terms freshness can change without changing candidate capability identity.
describe.skip("VERITAS finding VER-011: documented-terms freshness is capability-bound", () => {
  it("changes producer capability and candidate identities with the freshness policy", () => {
    const fixedInput = exactFixedInput();
    const beforeExtension = buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([[ASSET_ID, { id: ASSET_ID, mechanismArchetype: "fiat-cash" }]]),
    });
    const afterExtension = structuredClone(beforeExtension);
    afterExtension.routeFreshness.documentedTermsMaxAgeSec += 1;

    const before = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: beforeExtension,
      publishedAtSec: AS_OF_SEC + 1,
    });
    const after = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: afterExtension,
      publishedAtSec: AS_OF_SEC + 1,
    });

    expect(after.extension.routeFreshness.documentedTermsMaxAgeSec).toBe(
      before.extension.routeFreshness.documentedTermsMaxAgeSec + 1,
    );
    expect(after.producerCapabilityDigest).not.toBe(before.producerCapabilityDigest);
    expect(after.candidate.candidateId).not.toBe(before.candidate.candidateId);
  });
});
