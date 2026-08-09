import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput, normalizeFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";

// Kept ahead of the newest reviewed date in the registry metadata this fixture
// reads: the usdc-circle parent's mint-authority review moved to 2026-08-08,
// which the extension's scoring-clock guard treats as a future review.
const AS_OF_SEC = Date.parse("2026-08-09T12:00:00.000Z") / 1_000;
const OBSERVED_AT_SEC = AS_OF_SEC - 100;
const ASSET_ID = "dusd-dialectic";
const PARENT_ID = "usdc-circle";
const ACTIVE_ASSET_IDS = [ASSET_ID, PARENT_ID] as const;

function requireMeta(assetId: string) {
  const meta = ACTIVE_META_BY_ID.get(assetId);
  if (!meta) throw new Error(`expected registry metadata for ${assetId}`);
  return meta;
}

function fixedInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [...ACTIVE_ASSET_IDS],
    capturedAt: "2026-08-09T12:00:00.000Z",
    sourceGeneration: "report-cards:fixture:dusd-team-answers",
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
    pegDataById: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [
        assetId,
        {
          id: assetId,
          symbol: assetId === ASSET_ID ? "DUSD" : "USDC",
          name: assetId === ASSET_ID ? "Dialectic USD" : "USDC",
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
      ]),
    ),
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [
        assetId,
        {
          liquidityScore: 12,
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
          exitRouteObservations: [],
          methodologyVersion: "dex:fixture-v1",
          updatedAt: OBSERVED_AT_SEC,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_ASSET_IDS.map((assetId) => [assetId, false])),
    liveReserveMap: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [assetId, requireMeta(assetId).reserves ?? []]),
    ),
    liveReserveProvenanceMap: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [
        assetId,
        { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
      ]),
    ),
    chainCirculatingById: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [
        assetId,
        {
          ethereum: {
            current: 10_000_000,
            circulatingPrevDay: 10_000_000,
            circulatingPrevWeek: 10_000_000,
            circulatingPrevMonth: 10_000_000,
          },
        },
      ]),
    ),
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function compileDusdTeamAnswerFixture() {
  const input = fixedInput();
  const metaById = new Map(ACTIVE_ASSET_IDS.map((assetId) => [assetId, requireMeta(assetId)] as const));
  const extension = buildSafetyScoreV9BaselineExtension(input, { metaById });
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
  const compiledAsset = compiled.assets.find((candidate) => candidate.assetId === ASSET_ID);
  if (!compiledAsset) throw new Error("expected compiled DUSD facts");
  const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
  const evaluatedAsset = evaluated.assets.find((candidate) => candidate.assetId === ASSET_ID);
  if (!evaluatedAsset) throw new Error("expected evaluated DUSD card");
  return { compiledAsset, evaluatedAsset };
}

describe("Safety Score v9 DUSD Makina team-answer evidence", () => {
  it("records the official Machine Terms custody and leverage facts in registry metadata", () => {
    const meta = requireMeta(ASSET_ID);

    expect(meta.jurisdiction).toEqual({ country: "British Virgin Islands" });
    expect(meta.links).toContainEqual({
      label: "Machine Terms",
      url: "https://makina.finance/MeccanicoToS.pdf",
    });
    expect(meta.custodyProfile).toMatchObject({
      segregation: "mixed",
      bankruptcyRemoteness: "none",
      rehypothecation: "permitted",
      reviewedAt: "2026-07-30",
      providers: [
        expect.objectContaining({
          name: "Dialectic Meccanico Ltd / Makina Machine and Caliber contracts",
          jurisdiction: "British Virgin Islands",
        }),
      ],
    });
    expect(meta.custodyProfile?.sources).toContainEqual(
      expect.objectContaining({ url: "https://makina.finance/MeccanicoToS.pdf" }),
    );
    expect(meta.custodyProfile?.uncertainty).toEqual(expect.stringContaining("ordinary contractual counterparties"));
    expect(meta.custodyProfile?.uncertainty).toEqual(expect.stringContaining("no legal, equitable, proprietary"));

    const morphoSlice = meta.reserves?.find((reserve) => reserve.name === "Morpho lending positions");
    expect(morphoSlice?.riskFactors).toContain("leverage");
    expect(meta.reserveReview?.rationale).toEqual(expect.stringContaining("no binding Machine-wide numeric leverage ceiling"));
    expect(meta.reserveReview?.rationale).toEqual(expect.stringContaining("Rootfile feeds are not used"));
  });

  it("compiles DUSD wrapper facts from reviewed local custody, leverage, and control evidence", () => {
    const { compiledAsset } = compileDusdTeamAnswerFixture();
    const wrapper = compiledAsset.wrapperLocalFacts;
    if (wrapper?.applicability !== "wrapper") throw new Error("expected DUSD wrapper-local facts");

    expect(wrapper.facts.custodyEscrow).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: expect.arrayContaining([
        "wrapper-custody-segregation:mixed",
        "wrapper-custody-bankruptcy-remoteness:none",
      ]),
    });
    expect(wrapper.facts.leverage).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: expect.arrayContaining(["wrapper-leverage-factor:leverage"]),
    });
    // The 2026-08-08 control review resolved DUSD's two open mint-authority
    // questions, so the compiled control status is `known` and the loss-control
    // fact no longer carries `wrapper-local-controls-partial-review`. What it
    // carries instead is one risk signal per curated control — the five
    // `mint-meta:dusd-dialectic:<index>:<digest>` keys, whose controls array is
    // unchanged by that review — so the fact is now an exhaustive read of the
    // control set rather than a partial one.
    expect(wrapper.facts.lossAbsorptionEmergencyControls).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: expect.arrayContaining([
        "non-claim-control:mint-meta:dusd-dialectic:0:0753a29722c02f5eb3f2",
        "unbounded-claim-control:mint-meta:dusd-dialectic:1:53c5cf56b4e8d9e0facf",
        "unbounded-claim-control:mint-meta:dusd-dialectic:2:8a504a683206276bfc65",
        "unbounded-claim-control:mint-meta:dusd-dialectic:3:1e5d1009d534d5ffa1b9",
        "unbounded-claim-control:mint-meta:dusd-dialectic:4:307f52514a8019019079",
        "strategy-vault-holder-loss-controls-reviewed",
      ]),
    });
    expect(wrapper.facts.lossAbsorptionEmergencyControls.signals).toHaveLength(6);
    expect(wrapper.facts.lossAbsorptionEmergencyControls.signals).not.toContain(
      "wrapper-local-controls-partial-review",
    );
    expect(wrapper.facts.lossAbsorptionEmergencyControls.evidenceRefIds.length).toBeGreaterThan(0);
    expect(wrapper.riskTransfer).toMatchObject({
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-documented-parent-loss-absorption-credit"],
    });
  });

  it("applies the adverse legal terms to mechanism claim quality without upgrading custody or assurance", () => {
    const { compiledAsset } = compileDusdTeamAnswerFixture();
    const review = compiledAsset.mechanismRiskReview;
    const fiatCashReview = review.review;
    if (!fiatCashReview || fiatCashReview.archetype !== "fiat-cash") {
      throw new Error("expected compiled DUSD fiat-cash mechanism review");
    }
    const overlay = mechanismReviewOverlays.overlays.find((candidate) => candidate.assetId === ASSET_ID);

    expect(review.status).toMatchObject({ observationState: "known" });
    expect(fiatCashReview).toMatchObject({
      claimAndSegregation: { quality: "weak" },
      custodyContinuity: { quality: "limited" },
      assuranceAndReconciliation: { quality: "limited" },
    });
    expect(overlay?.notes).toEqual(expect.stringContaining("affirmative legal evidence"));
    expect(overlay?.notes).toEqual(expect.stringContaining("expected publication URL pending"));
  });

  it("keeps DUSD wrapper-parent scoring on local facts with zero risk-transfer credit", () => {
    const { evaluatedAsset } = compileDusdTeamAnswerFixture();
    const wrapperParentLimit = evaluatedAsset.trace.wrapperParentLimit;

    expect(wrapperParentLimit).toMatchObject({
      treatment: "fallback-discount",
      riskTransfer: {
        disposition: "not-applicable",
        mechanism: "none",
        requestedCredit: 0,
        appliedCredit: 0,
      },
    });
    expect(wrapperParentLimit?.missingFacts.map((fact) => fact.factClass)).not.toEqual(
      expect.arrayContaining(["custodyEscrow", "leverage", "lossAbsorptionEmergencyControls"]),
    );
  });
});
