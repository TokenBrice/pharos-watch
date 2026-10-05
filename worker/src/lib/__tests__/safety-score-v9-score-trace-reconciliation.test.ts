import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { describe, expect, it } from "vitest";
import { iterateEvidenceResponsibilityFacts } from "@shared/types/safety-score-v9-public-evidence-facts";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { v9TestClockSec } from "../../test-helpers/v9-fixed-input";

const CURRENT_CLOCK_SEC = v9TestClockSec();
const FAR_FUTURE_CLOCK_SEC = 2_000_000_000;

function createUsdcFixedInput(clockSec: number, activeAssetIds = ["usdc-circle"]) {
  const observedAtSec = clockSec - 100;
  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds,
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
    dexLiqMap: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, {
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
    }])),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
    }])),
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
      }),
    );
    const facts = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)]
      .map(([reasonCode, , sourceGapRef, responsibility, , cause]) => ({
        reasonCode, responsibility, cause,
        sourceGapId: sourceGapRef === null ? null : resolveCauseGapId(pipeline.candidate, card, sourceGapRef),
      }));
    for (const item of card.scoreTrace.boundedUncertaintyAttribution.items) {
      if (item.source !== "reason") continue;
      for (const ref of item.causeGapRefs) {
        expect(facts).toContainEqual({
          reasonCode: item.code, responsibility: item.responsibility, cause: item.cause,
          sourceGapId: resolveCauseGapId(pipeline.candidate, card, ref),
        });
      }
    }
    expectReasonAttributionReconciliation(card);
  });

  it("leaves the current-clock USDC trace free of aged mechanism-review gaps", () => {
    const pipeline = buildUsdcCandidate(CURRENT_CLOCK_SEC);
    const card = pipeline.candidate.cards[0]!;

    // The complete August 31 examination restores a period-matched fallback
    // with one conservative aggregate bank exposure, so no live producer is
    // needed to admit the reviewed composition.
    expect(card.ratingStatus).toBe("rated");
    expect(card.nrReasons).toEqual([]);

    expect(card.scoreTrace.boundedUncertaintyAttribution.items).not.toContainEqual(
      expect.objectContaining({ code: "bounded-mechanism-review" }),
    );
    expect([...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)]
      .some(([code]) => code === "bounded-mechanism-review")).toBe(false);
    expectReasonAttributionReconciliation(card);
  });

  it("binds oracle applicability aliases to existing scoped witnesses without a new gap", () => {
    const assetIds = ["earnusd-lido", "fiusd-sygnum", "umint-ubs", "xgld-unitas"];
    const pipeline = buildSafetyScoreV9Candidate({
      fixedInput: createUsdcFixedInput(CURRENT_CLOCK_SEC, assetIds),
      publishedAtSec: CURRENT_CLOCK_SEC + 10,
    });
    for (const assetId of assetIds) {
      const asset = pipeline.compiledFacts.assets.find((entry) => entry.assetId === assetId)!;
      const evaluated = pipeline.evaluatedSet.assets.find((entry) => entry.assetId === assetId)!;
      const gapId = asset.economicControlReview.oracle.status.applicability.gapId!;
      expect(gapId).toBe(`${assetId}:gap:economic-control:oracle`);
      const reason = evaluated.scoreInput.pillars.control.reasons.find(
        (entry) => entry.code === "unresolved-oracle-branch-applicability",
      )!;
      expect(reason.sourceGapId).toBe(gapId);
      expect(reason.causeGapIds).toEqual([gapId]);
      expect(reason.cause).toBe(asset.gaps.find((gap) => gap.gapId === gapId)!.causeProof.cause);
      const card = pipeline.candidate.cards.find((entry) => entry.id === assetId)!;
      const facts = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)];
      expect(facts.some(([, , ref, , , , refs]) =>
        (ref === null ? refs : [ref]).some((source) =>
          resolveCauseGapId(pipeline.candidate, card, source) === gapId))).toBe(true);
      expectReasonAttributionReconciliation(card);
    }
  });

  it("attributes deployment bridge materiality to factor gaps before aggregate review gaps", () => {
    const assetId = "acred-apollo-securitize";
    const pipeline = buildSafetyScoreV9Candidate({
      fixedInput: createUsdcFixedInput(CURRENT_CLOCK_SEC, [assetId]),
      publishedAtSec: CURRENT_CLOCK_SEC + 10,
    });
    const compiled = structuredClone(pipeline.compiledFacts);
    const asset = compiled.assets[0]!;
    asset.economicControlReview.bridge.status.observationState = "bounded-unknown";
    asset.economicControlReview.bridge.status.applicability.state = "unresolved";
    const broadGap = createV9FactGapV3({
      gapId: `${assetId}:gap:projection-fixture-bridge-review`,
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "control", policyRuleId: "v9.control.bridge-review",
      observationState: "bounded-unknown", responsibility: "unresearched",
      path: { kind: "local-component", componentKey: "economic-control:bridge" },
      message: "Aggregate bridge materiality remains unresolved.",
    });
    asset.gaps.push(broadGap);
    asset.gaps.sort((left, right) => left.gapId < right.gapId ? -1 : left.gapId > right.gapId ? 1 : 0);
    asset.economicControlReview.bridge.status.gapIds = [broadGap.gapId];
    asset.economicControlReview.bridge.status.applicability.gapId = broadGap.gapId;
    asset.economicControlReview.bridge.status.applicability.rationale = "The deployment supply share is unresolved.";
    const digested = { ...compiled, v9FactSetDigest: computeV9FactSetDigest(compiled) };
    const materialityGapIds = asset.controls
      .filter((control) => control.controlKind === "bridge" && control.scope === "deployment")
      .flatMap((control) => control.factorStatuses?.materialSupplyShare?.gapIds ?? []);
    expect(materialityGapIds.length).toBeGreaterThan(0);
    const reasons = evaluateV9FactSet(digested, V9_CANDIDATE_POLICY_V1).assets[0]!.scoreInput.pillars.control.reasons
      .filter((reason) => reason.code === "runtime-bridge-materiality-unavailable");
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(materialityGapIds).toContain(reason.sourceGapId);
      expect(reason.causeGapIds).toEqual([reason.sourceGapId]);
      expect(reason.cause).toBe("U");
    }
    expectReasonAttributionReconciliation(pipeline.candidate.cards[0]!);
  });
});
