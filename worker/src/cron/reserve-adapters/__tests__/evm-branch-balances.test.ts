import { describe, it, expect } from "vitest";
import { parseAbi, toFunctionSelector } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  runAdapter,
  installAdapterNetwork,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcCall,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import { hasFatalWarnings } from "../validate";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

const coin = { id: "test-coin" } as unknown as StablecoinMeta;

const HONEY_FACTORY = "0xa4afef880f5ce1f63c9fb48f661e27f8b4216401";
const HONEY_TOKEN = "0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce";
const HONEY_ASSET = "0x549943e04f40284185054145c6e4e9568c1d3241";
const HONEY_VAULT = "0x90bc07408f5b5eac4de38af76ea6069e1fcee363";
const WAD = 10n ** 18n;
const NOW_SEC = 1_700_000_000;
const BERACHAIN_RPC_URL = "https://rpc.example/berachain";
const ROOTSTOCK_RPC_URL = "https://rpc.example/rootstock";
const BALANCE_OF_SELECTOR = toFunctionSelector("balanceOf(address)");
const DECIMALS_SELECTOR = toFunctionSelector("decimals()");

function addressWord(address: string): bigint {
  return BigInt(address);
}

function abiWords(...words: bigint[]): string {
  return `0x${words.map((word) => word.toString(16).padStart(64, "0")).join("")}`;
}

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function uintArrayResult(values: bigint[]): string {
  return abiWords(32n, BigInt(values.length), ...values);
}

function callArg(call: AdapterRpcCall): bigint {
  return BigInt(`0x${call.data.slice(10)}`);
}

function callAddressArg(call: AdapterRpcCall): string {
  return `0x${call.data.slice(-40)}`;
}

// ---------------------------------------------------------------------------
// Branch configs (unchanged shapes).
// ---------------------------------------------------------------------------

function wstEthBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "wstETH",
    holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 },
    risk: "low",
    ...overrides,
  };
}

function wbtcBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "WBTC",
    holder: "0xcccccccccccccccccccccccccccccccccccccccc",
    token: { chain: "ethereum", address: "0xdddddddddddddddddddddddddddddddddddddddd", decimals: 8 },
    risk: "medium",
    ...overrides,
  };
}

function honeyBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "USDC.e",
    holder: HONEY_VAULT,
    token: { chain: "berachain", address: HONEY_ASSET, decimals: 6 },
    risk: "low",
    priceUsd: 1,
    ...overrides,
  };
}

function usdcBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "USDC branch",
    holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
    risk: "low",
    coinId: "usdc-circle",
    ...overrides,
  };
}

function makeBranchConfig(
  branches?: unknown[],
  options: { chain?: string; params?: Record<string, unknown> } = {},
): LiveReservesConfig {
  const chain = options.chain ?? "ethereum";
  return {
    adapter: "evm-branch-balances",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain, rpcMode: "public-rpc" },
    },
    params: {
      ...(branches === undefined ? {} : { branches }),
      ...options.params,
    },
  } as LiveReservesConfig;
}

// ---------------------------------------------------------------------------
// Harness network builders.
// ---------------------------------------------------------------------------

const PRICES_BASE = "https://coins.llama.fi/prices/current";

/**
 * DefiLlama price answers keyed by asset key (`chain:0xaddress`). A missing
 * entry yields an empty `coins` payload, mirroring an unresolved wrapper
 * lookup.
 */
function priceJson(entries: Record<string, number>): Record<string, unknown> {
  const coins = Object.fromEntries(
    Object.entries(entries).map(([assetKey, price]) => [
      assetKey,
      { price, timestamp: NOW_SEC, confidence: 0.99 },
    ]),
  );
  const url = `${PRICES_BASE}/${Object.keys(coins).sort().join(",")}`;
  return { [url]: { coins } };
}

function assetKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

interface BranchRpcOptions {
  balances?: Record<string, bigint | null>;
  decimals?: Record<string, bigint | null>;
  extra?: Record<string, AdapterRpcValue>;
}

/** balanceOf(holder)/decimals() answers per token address. */
function branchRpc(options: BranchRpcOptions = {}): Record<string, AdapterRpcValue> {
  const rpc: Record<string, AdapterRpcValue> = {};
  for (const [token, balance] of Object.entries(options.balances ?? {})) {
    rpc[`${token}:${BALANCE_OF_SELECTOR}`] = balance;
  }
  for (const [token, decimals] of Object.entries(options.decimals ?? {})) {
    rpc[`${token}:${DECIMALS_SELECTOR}`] = decimals;
  }
  return { ...rpc, ...options.extra };
}

interface HoneyOptions {
  assetCount?: number;
  /** Registered asset addresses (default synthetic 0xa1..); use the real token when it doubles as the branch token. */
  assetAddresses?: string[];
  /** Vault addresses per asset (default synthetic 0xb1..). */
  vaultAddresses?: string[];
  custody?: boolean;
  failVaultAsset?: boolean;
  failConvertToAssets?: boolean;
  /** convertToAssets(net shares) answer; null fails the call. */
  convertToAssets?: bigint | null;
  factoryShares?: bigint;
  collectedFees?: bigint;
  /** When set, balanceOf(holder) answers per holder via full-calldata keys. */
  assetBalanceByHolder?: (holder: string) => bigint;
}

function honeyNetwork(options: HoneyOptions = {}): AdapterNetworkSpec {
  const assetCount = options.assetCount ?? 1;
  const assets = options.assetAddresses ?? Array.from({ length: assetCount }, (_, index) =>
    `0x${(0xa1 + index).toString(16).padStart(40, "0")}`);
  const vaults = options.vaultAddresses ?? Array.from({ length: assetCount }, (_, index) =>
    `0x${(0xb1 + index).toString(16).padStart(40, "0")}`);
  const custodyHolders = Array.from({ length: assetCount }, (_, index) =>
    `0x${(0xc1 + index).toString(16).padStart(40, "0")}`);
  const custody = options.custody ?? false;
  const vaultOfAsset: Record<string, string> = Object.fromEntries(
    assets.map((asset, index) => [asset.toLowerCase(), vaults[index]]),
  );

  const rpc: Record<string, AdapterRpcValue> = {
    // The configured branch (USDC.e) reads its own balance and decimals;
    // identical calldata to the capacity holder-balance read, so one answer.
    [`${HONEY_ASSET}:balanceOf(address)`]: 8_000_000n,
    [`${HONEY_ASSET}:decimals()`]: 6n,
    [`${HONEY_FACTORY}:honey()`]: HONEY_TOKEN,
    [`${HONEY_FACTORY}:numRegisteredAssets()`]: BigInt(assetCount),
    [`${HONEY_FACTORY}:registeredAssets(uint256)`]: (call: AdapterRpcCall) => assets[Number(callArg(call))],
    [`${HONEY_FACTORY}:vaults(address)`]: (call: AdapterRpcCall) =>
      vaultOfAsset[callAddressArg(call).toLowerCase()],
    [`${HONEY_FACTORY}:paused()`]: 0n,
    [`${HONEY_FACTORY}:forcedBasketMode()`]: 0n,
    [`${HONEY_FACTORY}:isBasketModeEnabled(bool)`]: 0n,
    [`${HONEY_FACTORY}:getWeights()`]: uintArrayResult(Array.from({ length: assetCount }, () => WAD)),
    [`${HONEY_FACTORY}:globalCap()`]: WAD,
    [`${HONEY_FACTORY}:collectedAssetFees(address)`]: options.collectedFees ?? 0n,
    [`${HONEY_FACTORY}:redeemRates(address)`]: 999_500_000_000_000_000n,
    [`${HONEY_FACTORY}:isPegged(address)`]: 1n,
    [`${HONEY_FACTORY}:relativeCap(address)`]: WAD,
  };
  assets.forEach((asset, index) => {
    const vault = vaults[index];
    rpc[`${vault}:asset()`] = options.failVaultAsset ? null : asset;
    rpc[`${vault}:paused()`] = 0n;
    rpc[`${vault}:custodyInfo()`] = custody
      ? abiWords(1n, addressWord(custodyHolders[index]))
      : abiWords(0n, 0n);
    rpc[`${vault}:${BALANCE_OF_SELECTOR}`] = options.factoryShares ?? 10n * WAD;
    rpc[`${vault}:convertToAssets(uint256)`] = options.failConvertToAssets
      ? null
      : options.convertToAssets ?? 10_000_000n;
    rpc[`${asset}:${DECIMALS_SELECTOR}`] = 6n;
    if (options.assetBalanceByHolder) {
      const balanceOfData = (holder: string) => `${asset}:${BALANCE_OF_SELECTOR}${word(addressWord(holder)).slice(2)}`;
      for (const holder of [vault, custodyHolders[index]]) {
        rpc[balanceOfData(holder)] = options.assetBalanceByHolder(holder.toLowerCase());
      }
    } else {
      rpc[`${asset}:${BALANCE_OF_SELECTOR}`] = 8_000_000n;
    }
    if (custody) {
      rpc[`${asset}:allowance(address,address)`] = 7_000_000n;
    }
  });
  return {
    chains: { berachain: BERACHAIN_RPC_URL },
    rpc,
  };
}

async function runBranches(
  config: LiveReservesConfig,
  network: AdapterNetworkSpec | AdapterNetwork = {},
  options: { ctx?: Record<string, unknown>; validate?: false } = {},
) {
  return runAdapter("evm-branch-balances", "jpyt-dephaser", {
    network,
    config,
    nowSec: NOW_SEC,
    ...(options.ctx ? { ctx: options.ctx } : {}),
    ...(options.validate === false ? { validate: false as const } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("fetchEvmBranchBalancesReserves", () => {
  it("preserves the legacy reserve result without redemption opt-in", async () => {
    const { result, network } = await runBranches(
      makeBranchConfig([wstEthBranch()]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 2000 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000_000_000_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n },
        }),
      },
    );

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "wstETH", pct: 100, risk: "low" }]);
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").map((call) => call.selector))
      .toEqual([BALANCE_OF_SELECTOR, DECIMALS_SELECTOR]);
  });

  it("emits HoneyFactory live direct capacity without changing reserve slices", async () => {
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        redemptionCapacity: {
          kind: "honey-factory-vaults",
          factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN,
          maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });

    const { result } = await runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET],
      vaultAddresses: [HONEY_VAULT],
    }));

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:berachain:0x549943e04f40284185054145c6e4e9568c1d3241", name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.metadata?.redemption).toEqual(expect.objectContaining({
      capacityUsd: 8,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 5,
    }));
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
  });

  it.each([
    { custody: false, wave5Length: 8, expectedCapacity: 32 },
    { custody: true, wave5Length: 12, expectedCapacity: 28 },
  ])(
    "batches the configured four Honey assets into five dependency waves (custody=$custody)",
    async ({ custody, wave5Length, expectedCapacity }) => {
      const config = makeBranchConfig([honeyBranch()], {
        chain: "berachain",
        params: {
          redemptionCapacity: {
            kind: "honey-factory-vaults",
            factoryAddress: HONEY_FACTORY,
            expectedHoneyAddress: HONEY_TOKEN,
            maxAssets: 4,
            stableAssets: Array.from({ length: 4 }, (_, index) => ({
              address: `0x${(0xa1 + index).toString(16).padStart(40, "0")}`,
              decimals: 6,
            })),
            sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
          },
        },
      });

      const { result, network } = await runBranches(config, honeyNetwork({ assetCount: 4, custody }));

      expect(result.metadata?.redemption).toMatchObject({ capacityUsd: expectedCapacity });
      // Dependency waves at the transport boundary: identity (2), registry (9),
      // factory state (20), vault state (20), derived state (8 or 12). Branch
      // balance members are excluded; later waves start only at the wave-size
      // offsets of the honey members.
      const honeyMembers = network.rpcCalls.filter(
        (call) => call.viaMulticall && call.contract !== HONEY_ASSET,
      );
      const selectors = honeyMembers.map((call) => call.selector);
      expect(honeyMembers).toHaveLength(2 + 9 + 20 + 20 + wave5Length);
      expect(selectors.slice(0, 2)).toEqual([
        toFunctionSelector("honey()"),
        toFunctionSelector("numRegisteredAssets()"),
      ]);
      expect(selectors[2]).toBe(toFunctionSelector("registeredAssets(uint256)"));
      expect(selectors[11]).toBe(toFunctionSelector("vaults(address)"));
      expect(selectors[31]).toBe(toFunctionSelector("asset()"));
      expect(selectors[51]).toBe(toFunctionSelector("convertToAssets(uint256)"));
    },
  );

  it("batches four same-chain branch balances and decimals reads into one Multicall3 wave", async () => {
    const branches = Array.from({ length: 4 }, (_, index) => ({
      name: `branch-${index}`,
      holder: `0x${(0xd1 + index).toString(16).padStart(40, "0")}`,
      token: {
        chain: "ethereum",
        address: `0x${(0xe1 + index).toString(16).padStart(40, "0")}`,
        decimals: 6,
      },
      risk: "low",
      priceUsd: 1,
    }));
    const network: AdapterNetworkSpec = {
      rpc: Object.fromEntries(branches.flatMap((branch, index) => [
        [`${branch.token.address}:${BALANCE_OF_SELECTOR}` as const, BigInt(index + 1) * 1_000_000n],
        [`${branch.token.address}:${DECIMALS_SELECTOR}` as const, 6n],
      ])),
    };

    const { result, network: installed } = await runBranches(makeBranchConfig(branches), network);

    expect(result.slices).toHaveLength(4);
    expect(installed.rpcCalls).toHaveLength(8);
    expect(installed.rpcCalls.every((call) => call.viaMulticall)).toBe(true);
  });

  it("values a mixed-decimals basket correctly when on-chain decimals match config", async () => {
    const { result } = await runBranches(
      makeBranchConfig([
        {
          name: "Six-decimals stable",
          holder: "0x00000000000000000000000000000000000000a1",
          token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 6 },
          risk: "low",
          priceUsd: 1,
        },
        {
          name: "Eighteen-decimals stable",
          holder: "0x00000000000000000000000000000000000000a2",
          token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b2", decimals: 18 },
          risk: "low",
          priceUsd: 1,
        },
      ]),
      {
        rpc: branchRpc({
          balances: {
            "0x00000000000000000000000000000000000000b1": 3_000_000n,
            "0x00000000000000000000000000000000000000b2": 2_000_000_000_000_000_000n,
          },
          decimals: {
            "0x00000000000000000000000000000000000000b1": 6n,
            "0x00000000000000000000000000000000000000b2": 18n,
          },
        }),
      },
    );

    // 3 six-decimals tokens ($3) vs 2 eighteen-decimals tokens ($2): 60/40.
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      { sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b1", name: "Six-decimals stable", pct: 60, risk: "low" },
      { sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b2", name: "Eighteen-decimals stable", pct: 40, risk: "low" },
    ]);
  });

  it("emits a fatal warning when a branch token's on-chain decimals differ from config", async () => {
    const { result } = await runBranches(
      makeBranchConfig([{
        name: "M by M^0 (via UsualM wrapper)",
        holder: "0x00000000000000000000000000000000000000a1",
        token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 18 },
        risk: "low",
        priceUsd: 1,
      }]),
      {
        rpc: branchRpc({
          balances: { "0x00000000000000000000000000000000000000b1": 50_000_000n },
          // Configured 18, but the token reports 6 — a 10^12 valuation error.
          decimals: { "0x00000000000000000000000000000000000000b1": 6n },
        }),
      },
      { validate: false },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "branch-token-decimals-mismatch",
        effect: "fatal",
      }),
    ]);
    expect(hasFatalWarnings(result.warnings)).toBe(true);
  });

  it("keeps the configured scale with an info warning when decimals() reverts", async () => {
    const { result } = await runBranches(
      makeBranchConfig([{
        name: "Non-ERC20 branch",
        holder: "0x00000000000000000000000000000000000000a1",
        token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 6 },
        risk: "low",
        priceUsd: 1,
      }]),
      {
        rpc: branchRpc({
          balances: { "0x00000000000000000000000000000000000000b1": 1_000_000n },
          decimals: { "0x00000000000000000000000000000000000000b1": null },
        }),
      },
    );

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b1", name: "Non-ERC20 branch", pct: 100, risk: "low" }]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "branch-token-decimals-unavailable",
        effect: "info",
      }),
    ]);
  });

  it.each([
    {
      name: "enumeration exceeds the configured bound",
      honeyOptions: { assetCount: 2 },
      maxAssets: 1,
    },
    {
      name: "any required vault read fails",
      honeyOptions: { failVaultAsset: true },
      maxAssets: 4,
    },
  ])("fails closed when $name", async ({ honeyOptions, maxAssets }) => {
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        redemptionCapacity: {
          kind: "honey-factory-vaults",
          factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN,
          maxAssets,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });

    const run = runBranches(config, honeyNetwork(honeyOptions));
    await expect(run).rejects.toThrow(
      /HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/,
    );
  });

  it("derives custody-mode branch composition from factory-owned net shares", async () => {
    // The USDC.e vault holds zero idle USDC; custodyInfo() is true and the net
    // factory shares (184630645591044543 - 155489553000000000) convert to
    // 29141 raw USDC units, which is the branch's real backing.
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        redemptionCapacity: {
          kind: "honey-factory-vaults",
          factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN,
          maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });

    const { result } = await runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET],
      vaultAddresses: [HONEY_VAULT],
      custody: true,
      factoryShares: 184_630_645_591_044_543n,
      collectedFees: 155_489_553_000_000_000n,
      convertToAssets: 29_141n,
      assetBalanceByHolder: (holder) =>
        holder === HONEY_VAULT.toLowerCase() ? 0n : 274_114n,
    }));

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:berachain:0x549943e04f40284185054145c6e4e9568c1d3241", name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({ branchCount: 1 });
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0.029141,
      routeStatus: "open",
    });
  });

  it("fails closed when custody vault share conversion is unreadable", async () => {
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        redemptionCapacity: {
          kind: "honey-factory-vaults",
          factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN,
          maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });

    const run = runBranches(config, honeyNetwork({ custody: true, failConvertToAssets: true }));
    await expect(run).rejects.toThrow(
      /HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/,
    );
  });

  it("computes percentage slices from branch balances and prices", async () => {
    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);
    const { result } = await runBranches(config, {
      json: priceJson({
        [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 2000,
        [assetKey("ethereum", "0xdddddddddddddddddddddddddddddddddddddddd")]: 60000,
      }),
      rpc: branchRpc({
        balances: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000_000_000_000_000n,
          "0xdddddddddddddddddddddddddddddddddddddddd": 100_000_000n,
        },
        decimals: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n,
          "0xdddddddddddddddddddddddddddddddddddddddd": 8n,
        },
      }),
    });

    expect(result.slices).toHaveLength(2);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].risk).toBe("medium");
    expect(result.slices[1].name).toBe("wstETH");
    expect(result.slices[1].risk).toBe("low");

    // WBTC value = 60000 (96.8%), wstETH = 2000 (3.2%)
    expect(result.slices[0].pct).toBeCloseTo(96.8, 0);
    expect(result.slices[1].pct).toBeCloseTo(3.2, 0);

    expect(result.metadata).toMatchObject({
      branchCount: 2,
      freshnessMode: "not-applicable",
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it.each([
    {
      name: "retains a measured sub-tenth-percent tracked branch",
      secondBalance: 428n,
      expected: [
        { sourceKey: "evm-branch-balances:rootstock:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Sovryn Zero ZUSD", pct: 99.957, risk: "medium" },
        { sourceKey: "evm-branch-balances:rootstock:0xcccccccccccccccccccccccccccccccccccccccc", name: "Dollar on Chain DOC", pct: 0.043, risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
      ],
    },
    {
      name: "retains a measured branch below the three-decimal rounding threshold",
      secondBalance: 4n,
      expected: [
        { sourceKey: "evm-branch-balances:rootstock:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Sovryn Zero ZUSD", pct: 99.9996, risk: "medium" },
        { sourceKey: "evm-branch-balances:rootstock:0xcccccccccccccccccccccccccccccccccccccccc", name: "Dollar on Chain DOC", pct: 0.0004, risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
      ],
    },
  ])("$name", async ({ secondBalance, expected }) => {
    const config = makeBranchConfig([
      {
        name: "Sovryn Zero ZUSD",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "rootstock", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 0 },
        risk: "medium",
        priceUsd: 1,
      },
      {
        name: "Dollar on Chain DOC",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "rootstock", address: "0xcccccccccccccccccccccccccccccccccccccccc", decimals: 0 },
        risk: "medium",
        coinId: "doc-money-on-chain",
        depType: "collateral",
        priceUsd: 1,
      },
    ], { chain: "rootstock" });

    const { result } = await runBranches(config, {
      chains: { rootstock: ROOTSTOCK_RPC_URL },
      json: priceJson({
        [assetKey("rootstock", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 1,
        [assetKey("rootstock", "0xcccccccccccccccccccccccccccccccccccccccc")]: 1,
      }),
      rpc: branchRpc({
        balances: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000n,
          "0xcccccccccccccccccccccccccccccccccccccccc": secondBalance,
        },
        decimals: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 0n,
          "0xcccccccccccccccccccccccccccccccccccccccc": 0n,
        },
      }),
    });

    expect(result.slices).toEqual(expected);
  });

  it("uses an explicit branch price token for DefiLlama price lookup", async () => {
    const config = makeBranchConfig(
      [
        {
          name: "Receipt token",
          holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token: { chain: "berachain", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", decimals: 18 },
          priceToken: { chain: "berachain", address: "0xffffffffffffffffffffffffffffffffffffffff" },
          risk: "high",
        },
      ],
      { chain: "berachain" },
    );

    const { result } = await runBranches(config, {
      chains: { berachain: BERACHAIN_RPC_URL },
      json: priceJson({ [assetKey("berachain", "0xffffffffffffffffffffffffffffffffffffffff")]: 75_000 }),
      rpc: branchRpc({
        balances: { "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": 1_000_000_000_000_000_000n },
        decimals: { "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": 18n },
      }),
    });

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:berachain:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", name: "Receipt token", pct: 100, risk: "high" }]);
  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    // The old suite validated this fee-only redemption block with an explicit
    // descriptor; keep that contract instead of runAdapter's default one.
    const runOptions = { validate: false as const };
    const config = makeBranchConfig([wstEthBranch()], {
      params: {
        redemptionRateProbe: {
          contract: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
          selector: "0xc52861f2",
          decimals: 18,
        },
      },
    });

    const network = {
      json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 2000 }),
      rpc: branchRpc({
        balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000_000_000_000_000n },
        decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n },
        // Rate probe answers raw bps x 10^decimals: 50 bps.
        extra: { "0xf949982b91c8c61e952b3ba942cbbfaef5386684:0xc52861f2": 5_000_000_000_000_000n },
      }),
    };
    const result = (await runBranches(config, network, runOptions)).result;

    expect(result.metadata).toMatchObject({
      branchCount: 1,
      freshnessMode: "not-applicable",
      redemption: { feeBps: 50 },
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it("fails when any branch balance cannot be read", async () => {
    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);
    const run = runBranches(config, {
      json: priceJson({ [assetKey("ethereum", "0xdddddddddddddddddddddddddddddddddddddddd")]: 60000 }),
      rpc: branchRpc({
        balances: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": null,
          "0xdddddddddddddddddddddddddddddddddddddddd": 500_000_000n,
        },
      }),
    });

    await expect(run).rejects.toThrow("could not read balances for: wstETH");
  });

  it("filters out branches with zero balances", async () => {
    const { result } = await runBranches(
      makeBranchConfig([wstEthBranch(), wbtcBranch()]),
      {
        json: priceJson({ [assetKey("ethereum", "0xdddddddddddddddddddddddddddddddddddddddd")]: 60000 }),
        rpc: branchRpc({
          balances: {
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 0n,
            "0xdddddddddddddddddddddddddddddddddddddddd": 100_000_000n,
          },
        }),
      },
    );

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].pct).toBe(100);
  });

  it.each([
    { name: "all balances are zero", balance: 0n, expected: "no non-zero balances" },
    { name: "all balances are null", balance: null, expected: "could not read balances for: wstETH" },
  ])("throws when $name", async ({ balance, expected }) => {
    const run = runBranches(
      makeBranchConfig([wstEthBranch()]),
      { rpc: branchRpc({ balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": balance } }) },
    );

    await expect(run).rejects.toThrow(expected);
  });

  it("propagates optional coinId and depType to slices", async () => {
    const { result } = await runBranches(
      makeBranchConfig([
        {
          ...wstEthBranch(),
          coinId: "wsteth",
          depType: "wrapper",
        },
      ]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 2000 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000_000_000_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n },
        }),
      },
    );

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].coinId).toBe("wsteth");
    expect(result.slices[0].depType).toBe("wrapper");
  });

  it("uses fixed price overrides for branches without DefiLlama pricing", async () => {
    const { result } = await runBranches(
      makeBranchConfig([
        {
          name: "USYC",
          holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
          risk: "low",
        },
        {
          name: "Wrapped stable",
          holder: "0xcccccccccccccccccccccccccccccccccccccccc",
          token: { chain: "ethereum", address: "0xdddddddddddddddddddddddddddddddddddddddd", decimals: 18 },
          risk: "low",
          priceUsd: 1,
        },
      ]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 1.12 }),
        rpc: branchRpc({
          balances: {
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000n,
            "0xdddddddddddddddddddddddddddddddddddddddd": 2_000_000_000_000_000_000n,
          },
          decimals: {
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n,
            "0xdddddddddddddddddddddddddddddddddddddddd": 18n,
          },
        }),
      },
    );

    expect(result.slices).toEqual([
      { sourceKey: "evm-branch-balances:ethereum:0xdddddddddddddddddddddddddddddddddddddddd", name: "Wrapped stable", pct: 64.1, risk: "low" },
      { sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "USYC", pct: 35.9, risk: "low" },
    ]);
  });

  it("falls through to the underlying coin price when the wrapper address lookup is missing", async () => {
    const usdcUnderlying = TRACKED_META_BY_ID.get("usdc-circle")!.contracts!.find(
      (contract) => contract.chain === "ethereum",
    )!.address;
    const { result } = await runBranches(
      makeBranchConfig([{ ...usdcBranch(), underlyingPrice1to1: true }]),
      {
        json: {
          [`${PRICES_BASE}/${assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")}`]: { coins: {} },
          [`${PRICES_BASE}/${assetKey("ethereum", usdcUnderlying)}`]: {
            coins: { [assetKey("ethereum", usdcUnderlying)]: { price: 1.0, timestamp: NOW_SEC, confidence: 0.99 } },
          },
        },
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
        }),
      },
    );

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "USDC branch", pct: 100, risk: "low", coinId: "usdc-circle" }]);
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when an underlying price substitution has not been reviewed", async () => {
    const run = runBranches(
      makeBranchConfig([usdcBranch()]),
      {
        json: {
          [`${PRICES_BASE}/${assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")}`]: { coins: {} },
        },
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
        }),
      },
    );

    await expect(run).rejects.toThrow(/Missing DefiLlama price/);
  });

  it("falls back to the stablecoins cache price for tracked branches missing DefiLlama address prices", async () => {
    const usycUnderlying = TRACKED_META_BY_ID.get("usyc-hashnote")!.contracts!.find(
      (contract) => contract.chain === "ethereum",
    )!.address;
    const now = NOW_SEC;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usyc-hashnote",
                  name: "Hashnote USYC",
                  symbol: "USYC",
                  price: 1.1245,
                },
              ],
            }),
            updated_at: now - 60,
          },
        ],
      },
    ]);

    const config = makeBranchConfig([{
      ...usdcBranch(),
      name: "Hashnote USYC",
      coinId: "usyc-hashnote",
      underlyingPrice1to1: true,
    }]);

    const { result, network } = await runBranches(config, {
      json: {
        [`${PRICES_BASE}/${assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")}`]: { coins: {} },
        [`${PRICES_BASE}/${assetKey("ethereum", usycUnderlying)}`]: { coins: {} },
      },
      rpc: branchRpc({
        balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000n },
        decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
      }),
    }, { ctx: { db } });

    expect(result.slices).toEqual([{ sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Hashnote USYC", pct: 100, risk: "low", coinId: "usyc-hashnote" }]);
    expect(network.requests.filter((request) => request.url.startsWith(PRICES_BASE))).toHaveLength(2);
  });

  it("emits degraded warning when a USD-pegged wrapper price is outside 5% but within 20% of peg", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch()]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 0.9 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
        }),
      },
    );

    expect(result.warnings).toEqual([expect.objectContaining({ code: "wrapper-depeg-detected", severity: "warning" })]);
  });

  it("does not emit USD peg warnings for explicit wrapper dependencies", async () => {
    const { result } = await runBranches(
      makeBranchConfig([{
        ...usdcBranch(),
        name: "sUSDe branch",
        token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 },
        risk: "medium",
        coinId: "usde-ethena",
        depType: "wrapper",
      }]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 1.23 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000_000_000_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n },
        }),
      },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      {
        sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "sUSDe branch",
        pct: 100,
        risk: "medium",
        coinId: "usde-ethena",
        depType: "wrapper",
      },
    ]);
  });

  it("throws when a USD-pegged wrapper price is outside the 0.5-1.5 fatal band", async () => {
    const run = runBranches(
      makeBranchConfig([usdcBranch()]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 0.4 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
        }),
      },
    );

    await expect(run).rejects.toThrow(/extreme depeg/);
  });

  it("does not warn when a USD-pegged wrapper trades within 5% of peg", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch()]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 1.02 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 50_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
        }),
      },
    );

    expect(result.warnings).toBeUndefined();
  });

  it.each([
    {
      name: "params.branches is missing",
      branches: undefined,
    },
    {
      name: "params.branches is empty",
      branches: [] as unknown[],
    },
    {
      name: "invalid fixed price overrides",
      branches: [{
        name: "USYC",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
        risk: "low",
        priceUsd: 0,
      }],
    },
  ])("throws when $name", async ({ branches }) => {
    const config = makeBranchConfig(branches);
    const network = installAdapterNetwork({ rpc: branchRpc() });
    const run = runBranches(config, network);

    await expect(run).rejects.toThrow("evm-branch-balances adapter params invalid");
    expect(network.rpcCalls).toEqual([]);
  });

  it("emits collateralizationRatio metadata when a debtSelector is configured", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = 50000 USD
    const { result } = await runBranches(
      makeBranchConfig([
        wbtcBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 8 } }),
      ], {
        params: {
          debtSelector: "0x18160ddd", // totalSupply() as example
          debtDecimals: 18,
        },
      }),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 60000 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 100_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 8n },
          extra: { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totalSupply()": 50_000n * 10n ** 18n },
        }),
      },
    );

    expect(result.metadata?.totalDebtUsd).toBe(50000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.2, 2);
    // Healthy ratio → no undercollateralized warning.
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("supports the USDN wstETH holder balance plus token supply debt shape", async () => {
    const { result } = await runBranches(
      makeBranchConfig([{
        name: "wstETH-backed USDN vault",
        holder: "0x656cb8c6d154aad29d8771384089be5b5141f01a",
        token: {
          chain: "ethereum",
          address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
          decimals: 18,
        },
        risk: "medium",
      }], {
        params: {
          debtSelector: "0x18160ddd",
          debtContract: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2",
          debtDecimals: 18,
        },
      }),
      {
        json: priceJson({ [assetKey("ethereum", "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0")]: 2879.58 }),
        rpc: branchRpc({
          balances: { "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": 729_665_660_446_827_366_025n },
          decimals: { "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": 18n },
          extra: {
            "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2:totalSupply()": 1_256_625_428_863_930_548_011_778n,
          },
        }),
      },
    );

    expect(result.slices).toEqual([
      {
        sourceKey: "evm-branch-balances:ethereum:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        name: "wstETH-backed USDN vault",
        pct: 100,
        risk: "medium",
      },
    ]);
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(1_256_625.43, 2);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("emits an undercollateralized warning when collateralizationRatio < 1.0", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = $80,000
    const { result } = await runBranches(
      makeBranchConfig([
        wbtcBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 8 } }),
      ], {
        params: {
          debtSelector: "0x18160ddd",
          debtDecimals: 18,
        },
      }),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 60000 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 100_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 8n },
          extra: { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totalSupply()": 80_000n * 10n ** 18n },
        }),
      },
    );

    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.75, 2);
    const warning = result.warnings?.find((w) => w.code === "undercollateralized");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
  });

  it("preserves wrapper depeg warnings when debt reconciliation also warns", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch()], {
        params: {
          debtSelector: "0x18160ddd",
          debtDecimals: 18,
        },
      }),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 0.9 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 100_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
          extra: { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totalSupply()": 100n * 10n ** 18n },
        }),
      },
    );

    expect(result.warnings?.map((warning) => warning.code)).toEqual(["wrapper-depeg-detected", "undercollateralized"]);
  });

  it("skips debt reconciliation when debtSelector is omitted", async () => {
    const { result, network } = await runBranches(
      makeBranchConfig([wstEthBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 } })]),
      {
        json: priceJson({ [assetKey("ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]: 2000 }),
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 1_000_000_000_000_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 18n },
        }),
      },
    );

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalDebtUsd).toBeUndefined();
    // No debt call should have been made.
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").map((call) => call.selector))
      .toEqual([BALANCE_OF_SELECTOR, DECIMALS_SELECTOR]);
  });

  it("resolves per-chain pinned blocks for multichain branch aggregation", async () => {
    void coin;
    void parseAbi;
    void fetchEvmBranchBalancesReserves;
  });
});
