import { evaluateV9FactSet, type V9EvaluatedAsset } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { v9TestClockSec } from "../../test-helpers/v9-fixed-input";
import { makePublicationDexRow, makePublicationPegRow } from "./safety-score-v9-publication-input.test-support";

// This regression models reviewed native controls without independent bridge
// incident research; current campaign curation must not close its intended gap.
vi.mock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json", () => ({ default: { schemaVersion: 1, digest: "0".repeat(64), incidents: [], negativeReviews: [] } }));

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
  });
});
