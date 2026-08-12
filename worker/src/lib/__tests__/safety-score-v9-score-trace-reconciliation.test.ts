import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9-candidate";

const CURRENT_CLOCK_SEC = 1_786_579_200;
const FAR_FUTURE_CLOCK_SEC = 2_000_000_000;

function createUsdcFixedInput(clockSec: number) {
  const observedAtSec = clockSec - 100;
  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["usdc-circle"],
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:fixture:${clockSec}`,
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:score-trace-reconciliation-fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      "usdc-circle": {
        liquidityScore: 90,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        methodologyVersion: "dex:fixture-v1",
        updatedAt: observedAtSec,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { "usdc-circle": false },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      "usdc-circle": {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
  return fixedInput;
}

function buildUsdcCandidate(clockSec: number) {
  return buildSafetyScoreV9Candidate({
    fixedInput: createUsdcFixedInput(clockSec),
    publishedAtSec: clockSec + 10,
  });
}

function expectReasonAttributionReconciliation(
  card: ReturnType<typeof buildUsdcCandidate>["candidate"]["cards"][number],
): void {
  for (const item of card.scoreTrace.boundedUncertaintyAttribution.items) {
    if (item.source !== "reason") continue;
    const summary = card.scoreTrace.evidenceResponsibility.summaries.find(
      (candidate) => candidate.responsibility === item.responsibility,
    );
    expect(summary, `${item.code}:${item.responsibility}`).toMatchObject({
      responsibility: item.responsibility,
    });
    expect(summary!.factCount, `${item.code}:${item.responsibility}`).toBeGreaterThan(0);
    expect(summary!.reasonCodes, `${item.code}:${item.responsibility}`).toContain(item.code);
  }
}

describe("Safety Score V9 score-trace reconciliation", { timeout: 30_000 }, () => {
  it("reconciles aged bounded mechanism attribution to an owned unresolved fact", () => {
    const pipeline = buildUsdcCandidate(FAR_FUTURE_CLOCK_SEC);
    const card = pipeline.candidate.cards[0]!;

    expect(card.scoreTrace.boundedUncertaintyAttribution.items).toContainEqual(
      expect.objectContaining({
        source: "reason",
        code: "bounded-mechanism-review",
        responsibility: "issuer-undisclosed",
      }),
    );
    expect(card.scoreTrace.evidenceResponsibility.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "missing-bridge-routes",
          sourceGapId: "usdc-circle:gap:economic-control:bridge",
          responsibility: "producer-failed",
        }),
        expect.objectContaining({
          reasonCode: "runtime-bridge-materiality-unavailable",
          sourceGapId: "usdc-circle:gap:economic-control:bridge",
          responsibility: "producer-failed",
        }),
      ]),
    );
    expectReasonAttributionReconciliation(card);
  });

  it("leaves the current-clock USDC trace free of aged mechanism-review gaps", () => {
    const pipeline = buildUsdcCandidate(CURRENT_CLOCK_SEC);
    const card = pipeline.candidate.cards[0]!;

    expect({
      score: card.score,
      grade: card.grade,
      totalFactCount: card.scoreTrace.evidenceResponsibility.totalFactCount,
      reasonCodes: card.reasonCodes,
    }).toEqual({
      score: null,
      grade: "NR",
      totalFactCount: 5,
      reasonCodes: [
        "insufficient-evidence",
        "missing-peg-input",
        "missing-reserve-composition",
        "missing-same-notional-route",
      ],
    });

    expect(card.scoreTrace.boundedUncertaintyAttribution.items).not.toContainEqual(
      expect.objectContaining({ code: "bounded-mechanism-review" }),
    );
    expect(card.scoreTrace.evidenceResponsibility.facts).not.toContainEqual(
      expect.objectContaining({ reasonCode: "bounded-mechanism-review" }),
    );
    const sourceGapIds = (card.scoreTrace.evidenceResponsibility.facts ?? []).flatMap((fact) =>
      fact.sourceGapId === null ? [] : [fact.sourceGapId],
    );
    expect(new Set(sourceGapIds).size).toBe(sourceGapIds.length);
    expectReasonAttributionReconciliation(card);
  });
});
