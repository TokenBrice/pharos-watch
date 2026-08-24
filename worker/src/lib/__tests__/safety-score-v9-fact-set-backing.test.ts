import { describe, expect, it } from "vitest";
import type { ReserveSlice } from "@shared/types/reserves";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const ASSET_ID = "alpha";
const EXPIRED_HISTORY_CLOCK_SEC = Date.UTC(2027, 7, 1) / 1_000;
const NO_HISTORY_CLOCK_SEC = Date.UTC(2026, 7, 1) / 1_000;

function baseMeta(): V9ExtensionRegistryMeta {
  return {
    id: ASSET_ID,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    mintAuthority: {
      mintPath: "centralized",
      authorityPosture: "issuer-controlled",
      confidence: "verified",
      summary: "Fixture mint profile",
      review: {
        evidence: "Fixture evidence",
        reviewer: "fixture",
        reviewedAt: "2026-07-16",
      },
      supervision: "prudential",
    },
  };
}

function expiredReserveMeta(): V9ExtensionRegistryMeta {
  const reserves: ReserveSlice[] = [
    {
      name: "Treasury repo",
      pct: 90,
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "Regulated counterparties",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 1,
    },
    {
      name: "Cash",
      pct: 10,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Commercial banks",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "immediate",
    },
  ];
  return {
    ...baseMeta(),
    reserves,
    reserveReview: {
      reviewedAt: "2026-07-16",
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Composition", url: "https://example.com/composition" }],
      rationale: "Complete fixture composition",
      compositionBasis: "Signed report",
      compositionAsOf: "2026-06-30",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
    proofOfReserves: {
      type: "independent-audit",
      url: "https://example.com/transparency",
      provider: "Independent LLP",
      attestorTier: "regional",
      cadence: "monthly",
      latestReport: {
        periodEnd: "2026-06-30",
        publishedAt: "2026-07-10",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        reviewer: "fixture",
        confidence: "verified",
        sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
      },
    },
  };
}

function compileWithEmptyLiveReserves(meta: V9ExtensionRegistryMeta, clockSec: number) {
  const fixed = makeV9FixedInput({
    assetId: ASSET_ID,
    clockSec,
    reserves: [],
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[ASSET_ID, meta]]),
  });
  return {
    fixed,
    extension,
    asset: compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!,
  };
}

describe("Safety Score v9 backing fact-set reserve history", () => {
  it("reports expired published reserve composition evidence as stale", () => {
    const { fixed, extension, asset } = compileWithEmptyLiveReserves(
      expiredReserveMeta(),
      EXPIRED_HISTORY_CLOCK_SEC,
    );
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);
    expect(extension.assets[0]!.reviewedStaticReserveRows).toBeNull();
    expect(extension.assets[0]!.componentEvidence).toContainEqual(
      expect.objectContaining({ componentKey: "reserve-composition-history" }),
    );

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      message: "The last published reserve composition is older than the v9 freshness bound.",
      observationState: "stale",
      evidenceRefIds: expect.arrayContaining([expect.any(String)]),
    });
    expect(reserveGap!.evidenceRefIds.length).toBeGreaterThan(0);
    expect(asset.reserveStatus).toMatchObject({
      observationState: "stale",
      evidenceRefIds: reserveGap!.evidenceRefIds,
    });
    for (const evidenceRefId of reserveGap!.evidenceRefIds) {
      expect(asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId)).toMatchObject({
        sourceId: "stablecoin-meta.expired-reviewed-static-reserves",
        freshness: { state: "stale" },
      });
    }
  });

  it("reports a generic missing reserve composition when no history exists", () => {
    const { fixed, extension, asset } = compileWithEmptyLiveReserves(baseMeta(), NO_HISTORY_CLOCK_SEC);
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);
    expect(extension.assets[0]!.componentEvidence).not.toContainEqual(
      expect.objectContaining({ componentKey: "reserve-composition-history" }),
    );

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      message: "No reserve composition is present in the exact fixed input.",
      observationState: "missing",
      evidenceRefIds: [],
    });
    expect(asset.reserveStatus).toMatchObject({
      observationState: "missing",
      evidenceRefIds: [],
    });
  });
});
