import { describe, expect, it } from "vitest";
import type { ReserveSlice } from "@shared/types/reserves";
import {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { dependencyReserveSlices } from "../safety-score-v9/extension-reserves";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK_SEC = Date.UTC(2026, 9, 1) / 1_000;
const REVIEWED_ROWS: ReserveSlice[] = [
  {
    sourceKey: "fixture:offchain-capital", name: "Pooled credit", pct: 80, risk: "medium",
    assetClass: "private-credit", issuerOrObligor: "Reinsurer",
    riskFactors: ["credit", "liquidity"], liquidityHorizon: "over-seven-days",
  },
  {
    sourceKey: "fixture:token:beta", name: "Pooled Beta", pct: 20, risk: "low",
    assetClass: "stablecoin", issuerOrObligor: "Beta issuer", coinId: "beta", depType: "collateral",
    riskFactors: ["counterparty"], liquidityHorizon: "immediate",
  },
];
const LIVE_ROWS: ReserveSlice[] = [
  { sourceKey: "fixture:offchain-capital", name: "Current credit", pct: 35, risk: "medium" },
  { sourceKey: "fixture:token:beta", name: "Current Beta", pct: 65, risk: "low" },
];

function classificationMeta(): V9ExtensionRegistryMeta {
  return {
    id: "alpha", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01",
    reserves: structuredClone(REVIEWED_ROWS),
    reserveReview: {
      reviewedAt: "2026-09-30", reviewer: "fixture", confidence: "manual-review",
      sources: [{ label: "Pooled protocol holdings", url: "https://example.com/reserves" }],
      rationale: "Class identities are reviewed; holder-level liability attribution is unavailable.",
      compositionBasis: "Pooled holdings, not attributable tranche backing.",
      compositionAsOf: "2026-09-30", scope: "classification-only",
      knownUnknownExposure: "The whole pooled book lacks holder-level liability attribution.",
      knownUnknownExposurePct: 100,
      nonLinkDispositions: REVIEWED_ROWS.map((row, reserveIndex) => ({
        reserveIndex, reserveName: row.name, pct: row.pct,
        disposition: "insufficient-evidence",
        rationale: "Pooled quantity cannot establish a token-specific dependency weight.",
      })),
    },
  };
}

function compiledFixture(meta: V9ExtensionRegistryMeta, liveRows: ReserveSlice[]) {
  const base = makeV9TwoAssetFixedInput({ clockSec: CLOCK_SEC });
  const {
    schemaVersion: _schemaVersion, dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint, registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions, baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = base;
  const fixed = createReportCardsFixedInput({
    ...draft, liveReserveMap: { ...base.liveReserveMap, alpha: liveRows },
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([
      ["alpha", meta],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
    ]),
  });
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension)
    .assets.find((asset) => asset.assetId === "alpha")!;
}

describe("classification-qualified reserve reviews", () => {
  it("resolves keyed class facts without reviving pooled links or replacing live weights", () => {
    const meta = classificationMeta();
    const live = LIVE_ROWS.map((row) => row.sourceKey === "fixture:token:beta"
      ? { ...row, coinId: "beta", depType: "collateral" as const }
      : row);
    const asset = compiledFixture(meta, live);
    expect(asset.reserveExposures.find((row) => row.name === "Current credit")).toMatchObject({
      assetClass: "private-credit", issuerOrObligorKey: "Reinsurer", weight: 0.35,
      riskFactors: ["credit", "liquidity"], liquidityHorizon: "over-seven-days",
      status: { observationState: "known" }, trackedAssetId: null,
    });
    expect(asset.reserveExposures.find((row) => row.name === "Current Beta")).toMatchObject({
      assetClass: "stablecoin", issuerOrObligorKey: "Beta issuer", weight: 0.65,
      status: { observationState: "known" }, trackedAssetId: null,
    });
    expect(asset.dependencies).toMatchObject({
      source: "live-unmapped", mappedLiveReserveWeight: 0, edges: [],
      rejectionReasons: [{ sliceIndex: 0, reason: "non-link" }, { sliceIndex: 1, reason: "non-link" }],
    });
    expect(asset.gaps.map((gap) => gap.reasonCode)).not.toContain("material-reserve-slice-unstructured");
    expect(meta.reserveReview!.knownUnknownExposurePct).toBe(100);

    // Resolving identities cannot make the pooled reviewed percentages usable
    // as standalone composition when the live observation disappears.
    const withoutLive = compiledFixture(meta, []);
    expect(withoutLive.reserveExposures).toEqual([]);
    expect(withoutLive.reserveStatus.observationState).toBe("missing");
    expect(withoutLive.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-reserve-composition" }));
    expect(withoutLive.dependencies.edges).toEqual([]);
  });

  it("does not infer attribution from a reviewed coin id even without a non-link disposition", () => {
    const meta = classificationMeta();
    delete meta.reserveReview!.nonLinkDispositions;
    const asset = compiledFixture(meta, LIVE_ROWS);
    expect(asset.reserveExposures.find((row) => row.name === "Current Beta")).toMatchObject({
      assetClass: "stablecoin", issuerOrObligorKey: "Beta issuer", trackedAssetId: null, weight: 0.65,
    });
    expect(asset.dependencies).toMatchObject({ edges: [], mappedLiveReserveWeight: 0 });
  });

  it.each([
    "missing-live-key", "missing-reviewed-key", "mismatched-key", "duplicate-live-key",
    "duplicate-reviewed-key", "expired-review", "unknown-confidence", "future-review",
  ] as const)("fails closed for classification-only %s", (failure) => {
    const meta = classificationMeta();
    meta.reserves = [structuredClone(REVIEWED_ROWS[1]!)];
    delete meta.reserveReview!.nonLinkDispositions;
    const live: ReserveSlice[] = [{ ...LIVE_ROWS[1]!, name: "Pooled Beta", pct: 100 }];
    if (failure === "missing-live-key") delete live[0]!.sourceKey;
    if (failure === "missing-reviewed-key") delete meta.reserves[0]!.sourceKey;
    if (failure === "mismatched-key") live[0]!.sourceKey = "fixture:token:other";
    if (failure === "duplicate-live-key") {
      live[0]!.pct = 50;
      live.push({ ...live[0]!, name: "Duplicate live Beta" });
    }
    if (failure === "duplicate-reviewed-key") meta.reserves.push({ ...meta.reserves[0]!, name: "Duplicate reviewed Beta" });
    if (failure === "expired-review") meta.reserveReview!.reviewedAt = "2025-09-30";
    if (failure === "unknown-confidence") meta.reserveReview!.confidence = "unknown";
    if (failure === "future-review") meta.reserveReview!.reviewedAt = "2026-10-02";
    const classifications = buildReviewedReserveClassifications(live, meta, CLOCK_SEC);
    expect(classifications).toEqual([expect.objectContaining({
      assetClass: null, issuerOrObligorKey: null, trackedAssetId: null,
    })]);
    const mapping = dependencyReserveSlices(live, meta, CLOCK_SEC);
    expect(deriveEffectiveDependencySet(meta, {
      liveReserveSlices: mapping.slices, rejectionReasons: mapping.rejectionReasons,
    }).dependencies).toEqual([]);
  });

  it("admits a keyed classification at the 365-day boundary without refreshing composition", () => {
    const meta = classificationMeta();
    meta.reserveReview!.reviewedAt = "2025-10-01";
    meta.reserveReview!.compositionAsOf = "2025-10-01";
    const asset = compiledFixture(meta, LIVE_ROWS);
    expect(asset.reserveExposures.find((row) => row.name === "Current credit")).toMatchObject({
      assetClass: "private-credit", issuerOrObligorKey: "Reinsurer", weight: 0.35,
      status: { observationState: "known" },
    });
    const withoutLive = compiledFixture(meta, []);
    expect(withoutLive.reserveStatus.observationState).toBe("missing");
    expect(withoutLive.dependencies.edges).toEqual([]);
  });
});
