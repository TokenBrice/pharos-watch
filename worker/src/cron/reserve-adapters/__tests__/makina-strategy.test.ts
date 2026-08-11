import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getReserveAdapter } from "../index";
import { adaptMakinaStrategyReserves, buildMakinaRedemptionMetadata } from "../makina-strategy";
import { validateAdapterOutput } from "../validate";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const STRATEGY_FIXTURE = JSON.parse(readFileSync(join(FIXTURES_DIR, "makina-strategy.json"), "utf8"));
const ALLOCATIONS_FIXTURE = JSON.parse(readFileSync(join(FIXTURES_DIR, "makina-allocations.json"), "utf8"));

const PARAMS = {
  allocationsUrl: "https://api.makina.finance/v1/strategies/0x6b006870C83b1Cd49E766Ac9209f8d68763Df721/allocations",
  machineAddress: "0x6b006870C83b1Cd49E766Ac9209f8d68763Df721",
  accountingTokenSymbol: "USDC",
  accountingTokenDecimals: 6,
  otherThresholdPct: 2,
  reconciliationTolerancePct: 0.5,
};
const REVIEWED_IMPLEMENTATION = "0xd53dc14e0f268494c7540153126d78e4f54cc01c";
const ASYNC_REDEEMER = "0x1303c26cfe06bac5bfee29907f37919643def75c";
const REVIEWED_IMPLEMENTATION_CODE_HASH =
  "0xeed090b1c06e966eebca301a1fed3f0c152044c04912d8b5d7e7c934fa3a192a";
const REDEMPTION_STATE = {
  whitelistEnabled: true,
  minimumFinalizationDelaySec: 43_200,
  nextRequestId: 344,
  lastFinalizedRequestId: 342,
  pendingRequestCount: 1,
  lockedShares: 3_000,
  grossIdleCapacityUsd: 120.722783,
  queueDepthUsd: 3_104.889979,
  reservedUnclaimedUsdc: 0.003679,
  minimumRedeemShares: 1,
  capacityUsd: 0,
  blockNumber: 25_646_765,
  asyncRedeemerAddress: ASYNC_REDEEMER,
  implementationAddress: REVIEWED_IMPLEMENTATION,
  implementationRuntimeCodeHash: REVIEWED_IMPLEMENTATION_CODE_HASH,
};

describe("makina-strategy adapter", () => {
  it("groups protocol buckets, subtracts debts, and preserves unlabelled exposure", () => {
    const result = adaptMakinaStrategyReserves(STRATEGY_FIXTURE, ALLOCATIONS_FIXTURE, PARAMS);

    expect(result.slices).toEqual([
      { name: "Morpho lending positions", pct: 62.2, risk: "medium" },
      { name: "Aave V4 positions", pct: 19.1, risk: "medium" },
      { name: "Re Protocol exposure", pct: 9.1, risk: "high" },
      {
        name: "Unallocated USDC balances",
        pct: 6.4,
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
      },
      { name: "Unknown Makina exposure", pct: 2.7, risk: "high" },
      { name: "Other identified Makina positions", pct: 0.5, risk: "high" },
    ]);
    expect(result.metadata?.totalReserveUsd).toBe(11000);
    expect(result.metadata?.totalDebtUsd).toBe(500);
    expect(result.metadata?.totalAssetsUsd).toBe(11500);
    expect(result.metadata?.referenceNavUsd).toBe(1.035);
    expect(result.metadata?.currentAumUsd).toBe(11000);
    expect(result.metadata?.reportedAumUsd).toBe(11000);
    expect(result.metadata?.lastReportedAumUsd).toBe(11000);
    expect(result.metadata?.details?.reconciliationKind).toBe("allocation-net-value-equals-current-aum");
    expect(result.metadata?.details?.reconciliationAumUsd).toBe(11000);
    expect(result.metadata?.shareSupply).toBeCloseTo(9661835.74879227);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(2.727272727);
    expect(result.metadata?.details?.chainTotalsUsd).toEqual({
      "1": 10700,
      "8453": 300,
    });
    expect(result.metadata?.details?.oldestMaterialPositionUpdatedAt).toBe(1785265103);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["makina-unknown-exposure"]);
  });

  it("reconciles allocations to current AUM when last reported AUM lags", () => {
    const strategy = structuredClone(STRATEGY_FIXTURE);
    strategy.data.lastReportedAum = "12000000000";

    const result = adaptMakinaStrategyReserves(strategy, ALLOCATIONS_FIXTURE, PARAMS);

    expect(result.metadata?.totalReserveUsd).toBe(11000);
    expect(result.metadata?.currentAumUsd).toBe(11000);
    expect(result.metadata?.reportedAumUsd).toBe(12000);
    expect(result.metadata?.lastReportedAumUsd).toBe(12000);
    expect(result.metadata?.details?.reconciliationAumUsd).toBe(11000);
    expect(result.metadata?.details?.lastReportedAumDiffPct).toBeCloseTo(8.333333333);
  });

  it("rejects allocation totals that do not reconcile to current AUM", () => {
    const strategy = structuredClone(STRATEGY_FIXTURE);
    strategy.data.aum = "12000000000";

    expect(() => adaptMakinaStrategyReserves(strategy, ALLOCATIONS_FIXTURE, PARAMS)).toThrow(
      /differs from current AUM/,
    );
  });

  it("passes shared adapter output validation", () => {
    const result = adaptMakinaStrategyReserves(STRATEGY_FIXTURE, ALLOCATIONS_FIXTURE, PARAMS);

    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("makina-strategy") ?? undefined }).valid)
      .toBe(true);
  });

  it("does not hide stale allocations behind a fresh strategy timestamp", () => {
    const strategy = structuredClone(STRATEGY_FIXTURE);
    const allocations = structuredClone(ALLOCATIONS_FIXTURE);
    strategy.meta.generated_at = "2026-07-29T09:28:20.429Z";
    allocations.meta.generated_at = "2026-07-19T09:28:20.429Z";

    const result = adaptMakinaStrategyReserves(strategy, allocations, PARAMS);
    const validation = validateAdapterOutput(result, {
      adapter: getReserveAdapter("makina-strategy") ?? undefined,
      now: Math.floor(Date.parse("2026-07-29T09:28:20.429Z") / 1000),
    });

    expect(result.metadata?.sourceTimestamp).toBe(
      Math.floor(Date.parse("2026-07-19T09:28:20.429Z") / 1000),
    );
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((warning) => warning.code)).toContain("stale-source-data");
  });

  it("publishes backlog-adjusted live queue capacity without score-bearing settlement delay", () => {
    const metadata = buildMakinaRedemptionMetadata(REDEMPTION_STATE);

    expect(metadata).toEqual({
      redemption: {
        capacityUsd: 0,
        capacityKind: "live-queue",
        freshnessKind: "same-run-onchain",
        blockNumber: 25_646_765,
        holderEligibility: "issuer-discretionary",
        queueDepthUsd: 3_104.889979,
        routeStatus: "open",
        routeStatusSource: "onchain",
        routeStatusReason:
          "AsyncRedeemer whitelist is enabled; Pharos models the route as issuer-discretionary access rather than impaired",
        sourceUrls: [
          "https://docs.makina.finance/concepts/architecture/machine/redemptions",
          `https://eth.blockscout.com/address/${ASYNC_REDEEMER}?tab=contract`,
          "https://eth.blockscout.com/address/0xd53dc14e0f268494c7540153126d78e4f54cc01c?tab=contract",
        ],
      },
      redemptionQueue: {
        nextRequestId: 344,
        lastFinalizedRequestId: 342,
        unfinalizedRequestSpan: 1,
        pendingRequestCount: 1,
        minimumFinalizationDelaySec: 43_200,
        minimumRedeemShares: 1,
        lockedShares: 3_000,
        grossIdleCapacityUsd: 120.722783,
        queueDepthUsd: 3_104.889979,
        reservedUnclaimedUsdc: 0.003679,
        usableCapacityFormula: "max(0, Machine idle Ethereum USDC - convertToAssets(DUSD locked in AsyncRedeemer))",
        capacityBasis: "live-proxy-buffer",
        implementationAddress: REVIEWED_IMPLEMENTATION,
        implementationRuntimeCodeHash: REVIEWED_IMPLEMENTATION_CODE_HASH,
      },
    });
    expect(metadata.redemption).not.toHaveProperty("settlementDelaySec");
  });

  it("keeps route telemetry valid with zero floored queue capacity and no fee", () => {
    const result = adaptMakinaStrategyReserves(STRATEGY_FIXTURE, ALLOCATIONS_FIXTURE, PARAMS, REDEMPTION_STATE);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      holderEligibility: "issuer-discretionary",
      routeStatus: "open",
      routeStatusSource: "onchain",
      queueDepthUsd: 3_104.889979,
    });
    expect(result.metadata?.redemptionQueue).toMatchObject({
      nextRequestId: 344,
      lastFinalizedRequestId: 342,
      unfinalizedRequestSpan: 1,
      minimumFinalizationDelaySec: 43_200,
      grossIdleCapacityUsd: 120.722783,
      queueDepthUsd: 3_104.889979,
    });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("makina-strategy") ?? undefined }).valid)
      .toBe(true);
  });

  it("uses the full idle Machine buffer when no DUSD shares are pending in the queue", () => {
    const metadata = buildMakinaRedemptionMetadata({
      ...REDEMPTION_STATE,
      nextRequestId: 345,
      lastFinalizedRequestId: 344,
      pendingRequestCount: 0,
      lockedShares: 0,
      grossIdleCapacityUsd: 700,
      queueDepthUsd: 0,
      capacityUsd: 700,
    });

    expect(metadata.redemption).toMatchObject({
      capacityUsd: 700,
      capacityKind: "live-queue",
      queueDepthUsd: 0,
      holderEligibility: "issuer-discretionary",
      routeStatus: "open",
    });
    expect(metadata.redemptionQueue).toMatchObject({
      pendingRequestCount: 0,
      lockedShares: 0,
      queueDepthUsd: 0,
      grossIdleCapacityUsd: 700,
    });
  });
});
