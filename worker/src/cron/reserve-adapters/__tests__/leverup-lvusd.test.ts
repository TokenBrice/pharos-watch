import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchLeverupLvusdReserves } from "../leverup-lvusd";
import { installAdapterNetwork, type AdapterRpcValue } from "./reserve-adapter.test-support";
import { leverupObservation as fixture, leverupOctoberObservation } from "./fixtures/leverup-lvusd";

const coin = {
  id: "lvusd-leverup",
  contracts: [{ chain: "monad", address: fixture.lvusd, decimals: 18 }],
} as StablecoinMeta;
const config: LiveReservesConfig = {
  adapter: "leverup-lvusd",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "monad", rpcMode: "public-rpc" } },
};

function observe(overrides: Record<string, AdapterRpcValue> = {}, price: number = fixture.usdcPrice) {
  vi.spyOn(Date, "now").mockReturnValue(fixture.block.timestamp * 1000);
  const network = installAdapterNetwork({
    block: fixture.block,
    chains: { monad: "https://rpc.monad.xyz" },
    rpc: {
      [`${fixture.lvusd}:owner()`]: fixture.issuer,
      [`${fixture.issuer}:transparency()`]: fixture.transparency,
      [`${fixture.transparency}:getAllVaults()`]: fixture.vaultList,
      [`${fixture.vault}:reserveToken()`]: fixture.reserveToken,
      [`${fixture.reserveToken}:decimals()`]: 6n,
      [`${fixture.lvusd}:decimals()`]: 18n,
      [`${fixture.lvusd}:totalSupply()`]: fixture.supplyRaw,
      [`${fixture.reserveToken}:balanceOf(address)`]: fixture.reserveRaw,
      ...overrides,
    },
    json: {
      [`https://coins.llama.fi/prices/current/monad:${fixture.reserveToken}`]: {
        coins: {
          [`monad:${fixture.reserveToken}`]: {
            price, timestamp: fixture.quoteTimestamp, confidence: 0.99,
          },
        },
      },
    },
  });
  return fetchLeverupLvusdReserves(coin, config, new AbortController().signal, { chainRpcs: network.chainRpcs });
}

afterEach(() => vi.restoreAllMocks());

describe("LeverUp LVUSD reserve census", () => {
  it.each([
    ["par sensitivity (not a captured quote)", 1, 0.6457391572550353],
    ["historical production market quote, timestamp unknown", leverupOctoberObservation.marketPriceUsd, 0.6455615789865033],
  ])("replays the six October wire observations with %s", async (_basis, price, ratio) => {
    const rpc: Record<string, AdapterRpcValue> = {
      // These scale gates are reviewed deployment identities; the six-state
      // capture does not pretend to include new decimals() observations.
      [`${fixture.reserveToken}:decimals()`]: 6n,
      [`${fixture.lvusd}:decimals()`]: 18n,
    };
    for (const read of leverupOctoberObservation.wire.result) {
      const call = read.params[0] as { to: string; data: string };
      rpc[`${call.to}:${call.data}`] = read.result;
    }
    vi.spyOn(Date, "now").mockReturnValue(leverupOctoberObservation.block.timestamp * 1000);
    const network = installAdapterNetwork({
      block: leverupOctoberObservation.block, rpc,
      chains: { monad: "https://rpc.monad.xyz" },
      json: {
        [`https://coins.llama.fi/prices/current/monad:${fixture.reserveToken}`]: {
          coins: { [`monad:${fixture.reserveToken}`]: { price } },
        },
      },
    });
    const result = await fetchLeverupLvusdReserves(coin, config, new AbortController().signal, { chainRpcs: network.chainRpcs });
    expect(network.unmatched).toEqual([]);
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").every((call) => call.block === "0x6a42f4b")).toBe(true);
    expect(result.metadata?.totalDebtUsd).toBe(1_411_392.227619);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(ratio, 10);
    expect(result.metadata?.details).toMatchObject({
      branchObservations: [expect.objectContaining({
        balanceRaw: "911391227619",
        priceObservation: { sourceKind: "market-api", sourceLookup: `monad:${fixture.reserveToken}`, quoteTimestamp: null, quoteConfidence: null },
      })],
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "undercollateralized", effect: "degraded" }));
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it.each([
    ["issuer", `${fixture.lvusd}:owner()`],
    ["transparency", `${fixture.issuer}:transparency()`],
  ])("rejects a changed %s identity", async (_label, key) => {
    await expect(observe({ [key]: "0x1111111111111111111111111111111111111111" })).rejects.toThrow(/identity/);
  });

  it("keeps failed reserve balances unavailable rather than treating them as zero", async () => {
    const result = await observe({ [`${fixture.reserveToken}:balanceOf(address)`]: null });
    expect(result.metadata?.valuationComplete).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it.each([
    ["exact par coverage", fixture.reserveRaw * 10n ** 12n, false],
    ["just below par coverage", fixture.reserveRaw * 10n ** 12n + 10n ** 12n, true],
  ])("retains strict undercoverage at %s", async (_label, supply, degraded) => {
    const result = await observe({ [`${fixture.lvusd}:totalSupply()`]: supply }, 1);
    expect(result.warnings?.some((warning) => warning.code === "undercollateralized") ?? false).toBe(degraded);
    if (degraded) expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    else expect(result.metadata?.collateralizationRatio).toBe(1);
  });

  it("preserves the measured coverage deficit instead of treating USDC composition as solvency", async () => {
    const result = await observe();
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.metadata?.censusComplete).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBe(0);
    // The measured ~$906k reserve covers ~64.427% of ~$1.406m liabilities;
    // do not pin floating-point quote digits beyond shared USD valuation precision.
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.64427, 5);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "undercollateralized", effect: "degraded" }));
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it.each([
    ["reverted", null],
    ["oversized", `0x${"00".repeat(33)}`],
    ["non-hex", "0xnot-a-uint256"],
  ] as const)("withholds composition when LVUSD totalSupply is %s", async (_label, supply) => {
    await expect(observe({ [`${fixture.lvusd}:totalSupply()`]: supply })).rejects.toThrow(/configured liability read/);
  });

  it("retains observed zero liabilities without claiming a coverage ratio", async () => {
    const result = await observe({ [`${fixture.lvusd}:totalSupply()`]: 0n });
    expect(result.metadata?.totalDebtUsd).toBe(0);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.warnings?.some((warning) => warning.code === "undercollateralized") ?? false).toBe(false);
  });

  it("withholds composition when the registry adds an unreviewed vault", async () => {
    const expanded = encodeAbiParameters([{ type: "address[]" }], [[fixture.vault, "0x1111111111111111111111111111111111111111"]]);
    await expect(observe({ [`${fixture.transparency}:getAllVaults()`]: expanded })).rejects.toThrow(/census/);
  });

  it("withholds composition when the designated reserve identity changes", async () => {
    await expect(observe({ [`${fixture.vault}:reserveToken()`]: "0x1111111111111111111111111111111111111111" })).rejects.toThrow(/identity/);
  });

  it("withholds the reserve/supply quotient when liability decimals change", async () => {
    await expect(observe({ [`${fixture.lvusd}:decimals()`]: 6n })).rejects.toThrow(/decimals/);
  });
});
