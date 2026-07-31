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
    expect(result.metadata?.shareSupply).toBeCloseTo(9661835.74879227);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(2.727272727);
    expect(result.metadata?.details?.chainTotalsUsd).toEqual({
      "1": 10700,
      "8453": 300,
    });
    expect(result.metadata?.details?.oldestMaterialPositionUpdatedAt).toBe(1785265103);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["makina-unknown-exposure"]);
  });

  it("rejects allocation totals that do not reconcile to reported AUM", () => {
    const strategy = structuredClone(STRATEGY_FIXTURE);
    strategy.data.lastReportedAum = "12000000000";

    expect(() => adaptMakinaStrategyReserves(strategy, ALLOCATIONS_FIXTURE, PARAMS)).toThrow(
      /differs from reported AUM/,
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
    expect(validation.valid).toBe(false);
    expect(validation.warnings.map((warning) => warning.code)).toContain("stale-source-data");
  });

  it("publishes current AsyncRedeemer access, delay, and queue-index telemetry", () => {
    expect(buildMakinaRedemptionMetadata({
      whitelistEnabled: true,
      finalizationDelaySec: 43_200,
      nextRequestId: 343,
      lastFinalizedRequestId: 342,
    })).toEqual({
      redemption: {
        freshnessKind: "same-run-onchain",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 43_200,
        routeStatus: "cohort-limited",
        routeStatusSource: "onchain",
        routeStatusReason:
          "AsyncRedeemer whitelist is enabled; requests and claims are limited to approved holders",
        sourceUrls: [
          "https://eth.blockscout.com/address/0x1303c26cfe06bac5bfee29907f37919643def75c?tab=contract",
        ],
      },
      redemptionQueue: {
        nextRequestId: 343,
        lastFinalizedRequestId: 342,
        unfinalizedRequestSpan: 0,
      },
    });
  });

  it("keeps queue telemetry valid without claiming executable capacity or fees", () => {
    const result = adaptMakinaStrategyReserves(STRATEGY_FIXTURE, ALLOCATIONS_FIXTURE, PARAMS, {
      whitelistEnabled: false,
      finalizationDelaySec: 43_200,
      nextRequestId: 350,
      lastFinalizedRequestId: 342,
    });

    expect(result.metadata?.redemption).toMatchObject({
      freshnessKind: "same-run-onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 43_200,
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
    expect(result.metadata?.redemptionQueue).toEqual({
      nextRequestId: 350,
      lastFinalizedRequestId: 342,
      unfinalizedRequestSpan: 7,
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("makina-strategy") ?? undefined }).valid)
      .toBe(true);
  });
});
