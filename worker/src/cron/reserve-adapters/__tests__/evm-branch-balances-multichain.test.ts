import { describe, it, expect } from "vitest";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { hasFatalWarnings } from "../validate";

const token = "0x1111111111111111111111111111111111111111";
const holder = "0x2222222222222222222222222222222222222222";
const underlying = "0x3333333333333333333333333333333333333333";
const usdcToken = "0x4444444444444444444444444444444444444444";
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const BALANCE_OF_SELECTOR = "0x70a08231";

const branch = (name: string, chain = "optimism", tokenAddress = token) => ({
  name, chain, holder, token: { chain, address: tokenAddress, decimals: 6 }, risk: "low", priceUsd: 1,
});

const config = (branches: unknown[]): LiveReservesConfig => ({
  adapter: "evm-branch-balances", version: 1, semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "optimism", rpcMode: "public-rpc" } }, params: { branches },
} as LiveReservesConfig);

async function run(
  branches: unknown[],
  network: AdapterNetworkSpec = {},
  options: { validate?: false } = {},
) {
  return runAdapter("evm-branch-balances", "jpyt-dephaser", {
    network: {
      // Both chains pin the same observation block in the harness anchor.
      block: { number: 100, timestamp: 1_800_000_000 },
      ...network,
    },
    config: config(branches),
    nowSec: 1_800_000_000,
    ...(options.validate === false ? { validate: false as const } : {}),
  });
}

describe("branch multichain and receipt observations", () => {
  it("aggregates holdings using each chain's pinned block", async () => {
    const { result, network } = await run([branch("USDT"), branch("USDC", "base")], {
      rpc: {
        // Same token address on both chains: per-chain wire answers.
        [`optimism:${token}:${BALANCE_OF_SELECTOR}`]: 75_000_000n,
        [`base:${token}:${BALANCE_OF_SELECTOR}`]: 25_000_000n,
        [`${token}:decimals()`]: 6n,
      },
    });

    expect(result.slices.map(({ name, pct }) => ({ name, pct }))).toEqual([{ name: "USDT", pct: 75 }, { name: "USDC", pct: 25 }]);
    expect(result.metadata?.details?.observedBlocks).toEqual([
      { chain: "optimism", number: 100, timestamp: 1_800_000_000 },
      { chain: "base", number: 100, timestamp: 1_800_000_000 },
    ]);
    // The base wave really ran against the base chain's endpoints.
    expect(network.rpcCalls.filter((call) => call.chain === "base" && call.viaMulticall).length).toBeGreaterThan(0);
  });

  it("converts aggregate cToken claims before pricing and retains the receipt decimals gate", async () => {
    const receipt = {
      ...branch("meUSDC"),
      token: { chain: "optimism", address: token, decimals: 8 },
      priceToken: { chain: "optimism", address: underlying },
      receipt: { kind: "compound-v2" },
      balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] },
    };

    const makeNetwork = (aggregateDecimals: bigint): AdapterNetworkSpec => ({
      rpc: {
        [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 100n * 10n ** 8n,
        [`${token}:decimals()`]: aggregateDecimals,
        [`${usdcToken}:decimals()`]: 6n,
        [`${usdcToken}:${BALANCE_OF_SELECTOR}`]: 2_327_425n,
        [`${token}:0x182df0f5`]: 232_742_590_670_167n,
        [`${token}:0x6f307dc3`]: BigInt(underlying),
        [`${underlying}:decimals()`]: 6n,
      },
    });

    const accepted = await run([receipt, branch("USDC", "optimism", usdcToken)], makeNetwork(8n), { validate: false });
    expect(accepted.result.slices.map(({ pct }) => pct)).toEqual([50, 50]);
    expect(hasFatalWarnings(accepted.result.warnings)).toBe(false);

    // Drift: the receipt token's on-chain decimals leave the configured 8.
    const rejected = await run([receipt, branch("USDC", "optimism", usdcToken)], makeNetwork(18n), { validate: false });
    expect(hasFatalWarnings(rejected.result.warnings)).toBe(true);
    expect(rejected.result.warnings).toContainEqual(expect.objectContaining({ code: "branch-token-decimals-mismatch" }));
  });

  it("keeps aggregate decimals checks on individual fallback and rejects receipt identity drift", async () => {
    // Multicall3 fails cleanly (routed null, no table miss): the adapter falls
    // back to per-branch individual reads.
    const makeNetwork = (withReceipt: boolean): AdapterNetworkSpec => ({
      multicall: false,
      rpc: {
        "0x82ad56cb": null,
        [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 1_000_000n,
        [`${token}:decimals()`]: 18n,
        [`${token}:0x182df0f5`]: 1_000_000n,
        [`${token}:0x6f307dc3`]: 1_000_000n,
        ...(withReceipt ? { [`${underlying}:decimals()`]: 6n } : {}),
      },
    });
    const aggregate = { ...branch("USDC"), balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] } };

    const drifted = await run([aggregate], makeNetwork(false), { validate: false });
    expect(hasFatalWarnings(drifted.result.warnings)).toBe(true);

    const withReceipt = { ...aggregate, receipt: { kind: "compound-v2" }, priceToken: { chain: "optimism", address: underlying } };
    await expect(run([withReceipt], makeNetwork(true))).rejects.toThrow("underlying identity");
  });

  it("scales 18-decimal underlying claims and rejects missing conversion rates", async () => {
    const receipt = {
      ...branch("mewETH"), token: { chain: "optimism", address: token, decimals: 8 },
      priceUsd: 2_000, priceToken: { chain: "optimism", address: underlying },
      receipt: { kind: "compound-v2", exchangeRateSelector: "0x12345678" },
    };
    let rate: bigint | null = 2n * 10n ** 26n;
    const network: AdapterNetworkSpec = {
      rpc: {
        [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 10n * 10n ** 8n,
        [`${token}:0x70a08231`]: 10n * 10n ** 8n,
        [`${usdcToken}:decimals()`]: 6n,
        [`${usdcToken}:${BALANCE_OF_SELECTOR}`]: 100_000_000n,
        [`${token}:0x12345678`]: () => rate,
        [`${token}:0x6f307dc3`]: BigInt(underlying),
        [`${underlying}:decimals()`]: 18n,
      },
    };

    const priced = await run([receipt, branch("USDC", "optimism", usdcToken)], network);
    expect(priced.result.slices.map(({ pct }) => pct)).toEqual([80, 20]);

    rate = null;
    const unpriced = run([receipt], network);
    await expect(unpriced).rejects.toThrow("exchange rate unavailable");
  });
});
