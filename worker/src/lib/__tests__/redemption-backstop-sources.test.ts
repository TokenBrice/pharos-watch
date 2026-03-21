import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const getReserveSyncStateMock = vi.fn();

vi.mock("../live-reserves-store", () => ({
  getReserveSyncState: getReserveSyncStateMock,
  LIVE_RESERVE_FRESHNESS_SEC: 3600,
}));

describe("resolveCostScore", () => {
  let resolveCostScore: typeof import("../redemption-backstop-sources")["resolveCostScore" & keyof typeof import("../redemption-backstop-sources")];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../redemption-backstop-sources");
    // resolveCostScore is not exported — test it through buildRedemptionBackstopEntry
  });

  it("placeholder — tested indirectly via buildRedemptionBackstopEntry", () => {
    expect(true).toBe(true);
  });
});

describe("buildRedemptionBackstopEntry", () => {
  let buildRedemptionBackstopEntry: typeof import("../redemption-backstop-sources").buildRedemptionBackstopEntry;
  const now = 1_700_000_000;

  beforeEach(async () => {
    vi.resetModules();
    getReserveSyncStateMock.mockResolvedValue(null);
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
    expect(entry.immediateCapacityUsd).toBe(100_000_000);
    expect(entry.immediateCapacityRatio).toBe(1);
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
      "test-coin",
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
      {
        reserveSyncState: {
          stablecoinId: "test-coin",
          adapterKey: "test",
          breakerKey: "test",
          lastAttemptedAt: now - 1800,
          lastSuccessAt: now - 1800, // 30 min ago = fresh
          lastStatus: "ok",
          warningCount: 0,
          warnings: [],
          lastError: null,
          metadata: {
            immediateRedeemableUsd: 7_500_000,
            immediateRedeemableRatio: 0.15,
          },
        },
      },
    );

    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000);
    expect(entry.immediateCapacityRatio).toBe(0.15);
    expect(entry.capacityConfidence).toBe("dynamic");
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
      { reserveSyncState: null },
    );

    expect(entry.sourceMode).toBe("estimated");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000); // 50M * 0.15
    expect(entry.provider).toBe("reserve-sync-fallback");
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
      { reserveSyncState: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
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

  it("derives modelConfidence correctly for resolved entries", async () => {
    // Dynamic capacity + fixed fee → high
    const highEntry = await buildRedemptionBackstopEntry(
      mockD1(),
      "test-coin",
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
        reserveSyncState: {
          stablecoinId: "test-coin",
          adapterKey: "test",
          breakerKey: "test",
          lastAttemptedAt: now - 100,
          lastSuccessAt: now - 100,
          lastStatus: "ok",
          warningCount: 0,
          warnings: [],
          lastError: null,
          metadata: { immediateRedeemableUsd: 5_000_000, immediateRedeemableRatio: 0.1 },
        },
      },
    );
    expect(highEntry.modelConfidence).toBe("high");

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
});
