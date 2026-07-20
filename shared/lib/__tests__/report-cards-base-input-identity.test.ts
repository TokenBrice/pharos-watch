import { describe, expect, it } from "vitest";
import {
  computeReportCardsBaseInputGenerationId,
  deriveReportCardsBaseInputGenerationId,
  projectReportCardsBaseInputIdentityV1,
  type ReportCardsBaseInputSourceV1,
} from "@shared/lib/report-cards-base-input-identity";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function source(): ReportCardsBaseInputSourceV1 {
  return {
    captureKind: "exact-publication-inputs",
    clockSec: 1_800_000_000,
    updatedAt: 1_799_999_900,
    activeAssetIds: ["usdt-tether", "usdc-circle"],
    registryFingerprint: A,
    dexGenerationId: "dex-liquidity-1799999800",
    redemptionGenerationId: "redemption:fixture",
    dexPayloadFingerprint: B,
    redemptionPayloadFingerprint: C,
    inputMethodologyVersions: {
      safetyScore: "8.17",
      dexLiquidity: ["5.91"],
      pegScore: ["6.096"],
      redemptionBackstop: ["4.17"],
    },
    pegDataById: { "usdc-circle": { pegScore: 99 }, "usdt-tether": { pegScore: 98 } },
    activeDepegPeakBpsById: {},
    dexLiqMap: { "usdc-circle": { liquidityScore: 95 }, "usdt-tether": { liquidityScore: 96 } },
    redemptionBackstopMap: { "usdc-circle": { score: 95 }, "usdt-tether": { score: 92 } },
    bluechipMap: { "usdc-circle": { grade: "A" } },
    resolvedBlacklistStatuses: { "usdc-circle": true, "usdt-tether": true },
    liveReserveMap: { "usdc-circle": [{ name: "cash", pct: 100 }] },
    liveReserveProvenanceMap: { "usdc-circle": { source: "fixture", fetchedAt: 1_799_999_700 } },
    chainCirculatingById: { "usdc-circle": { ethereum: { current: 1_000_000 } } },
    aggregateCirculatingById: {
      "usdc-circle": { circulating: { peggedUSD: 1_000_000 }, observedAtSec: 1_799_999_600 },
    },
    dexDeploymentSupplyCoverageById: { "usdc-circle": { observedSupplyRatio: 1 } },
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: 1_799_999_800, ageSeconds: 200, stale: false },
      redemptionBackstops: { updatedAt: 1_799_999_700, ageSeconds: 300, stale: false },
    },
  };
}

describe("report-card base-input identity", () => {
  it("is invariant to record, asset, and methodology ordering", () => {
    const left = source();
    const right = source();
    right.activeAssetIds = [...right.activeAssetIds].reverse();
    right.inputMethodologyVersions.dexLiquidity = ["5.91", "5.91"];
    right.pegDataById = Object.fromEntries(Object.entries(right.pegDataById).reverse());
    right.dexLiqMap = Object.fromEntries(Object.entries(right.dexLiqMap).reverse());

    expect(projectReportCardsBaseInputIdentityV1(right)).toEqual(projectReportCardsBaseInputIdentityV1(left));
    expect(deriveReportCardsBaseInputGenerationId(right)).toBe(deriveReportCardsBaseInputGenerationId(left));
  });

  it("separates score-bearing fact changes from freshness changes", () => {
    const baseline = projectReportCardsBaseInputIdentityV1(source());
    const factChanged = source();
    factChanged.pegDataById = { ...factChanged.pegDataById, "usdc-circle": { pegScore: 91 } };
    const freshnessChanged = source();
    freshnessChanged.inputFreshness = {
      ...(freshnessChanged.inputFreshness as Record<string, unknown>),
      dexLiquidity: { updatedAt: 1_799_999_800, ageSeconds: 201, stale: false },
    };

    const factIdentity = projectReportCardsBaseInputIdentityV1(factChanged);
    const freshnessIdentity = projectReportCardsBaseInputIdentityV1(freshnessChanged);
    expect(factIdentity.normalizedSnapshotDigests.scoreBearingFactsSha256).not.toBe(
      baseline.normalizedSnapshotDigests.scoreBearingFactsSha256,
    );
    expect(factIdentity.normalizedSnapshotDigests.scoreBearingFreshnessSha256).toBe(
      baseline.normalizedSnapshotDigests.scoreBearingFreshnessSha256,
    );
    expect(freshnessIdentity.normalizedSnapshotDigests.scoreBearingFactsSha256).toBe(
      baseline.normalizedSnapshotDigests.scoreBearingFactsSha256,
    );
    expect(freshnessIdentity.normalizedSnapshotDigests.scoreBearingFreshnessSha256).not.toBe(
      baseline.normalizedSnapshotDigests.scoreBearingFreshnessSha256,
    );
  });

  it("excludes safety methodology, operator metadata, and V9 policy metadata", () => {
    const baseline = source();
    const excluded = {
      ...source(),
      capturedAt: "2027-01-15T08:00:00.000Z",
      registryRevision: "operator-revision",
      v9PolicyDigest: A,
      publicationGenerationId: "report-cards:9.0:test",
    };
    excluded.inputMethodologyVersions.safetyScore = "999";

    expect(projectReportCardsBaseInputIdentityV1(excluded)).toEqual(projectReportCardsBaseInputIdentityV1(baseline));
  });

  it("binds producer identities and producer methodology versions", () => {
    const baseline = deriveReportCardsBaseInputGenerationId(source());
    const producerChanged = source();
    producerChanged.dexPayloadFingerprint = C;
    const methodologyChanged = source();
    methodologyChanged.inputMethodologyVersions.pegScore = ["6.097"];

    expect(deriveReportCardsBaseInputGenerationId(producerChanged)).not.toBe(baseline);
    expect(deriveReportCardsBaseInputGenerationId(methodologyChanged)).not.toBe(baseline);
  });

  it("binds aggregate circulating supply as a score-bearing fact", () => {
    const baseline = source();
    const supplyChanged = source();
    supplyChanged.aggregateCirculatingById = {
      "usdc-circle": { circulating: { peggedUSD: 2_000_000 }, observedAtSec: 1_799_999_600 },
    };

    expect(deriveReportCardsBaseInputGenerationId(supplyChanged)).not.toBe(
      deriveReportCardsBaseInputGenerationId(baseline),
    );
    // Aggregate supply is a fact, not freshness.
    expect(projectReportCardsBaseInputIdentityV1(supplyChanged).normalizedSnapshotDigests.scoreBearingFreshnessSha256).toBe(
      projectReportCardsBaseInputIdentityV1(baseline).normalizedSnapshotDigests.scoreBearingFreshnessSha256,
    );
  });

  it("keeps the generation stable for inputs that agree on aggregate supply", () => {
    expect(deriveReportCardsBaseInputGenerationId(source())).toBe(deriveReportCardsBaseInputGenerationId(source()));
  });

  it("projects a pre-field capture deterministically as an empty aggregate map", () => {
    const absent = source();
    delete absent.aggregateCirculatingById;
    const explicitlyEmpty = { ...source(), aggregateCirculatingById: {} };

    // A capture predating the field must land on exactly one identity, and it
    // must be the identity of an empty map — matching the fixed-input schema
    // default that fills the field in before this projection ever sees it.
    expect(deriveReportCardsBaseInputGenerationId(absent)).toBe(
      deriveReportCardsBaseInputGenerationId(explicitlyEmpty),
    );
    expect(deriveReportCardsBaseInputGenerationId(absent)).toBe(deriveReportCardsBaseInputGenerationId(absent));
    expect(deriveReportCardsBaseInputGenerationId(absent)).not.toBe(deriveReportCardsBaseInputGenerationId(source()));
  });

  it("computes the same generation from an already projected identity", () => {
    const projected = projectReportCardsBaseInputIdentityV1(source());
    expect(computeReportCardsBaseInputGenerationId(projected)).toBe(deriveReportCardsBaseInputGenerationId(source()));
  });
});
