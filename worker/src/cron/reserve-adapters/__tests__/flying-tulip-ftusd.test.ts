import { describe, expect, it } from "vitest";
import { adaptFlyingTulipFtUsd } from "../flying-tulip-ftusd";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

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
    ],
  };
}

describe("adaptFlyingTulipFtUsd", () => {
  it("aggregates collateral across both chains and preserves issuer diagnostics", () => {
    const result = adaptFlyingTulipFtUsd(payload());
    expect(result.slices).toEqual([
      expect.objectContaining({ name: "USDC strategy wrappers (Ethereum and Sonic)", coinId: "usdc-circle", pct: 68.7 }),
      expect.objectContaining({ name: "USDT strategy wrapper (Ethereum)", coinId: "usdt-tether", pct: 31.1 }),
      expect.objectContaining({ name: "USSD strategy wrapper (Sonic)", coinId: "ussd-sonic-labs", pct: 0.2 }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1786310565,
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
    expect(validateAdapterOutput(result, { adapter, now: 1786311000 }).valid).toBe(true);
    expect(adapter?.evidenceClass).toBe("weak-live-probe");
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

  it("ignores an inactive zero-TVL, zero-supply chain placeholder", () => {
    const withPlaceholder = payload();
    withPlaceholder.chains.push({
      chainId: 56,
      chainName: "Binance Smart Chain",
      tvlUsd: 0,
      metrics: { totalSupplyUsd: 0 },
    } as (typeof withPlaceholder.chains)[number]);

    expect(adaptFlyingTulipFtUsd(withPlaceholder).metadata).toMatchObject({
      totalReserveUsd: expect.closeTo(4_686_811.9099, 0.0001),
      supplyUsd: 4_685_378.1711,
    });
  });

  it("fails closed when an unexpected chain is active", () => {
    const withActiveUnexpectedChain = payload();
    withActiveUnexpectedChain.chains.push({
      chainId: 56,
      chainName: "Binance Smart Chain",
      tvlUsd: 1,
      metrics: { totalSupplyUsd: 1 },
    } as (typeof withActiveUnexpectedChain.chains)[number]);

    expect(() => adaptFlyingTulipFtUsd(withActiveUnexpectedChain)).toThrow(
      "flying-tulip-ftusd expected 2 chains, received 3",
    );
  });
});
