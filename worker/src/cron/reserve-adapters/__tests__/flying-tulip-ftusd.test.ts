import { describe, expect, it } from "vitest";
import { adaptFlyingTulipFtUsd } from "../flying-tulip-ftusd";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_FDUSD = "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409";

function payload() {
  return {
    success: true,
    lastUpdated: "2026-08-09T21:22:45Z",
    chains: [
      {
        chainId: 1,
        chainName: "Ethereum",
        tvlUsd: 4_365_346.2765,
        metrics: { totalSupplyUsd: 4_364_617.4648 },
        collaterals: [
          { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tvlAmountUsd: 2_907_689.4549 },
          { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", tvlAmountUsd: 1_457_656.8216 },
        ],
        strategies: [{
          tokens: { deposit: "USDC", borrow: ["WETH"], staking: ["wstETH"] },
          leverage: { value: "1.042x" },
          healthFactor: { value: "31.53" },
          currentBorrows: { amountUsd: "$182,382.74" },
        }],
      },
      {
        chainId: 146,
        chainName: "Sonic",
        tvlUsd: 321_465.6334,
        metrics: { totalSupplyUsd: 320_760.7063 },
        collaterals: [
          { symbol: "USDC", address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", tvlAmountUsd: 313_539.0625 },
          { symbol: "USSD", address: "0x000000000eCcFf26B795F73fb0A70d48da657fEf", tvlAmountUsd: 7_926.5709 },
        ],
        strategies: [{
          tokens: { deposit: "USDC", borrow: ["wS"], staking: ["stS"] },
          leverage: { value: "1.568x" },
          healthFactor: { value: "4.33" },
          currentBorrows: { amountUsd: "$178,112.49" },
        }],
      },
      // Binance Smart Chain ships as an inactive placeholder (zero TVL/supply) ahead
      // of its launch; the reviewed chain set already includes it so it must not error.
      {
        chainId: 56,
        chainName: "Binance Smart Chain",
        tvlUsd: 0,
        metrics: { totalSupplyUsd: 0 },
        collaterals: [
          { symbol: "USDC", address: BSC_USDC, tvlAmountUsd: 0 },
          { symbol: "USDT", address: BSC_USDT, tvlAmountUsd: 0 },
          { symbol: "FDUSD", address: BSC_FDUSD, tvlAmountUsd: 0 },
        ],
      },
    ],
  };
}

describe("adaptFlyingTulipFtUsd", () => {
  it("aggregates collateral across both active chains and preserves issuer diagnostics", () => {
    const result = adaptFlyingTulipFtUsd(payload());
    expect(result.warnings).toEqual([]);
    expect(result.slices).toEqual([
      expect.objectContaining({ name: "USDC strategy wrappers (Ethereum and Sonic)", coinId: "usdc-circle", pct: 68.7 }),
      expect.objectContaining({ name: "USDT strategy wrapper (Ethereum)", coinId: "usdt-tether", pct: 31.1 }),
      expect.objectContaining({ name: "USSD strategy wrapper (Sonic)", coinId: "ussd-sonic-labs", pct: 0.2 }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1786310565,
      totalReserveUsd: expect.closeTo(4_686_811.9099, 4),
      unknownExposurePct: 0,
      details: {
        assurance: "first-party index of publicly verifiable on-chain reserve state",
        strategies: [
          expect.objectContaining({ chainName: "Ethereum", borrow: "WETH", stake: "wstETH", leverage: 1.042 }),
          expect.objectContaining({ chainName: "Sonic", borrow: "wS", stake: "stS", leverage: 1.568 }),
        ],
      },
    });
    const adapter = getReserveAdapter("flying-tulip-ftusd") ?? undefined;
    expectValidAdapterOutput("flying-tulip-ftusd", result, { now: 1786311000 });
    expect(adapter?.evidenceClass).toBe("weak-live-probe");
  });

  it("passes when all three reviewed chains are active and maps the FDUSD collateral", () => {
    const three = payload();
    three.chains[2] = {
      chainId: 56,
      chainName: "Binance Smart Chain",
      tvlUsd: 100_000,
      metrics: { totalSupplyUsd: 95_000 },
      collaterals: [
        { symbol: "USDC", address: BSC_USDC, tvlAmountUsd: 40_000 },
        { symbol: "USDT", address: BSC_USDT, tvlAmountUsd: 40_000 },
        { symbol: "FDUSD", address: BSC_FDUSD, tvlAmountUsd: 20_000 },
      ],
    } as (typeof three.chains)[number];

    const result = adaptFlyingTulipFtUsd(three);
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(4_786_811.9099, 4);
    expect(result.metadata?.supplyUsd).toBeCloseTo(4_780_378.1711, 4);
    expect(result.slices).toHaveLength(4);
    expect(result.slices).toContainEqual(
      expect.objectContaining({
        name: "FDUSD strategy wrapper (Binance Smart Chain)",
        coinId: "fdusd-first-digital",
        risk: "medium",
        depType: "collateral",
      }),
    );
    // USDC and USDT from BSC aggregate into the existing cross-chain symbol slices.
    expect(result.slices.find((s) => s.name === "USDC strategy wrappers (Ethereum and Sonic)")?.pct).toBeCloseTo(68.1, 1);
    expect(result.slices.find((s) => s.name === "FDUSD strategy wrapper (Binance Smart Chain)")?.pct).toBeCloseTo(0.4, 1);
    // No borrow/stake profile is reviewed for BSC yet, so only the two carry legs emit diagnostics.
    expect(result.metadata?.details).toMatchObject({
      strategies: [
        expect.objectContaining({ chainName: "Ethereum" }),
        expect.objectContaining({ chainName: "Sonic" }),
      ],
    });
  });

  it("fails when an expected chain is missing from the payload", () => {
    const missing = payload();
    missing.chains = missing.chains.filter((chain) => chain.chainId !== 56);
    expect(() => adaptFlyingTulipFtUsd(missing)).toThrow(
      "flying-tulip-ftusd missing expected Binance Smart Chain chain payload",
    );
  });

  it("fails closed when a reviewed collateral address changes", () => {
    const changed = payload();
    changed.chains[1].collaterals[1].address = "0x0000000000000000000000000000000000000001";
    expect(() => adaptFlyingTulipFtUsd(changed)).toThrow("Sonic USSD address changed or disappeared");
  });

  it("fails closed when a live borrow/stake leg disappears", () => {
    const changed = payload();
    changed.chains[0].strategies = [];
    expect(() => adaptFlyingTulipFtUsd(changed)).toThrow("Ethereum borrow/stake strategy disappeared");
  });

  it("ignores an inactive zero-TVL, zero-supply chain placeholder outside the reviewed set", () => {
    const baseline = adaptFlyingTulipFtUsd(payload());
    expect(baseline.metadata?.totalReserveUsd).toBeCloseTo(4_686_811.9099, 4);
    const withPlaceholder = payload();
    withPlaceholder.chains.push({
      chainId: 137,
      chainName: "Polygon",
      tvlUsd: 0,
      metrics: { totalSupplyUsd: 0 },
    } as (typeof withPlaceholder.chains)[number]);

    const result = adaptFlyingTulipFtUsd(withPlaceholder);
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: baseline.metadata?.totalReserveUsd,
      supplyUsd: 4_685_378.1711,
    });
  });

  it("degrades when an active chain outside the reviewed set appears", () => {
    const withActiveUnexpectedChain = payload();
    withActiveUnexpectedChain.chains.push({
      chainId: 137,
      chainName: "Polygon",
      tvlUsd: 1,
      metrics: { totalSupplyUsd: 1 },
    } as (typeof withActiveUnexpectedChain.chains)[number]);

    const result = adaptFlyingTulipFtUsd(withActiveUnexpectedChain);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "unexpected-chain",
        severity: "warning",
        effect: "degraded",
        message: expect.stringContaining("Polygon"),
      }),
    );
  });
});
