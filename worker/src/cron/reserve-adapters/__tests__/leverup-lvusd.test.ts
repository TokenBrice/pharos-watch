import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchLeverupLvusdReserves } from "../leverup-lvusd";
import { installAdapterNetwork, type AdapterRpcValue } from "./reserve-adapter.test-support";
import { leverupObservation as fixture } from "./fixtures/leverup-lvusd";

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

function observe(overrides: Record<string, AdapterRpcValue> = {}) {
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
            price: fixture.usdcPrice, timestamp: fixture.quoteTimestamp, confidence: 0.99,
          },
        },
      },
    },
  });
  return fetchLeverupLvusdReserves(coin, config, new AbortController().signal, { chainRpcs: network.chainRpcs });
}

afterEach(() => vi.restoreAllMocks());

describe("LeverUp LVUSD reserve census", () => {
  it("preserves the measured coverage deficit instead of treating USDC composition as solvency", async () => {
    const result = await observe();
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.6442697295182127, 10);
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
    await expect(observe({ [`${fixture.transparency}:getAllVaults()`]: expanded })).rejects.toThrow(/vault census/);
  });

  it("withholds composition when the designated reserve identity changes", async () => {
    await expect(observe({ [`${fixture.vault}:reserveToken()`]: "0x1111111111111111111111111111111111111111" })).rejects.toThrow(/identity/);
  });

  it("withholds the reserve/supply quotient when liability decimals change", async () => {
    await expect(observe({ [`${fixture.lvusd}:decimals()`]: 6n })).rejects.toThrow(/decimals/);
  });
});
