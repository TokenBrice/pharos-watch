import { describe, expect, it } from "vitest";
import {
  REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX,
  computeReportCardsBaseInputGenerationId,
  deriveReportCardsBaseInputGenerationId,
  projectReportCardsBaseInputIdentity,
  projectReportCardsBaseInputIdentityV1,
  type ReportCardsBaseInputSourceV1,
} from "@shared/lib/report-cards-base-input-identity";
import type { ReportCardsBaseInputIdentityV1 } from "@shared/types/report-cards-base-input";

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

function projectedInput(): ReportCardsBaseInputIdentityV1 {
  return {
    schemaVersion: 1 as const,
    captureKind: "exact-publication-inputs" as const,
    publicationClockSec: 1_800_000_000,
    sourceUpdatedAtSec: 1_799_999_900,
    registry: {
      activeAssetIds: ["usdt-tether", "usdc-circle", "usdc-circle"],
      fingerprintSha256: A,
    },
    producers: {
      dex: { generationId: "dex-liquidity-1800000000", payloadSha256: B },
      redemption: { generationId: "redemption-1800000000", payloadSha256: C },
    },
    producerMethodologyVersions: {
      dexLiquidity: ["4.2", "4.1", "4.2"],
      pegScore: ["7.25"],
      redemptionBackstop: ["3.0", "2.9"],
    },
    normalizedSnapshotDigests: {
      scoreBearingFactsSha256: "d".repeat(64),
      scoreBearingFreshnessSha256: "e".repeat(64),
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
    expect(deriveReportCardsBaseInputGenerationId(absent)).not.toBe(deriveReportCardsBaseInputGenerationId(source()));
  });

  it("computes the same generation from an already projected identity", () => {
    const projected = projectReportCardsBaseInputIdentityV1(source());
    expect(computeReportCardsBaseInputGenerationId(projected)).toBe(deriveReportCardsBaseInputGenerationId(source()));
  });

  it("canonicalizes projected set-like arrays and pins their generation identity", () => {
    const projected = projectReportCardsBaseInputIdentity(projectedInput());
    expect(projected.registry.activeAssetIds).toEqual(["usdc-circle", "usdt-tether"]);
    expect(projected.producerMethodologyVersions).toEqual({
      dexLiquidity: ["4.1", "4.2"],
      pegScore: ["7.25"],
      redemptionBackstop: ["2.9", "3.0"],
    });

    const generationId = computeReportCardsBaseInputGenerationId(projectedInput());
    expect(generationId.startsWith(REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX)).toBe(true);
    expect(generationId).toBe(
      "report-cards-input:v1:f755e130eaac7816dfeffb7a18893d903308d166b1e22336f37f3a563b48cecd",
    );
  });

  it("rejects projected source clocks later than the publication clock", () => {
    const input = projectedInput();
    input.sourceUpdatedAtSec = input.publicationClockSec + 1;
    expect(() => projectReportCardsBaseInputIdentity(input)).toThrow(/publication clock/);
  });

  it.each(["dexLiquidity", "pegScore", "redemptionBackstop"] as const)(
    "rejects an empty %s methodology version set",
    (field) => {
      const input = projectedInput();
      input.producerMethodologyVersions[field] = [];
      expect(() => projectReportCardsBaseInputIdentity(input)).toThrow(/At least one producer methodology version/);
    },
  );

  it.each([
    ["safety methodology", { methodologyVersion: "8.17" }],
    ["V9 policy", { v9PolicyDigest: A }],
    ["publication generation", { publicationGenerationId: "report-cards:8.17:1800000000" }],
    ["operator capture time", { capturedAt: "2027-01-15T08:00:00.000Z" }],
    ["operator revision", { registryRevision: "deadbeef" }],
  ])("rejects excluded %s metadata at the projected-input fence", (_label, extra) => {
    expect(() => projectReportCardsBaseInputIdentity({ ...projectedInput(), ...extra })).toThrow();
  });

  it("rejects a safety-score methodology key in the producer version object", () => {
    const input = projectedInput() as ReportCardsBaseInputIdentityV1 & {
      producerMethodologyVersions: ReportCardsBaseInputIdentityV1["producerMethodologyVersions"] & {
        safetyScore: string[];
      };
    };
    input.producerMethodologyVersions.safetyScore = ["8.17"];
    expect(() => projectReportCardsBaseInputIdentity(input)).toThrow();
  });
});
