import { describe, expect, it } from "vitest";
import { adaptFlyingTulipFtUsd } from "../flying-tulip-ftusd";
import { getReserveAdapter } from "../index";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";
import dashboardCapture from "./fixtures/flying-tulip-ftusd-dashboard-2026-09-30.json";

type DashboardChain = NonNullable<Parameters<typeof adaptFlyingTulipFtUsd>[0]["chains"]>[number];
type DashboardCollateral = Required<NonNullable<DashboardChain["collaterals"]>[number]>;

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
      // BNB Smart Chain went live on 2026-09-24, renamed from "Binance Smart
      // Chain" in the same payload change, carrying a ~$94 pilot (production
      // snapshot 2026-09-25T20:10Z). FDUSD is a reviewed slot at zero capital.
      {
        chainId: 56,
        chainName: "BNB Smart Chain",
        tvlUsd: 94.22842593601962,
        metrics: { totalSupplyUsd: 94.222301 },
        collaterals: [
          { symbol: "USDC", address: BSC_USDC, tvlAmountUsd: 44.04782812867962 },
          { symbol: "USDT", address: BSC_USDT, tvlAmountUsd: 50.18059780734 },
          { symbol: "FDUSD", address: BSC_FDUSD, tvlAmountUsd: 0 },
        ],
        strategies: [{
          tokens: { deposit: "USDC", borrow: ["WBNB"], staking: ["asBNB"] },
          leverage: { value: "1.082x" },
          healthFactor: { value: "6.55" },
          currentBorrows: { amountUsd: "$7.75" },
        }],
      },
    ],
  };
}

describe("adaptFlyingTulipFtUsd", () => {
  it("aggregates collateral across all three active chains and preserves issuer diagnostics", () => {
    const result = adaptFlyingTulipFtUsd(payload());
    expect(result.warnings).toEqual([]);
    const total = 4_686_906.138325936;
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct)
      .toBeCloseTo((2_907_689.4549 + 313_539.0625 + 44.04782812867962) / total * 100, 10);
    expect(result.slices.find((slice) => slice.coinId === "usdt-tether")?.pct)
      .toBeCloseTo((1_457_656.8216 + 50.18059780734) / total * 100, 10);
    expect(result.slices.find((slice) => slice.coinId === "ussd-sonic-labs")?.pct)
      .toBeCloseTo(7_926.5709 / total * 100, 10);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1786310565,
      totalReserveUsd: expect.closeTo(4_686_906.1383, 4),
      supplyUsd: expect.closeTo(4_685_472.3934, 4),
      unknownExposurePct: 0,
      details: {
        assurance: "first-party index of publicly verifiable on-chain reserve state",
        strategies: [
          expect.objectContaining({ chainName: "Ethereum", borrow: "WETH", stake: "wstETH", leverage: 1.042 }),
          expect.objectContaining({ chainName: "Sonic", borrow: "wS", stake: "stS", leverage: 1.568 }),
          expect.objectContaining({ chainName: "BNB Smart Chain", borrow: "WBNB", stake: "asBNB", leverage: 1.082 }),
        ],
      },
    });
    const adapter = getReserveAdapter("flying-tulip-ftusd") ?? undefined;
    expectValidAdapterOutput("flying-tulip-ftusd", result, { now: 1786311000 });
    expect(adapter?.evidenceClass).toBe("weak-live-probe");
  });

  it("maps the FDUSD collateral once BNB Smart Chain carries FDUSD capital", () => {
    const three = payload();
    three.chains[2] = {
      chainId: 56,
      chainName: "BNB Smart Chain",
      tvlUsd: 100_000,
      metrics: { totalSupplyUsd: 95_000 },
      collaterals: [
        { symbol: "USDC", address: BSC_USDC, tvlAmountUsd: 40_000 },
        { symbol: "USDT", address: BSC_USDT, tvlAmountUsd: 40_000 },
        { symbol: "FDUSD", address: BSC_FDUSD, tvlAmountUsd: 20_000 },
      ],
      strategies: [{
        tokens: { deposit: "USDC", borrow: ["WBNB"], staking: ["asBNB"] },
        leverage: { value: "1.082x" },
        healthFactor: { value: "6.55" },
        currentBorrows: { amountUsd: "$7.75" },
      }],
    } as (typeof three.chains)[number];

    const result = adaptFlyingTulipFtUsd(three);
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(4_786_811.9099, 4);
    expect(result.metadata?.supplyUsd).toBeCloseTo(4_780_378.1711, 4);
    expect(result.slices).toHaveLength(4);
    expect(result.slices).toContainEqual(
      expect.objectContaining({
        name: "FDUSD strategy wrapper (BNB Smart Chain)",
        coinId: "fdusd-first-digital",
        risk: "medium",
        depType: "collateral",
      }),
    );
    // USDC and USDT from BNB Smart Chain aggregate into the cross-chain symbol slices.
    expect(result.slices.find((s) => s.coinId === "usdc-circle")?.pct)
      .toBeCloseTo((2_907_689.4549 + 313_539.0625 + 40_000) / 4_786_811.9099 * 100, 8);
    expect(result.slices.find((s) => s.coinId === "fdusd-first-digital")?.pct)
      .toBeCloseTo(20_000 / 4_786_811.9099 * 100, 8);
    expect(result.metadata?.details).toMatchObject({
      strategies: [
        expect.objectContaining({ chainName: "Ethereum" }),
        expect.objectContaining({ chainName: "Sonic" }),
        expect.objectContaining({ chainName: "BNB Smart Chain" }),
      ],
    });
  });

  it.each([1, 146, 56])("fails when reviewed chain %s is missing from the payload", (chainId) => {
    const missing = payload();
    missing.chains = missing.chains.filter((chain) => chain.chainId !== chainId);
    expect(() => adaptFlyingTulipFtUsd(missing)).toThrow();
  });

  describe.each([1, 146, 56])("reviewed chain %s census", (chainId) => {
    it.each([
      [false, false], [true, true], [false, true], [true, false],
    ])("rejects duplicates with inactive states %s / %s in either order", (firstInactive, secondInactive) => {
      const source = payload();
      const reviewed = source.chains.find((chain) => chain.chainId === chainId)!;
      const first: DashboardChain = firstInactive
        ? { chainId, chainName: reviewed.chainName, tvlUsd: 0, metrics: { totalSupplyUsd: 0 } }
        : reviewed;
      const second: DashboardChain = secondInactive
        ? { chainId, chainName: reviewed.chainName, tvlUsd: 0, metrics: { totalSupplyUsd: 0 } }
        : { ...reviewed };
      const otherChains = source.chains.filter((chain) => chain.chainId !== chainId);
      for (const duplicates of [[first, second], [second, first]]) {
        expect(() => adaptFlyingTulipFtUsd({
          ...source, chains: [...otherChains, ...duplicates],
        })).toThrow(/duplicate chain ID/);
      }
    });

    it.each([false, true])("allows a genuinely zero reviewed placeholder with collateral rows=%s", (withRows) => {
      const source = payload();
      const reviewed = source.chains.find((chain) => chain.chainId === chainId)!;
      const baseline = adaptFlyingTulipFtUsd(source);
      const result = adaptFlyingTulipFtUsd({
        ...source,
        chains: source.chains.map((chain) => chain.chainId === chainId
          ? {
            chainId, chainName: chain.chainName, tvlUsd: 0, metrics: { totalSupplyUsd: 0 },
            collaterals: withRows
              ? chain.collaterals.map((collateral) => ({ ...collateral, tvlAmountUsd: 0 }))
              : [],
          }
          : chain),
      });
      expect(result.warnings).toEqual([]);
      expect(result.metadata?.totalReserveUsd)
        .toBeCloseTo(baseline.metadata!.totalReserveUsd! - reviewed.tvlUsd, 8);
      expect(result.metadata?.supplyUsd)
        .toBeCloseTo(baseline.metadata!.supplyUsd! - reviewed.metrics.totalSupplyUsd, 8);
    });

    it("rejects positive collateral hidden behind zero headline metrics", () => {
      const source = payload();
      const reviewed = source.chains.find((chain) => chain.chainId === chainId)!;
      expect(() => adaptFlyingTulipFtUsd({
        ...source,
        chains: source.chains.map((chain) => chain.chainId === chainId
          ? { ...reviewed, tvlUsd: 0, metrics: { totalSupplyUsd: 0 } }
          : chain),
      })).toThrow();
    });

    it.each<DashboardChain>([
      { tvlUsd: 0 },
      { metrics: { totalSupplyUsd: 0 } },
      { tvlUsd: 0, metrics: { totalSupplyUsd: 0 }, collaterals: [{}] },
    ])("rejects unavailable reviewed placeholder quantities: %j", (placeholder) => {
      const source = payload();
      expect(() => adaptFlyingTulipFtUsd({
        ...source,
        chains: source.chains.map((chain) => chain.chainId === chainId
          ? { ...placeholder, chainId, chainName: chain.chainName }
          : chain),
      })).toThrow();
    });
  });

  it("produces the same measured result regardless of reviewed chain order", () => {
    const source = payload();
    expect(adaptFlyingTulipFtUsd({ ...source, chains: [...source.chains].reverse() }))
      .toEqual(adaptFlyingTulipFtUsd(source));
  });

  it.each([1, 146, 56])("does not join an undefined identity to reviewed chain %s", (chainId) => {
    const source = payload();
    expect(() => adaptFlyingTulipFtUsd({
      ...source,
      chains: source.chains.map((chain) => chain.chainId === chainId
        ? { ...chain, chainId: undefined }
        : chain),
    })).toThrow();
  });

  it("rejects duplicate unreviewed defined identities before dropping inactive rows", () => {
    const source = payload();
    const placeholder = { chainId: 137, tvlUsd: 0, metrics: { totalSupplyUsd: 0 } };
    expect(() => adaptFlyingTulipFtUsd({
      ...source, chains: [...source.chains, placeholder, { ...placeholder }],
    })).toThrow(/duplicate chain ID/);
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

  it("fails closed when the BNB Smart Chain carry leg disappears", () => {
    const changed = payload();
    changed.chains[2].strategies = [];
    expect(() => adaptFlyingTulipFtUsd(changed)).toThrow("BNB Smart Chain borrow/stake strategy disappeared");
  });

  it("drops a zero-capital reviewed collateral slot instead of fabricating exposure", () => {
    const result = adaptFlyingTulipFtUsd(payload());
    expect(result.warnings).toEqual([]);
    expect(result.slices.some((slice) => slice.coinId === "fdusd-first-digital")).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("fails closed when a reviewed collateral publishes a negative amount", () => {
    const changed = payload();
    changed.chains[2].collaterals[2].tvlAmountUsd = -1;
    expect(() => adaptFlyingTulipFtUsd(changed)).toThrow(/FDUSD tvlAmountUsd/);
  });

  it("ignores an inactive zero-TVL, zero-supply chain placeholder outside the reviewed set", () => {
    const baseline = adaptFlyingTulipFtUsd(payload());
    expect(baseline.metadata?.totalReserveUsd).toBeCloseTo(4_686_906.1383, 4);
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
      supplyUsd: 4_685_472.393401,
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

  it.each<DashboardChain>([
    { chainId: 137, tvlUsd: 0 },
    { chainId: 137, metrics: { totalSupplyUsd: 0 } },
    { chainId: 137, tvlUsd: 0, metrics: { totalSupplyUsd: 0 }, collaterals: [{ tvlAmountUsd: 1 }] },
    { chainId: 137, tvlUsd: 0, metrics: { totalSupplyUsd: 0 }, collaterals: [{}] },
    { tvlUsd: 1, metrics: { totalSupplyUsd: 1 } },
  ])("does not call unavailable or contradictory unreviewed quantities inactive: %j", (chain) => {
    const source = payload();
    const result = adaptFlyingTulipFtUsd({ ...source, chains: [...source.chains, chain] });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "unexpected-chain", effect: "degraded",
    }));
  });

  it("replays the current dashboard with new reviewed tokens and omitted zero FDUSD", () => {
    const result = adaptFlyingTulipFtUsd(dashboardCapture);
    expectValidAdapterOutput("flying-tulip-ftusd", result, {
      now: Date.parse(dashboardCapture.lastUpdated) / 1000,
    });
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.unknownExposurePct).toBe(0);
    const total = dashboardCapture.chains.reduce((sum, chain) => sum + chain.tvlUsd, 0);
    for (const [symbol, coinId] of [
      ["USDC", "usdc-circle"], ["USDT", "usdt-tether"],
      ["USSD", "ussd-sonic-labs"], ["USDe", "usde-ethena"],
    ]) {
      const value = dashboardCapture.chains.flatMap<DashboardCollateral>((chain) => chain.collaterals)
        .filter((row) => row.symbol === symbol).reduce((sum, row) => sum + row.tvlAmountUsd, 0);
      expect(result.slices.find((slice) => slice.coinId === coinId)).toMatchObject({
        sourceKey: `flying-tulip-ftusd:collateral:${symbol.toLowerCase()}`,
        depType: "collateral",
        pct: expect.closeTo(value / total * 100, 10),
      });
    }
    expect(result.slices.some((slice) => ["crvusd-curve", "usdg-paxos", "fdusd-first-digital"].includes(slice.coinId ?? ""))).toBe(false);
  });

  it("ignores new zero-capital rows without requiring the old zero slots", () => {
    const changed = payload();
    changed.chains[2].collaterals = changed.chains[2].collaterals.filter((row) => row.symbol !== "FDUSD");
    changed.chains[0].collaterals.push({
      symbol: "NEW", address: "0x0000000000000000000000000000000000000001", tvlAmountUsd: 0,
    });
    expect(adaptFlyingTulipFtUsd(changed).slices).toEqual(adaptFlyingTulipFtUsd(payload()).slices);
  });

  it("retains unknown positive collateral in the denominator without a dependency link", () => {
    const changed = payload();
    changed.chains[0].collaterals.push({
      symbol: "NEW", address: "0x0000000000000000000000000000000000000001", tvlAmountUsd: 1_000,
    });
    changed.chains[0].tvlUsd += 1_000;
    const result = adaptFlyingTulipFtUsd(changed);
    const unknown = result.slices.find((slice) => slice.sourceKey?.includes(":unreviewed:"));
    expect(unknown?.coinId).toBeUndefined();
    expect(unknown?.depType).toBeUndefined();
    expect(unknown?.risk).toBe("high");
    expect(unknown?.pct).toBeCloseTo(1_000 / 4_687_906.138325936 * 100, 10);
    expect(result.metadata?.unknownExposurePct).toBe(unknown?.pct);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "flying-tulip-ftusd-unreviewed-collateral", effect: "info",
    }));
  });

  it.each([
    ["crvUSD", "crvusd-curve"],
    ["USDG", "usdg-paxos"],
  ])("links reviewed %s capital even when its positive share is below six-decimal rounding", (symbol, coinId) => {
    const changed = structuredClone(dashboardCapture);
    const row = changed.chains[0].collaterals.find((collateral) => collateral.symbol === symbol)!;
    row.tvlAmountUsd = 0.000001;
    changed.chains[0].tvlUsd += row.tvlAmountUsd;
    const result = adaptFlyingTulipFtUsd(changed);
    const slice = result.slices.find((candidate) => candidate.coinId === coinId);
    expect(slice).toMatchObject({
      sourceKey: `flying-tulip-ftusd:collateral:${symbol.toLowerCase()}`,
      depType: "collateral",
    });
    expect(slice?.pct).toBeGreaterThan(0);
    expect(slice?.pct).toBeLessThan(0.000001);
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("rejects duplicate collateral rows rather than counting the same claim twice", () => {
    const changed = payload();
    changed.chains[0].collaterals.push({ ...changed.chains[0].collaterals[0] });
    expect(() => adaptFlyingTulipFtUsd(changed)).toThrow("duplicate collateral address");
  });
});

describe("flying-tulip-ftusd fetch boundary", () => {
  it("fetches the configured dashboard through the shared network harness", async () => {
    const endpoint = "https://api.flyingtulip.com/status/ftusd/dashboard?days=30&include_series=false&include_events=false";
    const { result, network } = await runAdapter("flying-tulip-ftusd", "ftusd-flying-tulip", {
      network: { json: { [endpoint]: payload() } },
      nowSec: 1_786_311_000,
    });

    expect(network.requests.map((request) => request.url)).toEqual([endpoint]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1_786_310_565,
    });
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "USDC strategy wrappers (Ethereum, Sonic, and BNB Smart Chain)",
      coinId: "usdc-circle",
    }));
  });
});
