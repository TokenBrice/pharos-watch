import { evaluateV9FactSet, type V9EvaluatedAsset } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { v9TestClockSec } from "../../test-helpers/v9-fixed-input";
import { makePublicationDexRow, makePublicationPegRow } from "./safety-score-v9-publication-input.test-support";

// Evaluate after the newest registry review so the D14 control refresh is
// admitted alongside the reviewed custody/mechanism evidence.
const AS_OF_SEC = v9TestClockSec();
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
    capturedAt: new Date(AS_OF_SEC * 1_000).toISOString(),
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
        makePublicationPegRow({
          id: assetId,
          symbol: assetId === ASSET_ID ? "DUSD" : "USDC",
          name: assetId === ASSET_ID ? "Dialectic USD" : "USDC",
        }, OBSERVED_AT_SEC),
      ]),
    ),
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_ASSET_IDS.map((assetId) => [
        assetId,
        makePublicationDexRow(OBSERVED_AT_SEC),
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
  let scenario: { compiledAsset: V9AssetFactsV3; evaluatedAsset: V9EvaluatedAsset };
  beforeAll(() => {
    scenario = compileDusdTeamAnswerFixture();
  });

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
      reviewedAt: "2026-09-03",
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
    const morphoSlice = meta.reserves?.find((reserve) => reserve.name === "Morpho lending positions");
    expect(morphoSlice?.riskFactors).toContain("leverage");
  });

  it("compiles DUSD wrapper facts from reviewed local custody, leverage, and control evidence", () => {
    const { compiledAsset } = scenario;
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
    // D14 adds the fee-accrual timelock and recognizes the DAO's fee-manager
    // authorization power. Both are local claim-loss controls, while the
    // deposit-only Machine remains a non-claim control.
    const controlByAuthority = new Map(compiledAsset.controls.map((control) =>
      [control.authority?.authorityKey, control] as const,
    ));
    const machine = controlByAuthority.get("ethereum:0x6b006870c83b1cd49e766ac9209f8d68763df721")!;
    const feeManager = controlByAuthority.get("ethereum:0xa7f0121375dc52028e333f02715183a1d1a690a7")!;
    const feeTimelock = controlByAuthority.get("ethereum:0x38542447c49d24e617fc06113295d7aaa3bec4b6")!;
    const dao = controlByAuthority.get("ethereum:0x62244c74e1d09b3d86ef7342d354b5d7770bde10")!;
    const riskManager = controlByAuthority.get("ethereum:0x36ba7c92cd68051fb304bd4580c4a51c1d376532")!;
    const council = controlByAuthority.get("ethereum:0x89faa3b02ef5ab185b8ace489af62748acb50afc")!;
    expect(wrapper.facts.lossAbsorptionEmergencyControls).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: expect.arrayContaining([
        `non-claim-control:${machine.controlKey}`,
        `unbounded-claim-control:${feeManager.controlKey}`,
        `unbounded-claim-control:${feeTimelock.controlKey}`,
        `unbounded-claim-control:${dao.controlKey}`,
        `unbounded-claim-control:${riskManager.controlKey}`,
        `unbounded-claim-control:${council.controlKey}`,
        "strategy-vault-holder-loss-controls-reviewed",
      ]),
    });
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
    const { compiledAsset } = scenario;
    const review = compiledAsset.mechanismRiskReview;
    const fiatCashReview = review.review;
    if (!fiatCashReview || fiatCashReview.archetype !== "fiat-cash") {
      throw new Error("expected compiled DUSD fiat-cash mechanism review");
    }

    expect(review.status).toMatchObject({ observationState: "known" });
    expect(fiatCashReview).toMatchObject({
      claimAndSegregation: { quality: "weak" },
      custodyContinuity: { quality: "limited" },
      assuranceAndReconciliation: { quality: "limited" },
    });
  });

  it("retains DUSD's authored serial parent independently of unmapped strategy positions", () => {
    const { compiledAsset, evaluatedAsset } = scenario;
    expect(compiledAsset.dependencies).toMatchObject({
      source: "variant",
      baseSource: "live-unmapped",
      dependencyFromLive: true,
      mappedLiveReserveWeight: 0,
      fallbackReason: null,
      edges: [{ upstreamAssetId: PARENT_ID, dependencyType: "wrapper", economicRole: "serial-claim", weight: 1 }],
      rejectionReasons: Array.from({ length: 5 }, (_, sliceIndex) => ({ sliceIndex, reason: "no-match" })),
    });
    expect(evaluatedAsset.dependencyInputs.serial).toMatchObject([{ upstreamAssetId: PARENT_ID }]);
    const wrapperFacts = compiledAsset.wrapperLocalFacts;
    if (wrapperFacts?.applicability !== "wrapper") throw new Error("expected DUSD wrapper local facts");
    expect(wrapperFacts.riskTransfer).toMatchObject({
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
    });
  });
});
