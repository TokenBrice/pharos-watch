import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

const getReserveSyncStateMock = vi.fn();
const getLatestSuccessfulReserveSnapshotMetadataMock = vi.fn();

vi.mock("../live-reserves-store", () => ({
  getReserveSyncState: getReserveSyncStateMock,
  getLatestSuccessfulReserveSnapshotMetadata: getLatestSuccessfulReserveSnapshotMetadataMock,
  LIVE_RESERVE_FRESHNESS_SEC: 3600,
}));

describe("buildRedemptionBackstopEntry", () => {
  let buildRedemptionBackstopEntry: typeof import("../redemption-backstop-sources").buildRedemptionBackstopEntry;
  const now = 1_700_000_000;

  beforeEach(async () => {
    vi.resetModules();
    getReserveSyncStateMock.mockResolvedValue(null);
    getLatestSuccessfulReserveSnapshotMetadataMock.mockResolvedValue(null);
    const mod = await import("../redemption-backstop-sources");
    buildRedemptionBackstopEntry = mod.buildRedemptionBackstopEntry;
  });

  it("resolves supply-full capacity with valid supply", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      100_000_000, // $100M supply
      50, // dex liquidity score
      now,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacitySemantics).toBe("eventual-only");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.immediateCapacityRatio).toBeNull();
    expect(entry.score).not.toBeNull();
    expect(entry.score).toBeLessThanOrEqual(65); // offchain-issuer cap
    expect(entry.capsApplied).toContain("offchain-route-cap");
  });

  it("returns missing-cache when supply is null for supply-full model", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      null,
      50,
      now,
    );

    expect(entry.resolutionState).toBe("missing-cache");
    expect(entry.score).toBeNull();
    expect(entry.immediateCapacityUsd).toBeNull();
  });

  it("resolves supply-ratio capacity correctly", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-ratio", ratio: 0.33 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      1_000_000_000,
      80,
      now,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(330_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.33);
    expect(entry.score).not.toBeNull();
  });

  it("applies queue-redeem cap", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      500_000_000,
      null,
      now,
    );

    expect(entry.score).not.toBeNull();
    expect(entry.score!).toBeLessThanOrEqual(70);
    expect(entry.capsApplied).toContain("queue-route-cap");
  });

  it("scores fixed 0 bps fee as 100", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(100);
    expect(entry.feeBps).toBe(0);
    expect(entry.feeConfidence).toBe("fixed");
  });

  it("scores fixed 25 bps fee as 80", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 25 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(80);
    expect(entry.feeBps).toBe(25);
  });

  it("scores fixed 75 bps fee as 60", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 75 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(60);
  });

  it("scores fixed 200 bps fee as 40", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 200 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(40);
  });

  it("scores formula-confidence dynamic fees as 60", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "bold-liquity",
      {
        routeFamily: "collateral-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "bluechip-collateral",
        capacityModel: { kind: "supply-full" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(60);
    expect(entry.feeConfidence).toBe("formula");
  });

  it("uses live fee metadata for formula routes when reserve sync exposes a current fee", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "collateral-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "bluechip-collateral",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      },
      100_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "bold-liquity",
          fetchedAt: now - 300,
          source: "single-asset",
          metadata: { redemptionFeeBps: 50, freshnessMode: "not-applicable" },
          warningCount: 0,
          warnings: [],
          sourceModel: "single-bucket",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.costScore).toBe(80);
    expect(entry.feeBps).toBe(50);
    expect(entry.feeConfidence).toBe("formula");
    expect(entry.feeModelKind).toBe("formula");
  });

  it("scores undisclosed-reviewed dynamic fees as 40", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Public docs reviewed do not publish a numeric redemption fee.",
          confidence: "undisclosed-reviewed",
        },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.costScore).toBe(40);
    expect(entry.feeConfidence).toBe("undisclosed-reviewed");
  });

  it("resolves reserve-sync-metadata capacity with fresh data", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usdo-openeden",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      },
      50_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "usdo-openeden",
          fetchedAt: now - 1800,
          source: "test",
          metadata: {
            immediateRedeemableUsd: 7_500_000,
            immediateRedeemableRatio: 0.15,
            sourceTimestamp: now - 1800,
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000);
    expect(entry.immediateCapacityRatio).toBe(0.15);
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
  });

  it("derives reserve-sync ratio from supply when nested capacity omits ratio", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usde-ethena",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "whitelisted-onchain",
        settlementModel: "immediate",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Ethena collateral API", url: "https://app.ethena.fi/api/positions/current/collateral" }],
      },
      100_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "usde-ethena",
          fetchedAt: now - 120,
          source: "ethena",
          metadata: {
            immediateRedeemableRatio: 0.9,
            freshnessMode: "verified",
            sourceTimestamp: now - 120,
            redemption: {
              capacityUsd: 50_000_000,
              capacityKind: "live-proxy-validated",
              freshnessKind: "verified-source-timestamp",
              sourceTimestamp: now - 120,
              routeStatus: "open",
            },
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.immediateCapacityUsd).toBe(50_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.5);
  });

  it("propagates live route status from reserve metadata", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "cusd-cap",
      {
        routeFamily: "basket-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Cap vault", url: "https://docs.cap.app/concepts/vault" }],
      },
      100_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "cusd-cap",
          fetchedAt: now - 120,
          source: "cap-vault",
          metadata: {
            freshnessMode: "not-applicable",
            redemption: {
              capacityUsd: 10_000_000,
              capacityKind: "live-direct-bounded",
              freshnessKind: "same-run-onchain",
              routeStatus: "paused",
              routeStatusSource: "onchain",
              routeStatusReason: "All vault assets are paused",
              routeStatusReviewedAt: "2026-04-15",
            },
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.routeStatus).toBe("paused");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.routeStatusReason).toBe("All vault assets are paused");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-15");
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.effectiveExitScore).toBeNull();
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("uses LUSD Liquity v1 system debt as live direct redemption capacity", async () => {
    const config = getRedemptionBackstopConfig("lusd-liquity");
    expect(config).not.toBeNull();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "lusd-liquity",
      config!,
      100_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "lusd-liquity",
          fetchedAt: now - 120,
          source: "liquity-v1",
          metadata: {
            freshnessMode: "not-applicable",
            redemptionFeeBps: 50,
            redemption: {
              capacityUsd: 84_000_000,
              capacityKind: "live-direct-bounded",
              freshnessKind: "same-run-onchain",
              feeBps: 50,
            },
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "single-bucket",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.immediateCapacityUsd).toBe(84_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.84);
    expect(entry.capacityBasis).toBe("live-direct-telemetry");
    expect(entry.feeBps).toBe(50);
    expect(entry.modelConfidence).toBe("high");
  });

  it("uses BOLD Liquity v2 branch debt as live direct redemption capacity", async () => {
    const config = getRedemptionBackstopConfig("bold-liquity");
    expect(config).not.toBeNull();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "bold-liquity",
      config!,
      40_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "bold-liquity",
          fetchedAt: now - 120,
          source: "liquity-v2-branches",
          metadata: {
            freshnessMode: "not-applicable",
            redemptionFeeBps: 52,
            redemption: {
              capacityUsd: 32_000_000,
              capacityKind: "live-direct-bounded",
              freshnessKind: "same-run-onchain",
              routeStatus: "open",
              feeBps: 52,
            },
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.immediateCapacityUsd).toBe(32_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.8);
    expect(entry.capacityBasis).toBe("live-direct-telemetry");
    expect(entry.feeBps).toBe(52);
    expect(entry.modelConfidence).toBe("high");
  });

  it("models the ZCHF StablecoinBridge route with live bridge capacity and zero fee", async () => {
    const config = getRedemptionBackstopConfig("zchf-frankencoin");
    expect(config).not.toBeNull();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "zchf-frankencoin",
      config!,
      27_682_881.200551473,
      35,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "zchf-frankencoin",
          fetchedAt: now - 300,
          source: "collateral-positions-api",
          metadata: {
            immediateRedeemableUsd: 494_182.68,
            freshnessMode: "unverified",
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.routeFamily).toBe("stablecoin-redeem");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.immediateCapacityUsd).toBe(494_182.68);
    expect(entry.feeBps).toBe(0);
    expect(entry.feeConfidence).toBe("fixed");
    expect(entry.modelConfidence).toBe("high");
  });

  it("falls back to ratio when reserve-sync has no immediate capacity data", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      },
      50_000_000,
      null,
      now,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.sourceMode).toBe("estimated");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000); // 50M * 0.15
    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.capacityConfidence).toBe("heuristic");
  });

  it("uses reviewed fallback confidence and basis for reserve-sync fallback ratios", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: {
          kind: "reserve-sync-metadata",
          fallbackRatio: 0.0025,
          confidence: "documented-bound",
          basis: "hot-buffer",
        },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
        reviewedAt: "2026-04-04",
        docs: [{ label: "Reviewed source", url: "https://example.com" }],
      },
      100_000_000,
      null,
      now,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacityConfidence).toBe("documented-bound");
    expect(entry.capacityBasis).toBe("hot-buffer");
    expect(entry.immediateCapacityUsd).toBe(250_000);
  });

  it("returns missing-capacity when reserve-sync has no data and no fallback", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      },
      50_000_000,
      null,
      now,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.effectiveExitScore).toBeNull();
  });

  it("explains missing capacity when a capable live adapter omits capacity amounts", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "zchf-frankencoin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      50_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "zchf-frankencoin",
          fetchedAt: now - 120,
          source: "collateral-positions-api",
          metadata: {
            freshnessMode: "unverified",
            details: {
              freshnessSource: "position-and-price-apis",
              freshnessReason: "Collateral positions and price payloads do not expose a trustworthy source timestamp",
            },
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.notes).toContain("Live reserve metadata lacks redeemable-capacity amount");
  });

  it("does not emit an effective-exit score when the redemption route is unresolved", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      },
      50_000_000,
      55,
      now,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.effectiveExitScore).toBeNull();
  });

  it("computes effective exit score blending liquidity and redemption", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      500_000_000,
      40,
      now,
    );

    expect(entry.effectiveExitScore).not.toBeNull();
    // With liquidity=40 and a high redemption score, blend should exceed pure liquidity
    expect(entry.effectiveExitScore!).toBeGreaterThan(40);
  });

  it("marks static redemption routes impaired during severe active depegs", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
      },
      100_000_000,
      33,
      now,
      {
        routeAvailability: {
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          routeStatusReason:
            "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegBps: 8332,
          activeDepegStartedAt: 1_774_145_097,
        },
      },
    );

    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.effectiveExitScore).toBeNull();
    expect(entry.routeStatus).toBe("degraded");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-14");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-impairment");
    expect(entry.notes).toContain(
      "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
    );
  });

  it("keeps strong live-direct routes scoreable during severe active depegs", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "zchf-frankencoin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      50_000_000,
      33,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "zchf-frankencoin",
          fetchedAt: now - 120,
          source: "test",
          metadata: {
            immediateRedeemableUsd: 5_000_000,
            immediateRedeemableRatio: 0.1,
            sourceTimestamp: now - 120,
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
        routeAvailability: {
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          routeStatusReason:
            "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegBps: 3000,
          activeDepegStartedAt: now,
        },
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).not.toBeNull();
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("static-config");
    expect(entry.modelConfidence).toBe("high");
    expect(entry.capsApplied).not.toContain("market-implied-depeg-impairment");
  });

  it("derives modelConfidence correctly for resolved entries", async () => {
    // Dynamic capacity + fixed fee → high
    const highEntry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usdo-openeden",
      {
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      50_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "usdo-openeden",
          fetchedAt: now - 100,
          source: "test",
          metadata: {
            immediateRedeemableUsd: 5_000_000,
            immediateRedeemableRatio: 0.1,
            sourceTimestamp: now - 100,
          },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );
    expect(highEntry.modelConfidence).toBe("high");

    // Documented eventual redeemability + reviewed formula fee -> medium
    const mediumEntry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "collateral-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "bluechip-collateral",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      },
      100_000_000,
      null,
      now,
    );
    expect(mediumEntry.modelConfidence).toBe("medium");
    expect(mediumEntry.capacitySemantics).toBe("eventual-only");

    // Supply-full (heuristic capacity) → low
    const lowEntry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "dynamic-or-unclear" },
      },
      100_000_000,
      null,
      now,
    );
    expect(lowEntry.modelConfidence).toBe("low");
  });

  it("stops using stale reserve capacity metadata when no safe fallback exists", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "gho-aave",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      },
      50_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "test-coin",
          fetchedAt: now - 7_200,
          source: "test",
          metadata: { immediateRedeemableUsd: 10_000_000, immediateRedeemableRatio: 0.2 },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.notes).toContain("Live reserve metadata stale; fresh metadata required");
  });

  it("keeps GHO resolved when the only live warning is aggregated residual issuance", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "gho-aave",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      },
      584_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "gho-aave",
          fetchedAt: now - 120,
          source: "gho",
          metadata: {
            immediateRedeemableUsd: 212_370_000,
            immediateRedeemableRatio: 212_370_000 / 584_000_000,
            redemptionFeeBps: 10,
            freshnessMode: "not-applicable",
          },
          warningCount: 1,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
          ],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "degraded",
        },
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.immediateCapacityUsd).toBe(212_370_000);
    expect(entry.notes).toContain(
      "Using tracked live GSM backing as a lower-bound redemption capacity despite aggregated residual issuance outside configured GSM modules",
    );
  });

  it("still blocks GHO when degraded live metadata includes non-allowlisted warnings", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "gho-aave",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      },
      584_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "gho-aave",
          fetchedAt: now - 120,
          source: "gho",
          metadata: {
            immediateRedeemableUsd: 212_370_000,
            immediateRedeemableRatio: 212_370_000 / 584_000_000,
            freshnessMode: "not-applicable",
          },
          warningCount: 2,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
            {
              code: "tracked-gsm-read-failed",
              message: "Tracked GSM module could not be read",
              severity: "warning",
              effect: "degraded",
            },
          ],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "degraded",
        },
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.notes).toContain("Live reserve metadata degraded; latest snapshot not in ok state");
  });

  it("uses fresh live redemption fee telemetry for fixed-fee routes", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "fee-bps",
          feeBps: 10,
          feeDescription: "Reviewed fallback bound is 10 bps",
        },
      },
      50_000_000,
      null,
      now,
      {
        reserveSnapshotMetadata: {
          stablecoinId: "gho-aave",
          fetchedAt: now - 120,
          source: "test",
          metadata: { redemptionFeeBps: 7, sourceTimestamp: now - 120 },
          warningCount: 0,
          warnings: [],
          sourceModel: "dynamic-mix",
          evidenceClass: "independent",
          syncStatus: "ok",
        },
      },
    );

    expect(entry.feeBps).toBe(7);
    expect(entry.costScore).toBe(100);
    expect(entry.notes).toContain("Using fresh live redemption fee telemetry in place of the reviewed fallback bound");
  });

  it("populates docs from proofOfReserves when available", async () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether");
    expect(meta?.proofOfReserves?.url).toBeTruthy();

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usdt-tether",
      {
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.docs).toBeDefined();
    expect(entry.docs!.url).toBe(meta!.proofOfReserves!.url);
    expect(entry.docs!.label).toContain("feed");
    expect(entry.docs!.provenance).toBe("proof-of-reserves");
  });

  it("falls back to preferred link labels when no proofOfReserves", async () => {
    const meta = TRACKED_META_BY_ID.get("usds-sky");
    expect(meta?.proofOfReserves?.url).toBeFalsy();
    const preferredLabels = ["Docs", "Proof of Reserve", "Transparency", "Website"];
    const hasPreferred = meta?.links?.some((l) => preferredLabels.includes(l.label));
    expect(hasPreferred).toBe(true);

    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "usds-sky",
      {
        routeFamily: "psm-swap",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      1_000_000_000,
      null,
      now,
    );

    expect(entry.docs).toBeDefined();
    expect(preferredLabels).toContain(entry.docs!.label);
    expect(entry.docs!.provenance).toBe("preferred-link");
  });

  it("returns no docs for unknown coins", async () => {
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      },
      100_000_000,
      null,
      now,
    );

    expect(entry.docs).toBeUndefined();
  });

  it("deduplicates notes both within config and across config + runtime sources", async () => {
    const runtimeNote = "Live reserve metadata unavailable; using configured fallback ratio";
    const entry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
      {
        routeFamily: "stablecoin-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-onchain",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
        notes: ["Shared note", "Shared note", runtimeNote],
      },
      1_000_000,
      50,
      now,
      { reserveSnapshotMetadata: null },
    );
    const notes = entry.notes ?? [];
    expect(notes.filter((n) => n === "Shared note").length).toBe(1);
    expect(notes.filter((n) => n === runtimeNote).length).toBe(1);
  });
});
