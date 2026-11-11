import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import babelFish from "@shared/data/stablecoins/coins/xusd-babelfish.json";
import usual from "@shared/data/stablecoins/coins/usd0-usual.json";
import {
  runAdapter,
  expectWarnings,
  installAdapterNetwork,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcCall,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import { hasFatalWarnings } from "../validate";
import { adaptBranchBalanceReserves, readBranchBalanceParams } from "../branch-balances";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import xusdWire from "./fixtures/xusd-balances-oct7-2026.json";
import xusdDecimals from "./fixtures/xusd-decimals-oct7-2026.json";
import usualWire from "./fixtures/usual-circular-oct7-2026.json";
import usualContext from "./fixtures/usual-production-oct7-2026.json";

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

describe("branch valuation provenance", () => {
  it.each([
    ["current market", { price: 1, timestamp: NOW_SEC - 30, confidence: 0.95 }, false],
    ["stale market", { price: 1, timestamp: NOW_SEC - 86401, confidence: 0.95 }, true],
    ["undated market", { price: 1, confidence: 0.95 }, true],
  ])("retains %s quote clocks without replacing them with the block clock", async (_label, quote, degraded) => {
    const branch = usdcBranch();
    const key = assetKey("ethereum", branch.token.address);
    const { result } = await runAdapter("evm-branch-balances", { ...coin, liveReservesConfig: makeBranchConfig([branch]) }, {
      config: makeBranchConfig([branch]), nowSec: NOW_SEC,
      network: {
        block: { timestamp: NOW_SEC },
        rpc: branchRpc({ balances: { [branch.token.address]: 1_000_000n }, decimals: { [branch.token.address]: 6n } }),
        json: { [`${PRICES_BASE}/${key}`]: { coins: { [key]: quote } } },
      },
    });
    expect(result.metadata?.details).toMatchObject({
      branchObservations: [expect.objectContaining({ priceObservation: {
        sourceKind: "market-api", sourceLookup: key,
        quoteTimestamp: "timestamp" in quote ? quote.timestamp : null,
        quoteConfidence: quote.confidence,
      } })],
    });
    expect(result.warnings?.some((warning) => warning.code === "defillama-quote-quality") ?? false).toBe(degraded);
    expect(result.metadata?.details?.nominalReconciliation).toBeUndefined();
  });

  it("keeps a configured nominal price undated", async () => {
    const branch = wbtcBranch({ priceUsd: 60_000 });
    const { result } = await runAdapter("evm-branch-balances", { ...coin, liveReservesConfig: makeBranchConfig([branch]) }, {
      config: makeBranchConfig([branch]), nowSec: NOW_SEC,
      network: { rpc: branchRpc({ balances: { [branch.token.address]: 100_000_000n }, decimals: { [branch.token.address]: 8n } }) },
    });
    expect(result.metadata?.details).toMatchObject({
      branchObservations: [expect.objectContaining({ priceObservation: {
        sourceKind: "configured-nominal", sourceLookup: "config:WBTC:priceUsd",
        quoteTimestamp: null, quoteConfidence: null,
      } })],
    });
    expect(result.metadata?.details?.nominalReconciliation).toBeUndefined();
  });

  it("identifies a pinned oracle quote by contract, selector, token and the numbered block clock", async () => {
    const branch = usdcBranch();
    const oracle = "0x1111111111111111111111111111111111111111";
    const selector = "0x41976e09";
    const { result } = await runAdapter("evm-branch-balances", { ...coin, liveReservesConfig: makeBranchConfig([branch]) }, {
      config: makeBranchConfig([branch], { params: { priceOracle: { contract: oracle, selector, decimals: 18 } } }),
      nowSec: NOW_SEC,
      network: {
        block: { timestamp: NOW_SEC },
        rpc: branchRpc({
          balances: { [branch.token.address]: 1_000_000n }, decimals: { [branch.token.address]: 6n },
          extra: { [`${oracle}:${selector}${branch.token.address.slice(2).padStart(64, "0")}`]: WAD },
        }),
      },
    });
    expect(result.metadata?.details).toMatchObject({
      branchObservations: [expect.objectContaining({ priceObservation: {
        sourceKind: "pinned-oracle", sourceLookup: `ethereum:${oracle}:${selector}:${branch.token.address}`,
        quoteTimestamp: NOW_SEC, quoteConfidence: null,
      } })],
    });
  });
});

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
  factoryPaused?: boolean;
  globalCap?: bigint;
  relativeCap?: bigint;
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
    [`${HONEY_FACTORY}:paused()`]: options.factoryPaused ? 1n : 0n,
    [`${HONEY_FACTORY}:forcedBasketMode()`]: 0n,
    [`${HONEY_FACTORY}:isBasketModeEnabled(bool)`]: 0n,
    [`${HONEY_FACTORY}:getWeights()`]: uintArrayResult(Array.from({ length: assetCount }, () => WAD)),
    [`${HONEY_FACTORY}:globalCap()`]: options.globalCap ?? WAD,
    [`${HONEY_FACTORY}:collectedAssetFees(address)`]: options.collectedFees ?? 0n,
    [`${HONEY_FACTORY}:redeemRates(address)`]: 999_500_000_000_000_000n,
    [`${HONEY_FACTORY}:isPegged(address)`]: 1n,
    [`${HONEY_FACTORY}:relativeCap(address)`]: options.relativeCap ?? WAD,
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

  it("publishes observed HoneyFactory closure and guard degradation", async () => {
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

    const paused = await runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET],
      vaultAddresses: [HONEY_VAULT],
      factoryPaused: true,
    }));
    expect(paused.result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "HoneyFactory paused() returned true",
    });

    const capGuarded = await runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET],
      vaultAddresses: [HONEY_VAULT],
      relativeCap: WAD - 1n,
    }));
    expect(capGuarded.result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "degraded",
      routeStatusSource: "onchain",
    });
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

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "branch-token-decimals-mismatch",
      effect: "fatal",
    }));
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

  it.each([true, false])("keeps skipped-asset capacity conservative with complete census %s", async (complete) => {
    const skippedAsset = "0x00000000000000000000000000000000000000a2";
    const skippedVault = "0x00000000000000000000000000000000000000b2";
    const config = makeBranchConfig([
      honeyBranch(),
      {
        name: "Unconfigured capacity collateral", holder: skippedVault,
        token: { chain: "berachain", address: skippedAsset, decimals: 6 },
        risk: "high", priceUsd: 1,
      },
    ], {
      chain: "berachain",
      params: {
        ...(complete ? { census: {
          kind: "reviewed-roster", reviewedAt: "2023-11-13",
          sourceUrls: ["https://example.com/census"],
        } } : {}),
        redemptionCapacity: {
          kind: "honey-factory-vaults", factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN, maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });
    const network = honeyNetwork({
      assetCount: 2, assetAddresses: [HONEY_ASSET, skippedAsset],
      vaultAddresses: [HONEY_VAULT, skippedVault],
      custody: true, convertToAssets: 20_000_000n,
    });
    const { result } = await runBranches(config, network);
    expect(result.metadata).toMatchObject({ censusComplete: complete, valuationComplete: true });
    expect(result.slices).toHaveLength(2);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "redemption-capacity-non-stable-assets-skipped",
      effect: complete ? "info" : "degraded",
    }));
    // Both vaults are funded, but only the configured USDC output contributes.
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 7, routeStatus: "open", routeStatusSource: "onchain",
    });
  });

  it.each([true, false])("separates a Honey pause only when composition is complete %s", async (complete) => {
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        ...(complete ? { census: {
          kind: "reviewed-roster", reviewedAt: "2023-11-13",
          sourceUrls: ["https://example.com/census"],
        } } : {}),
        redemptionCapacity: {
          kind: "honey-factory-vaults", factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN, maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });
    const { result } = await runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT],
      custody: true, factoryPaused: true,
    }));
    expect(result.slices[0]).toMatchObject({ pct: 100 });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "honey-redemption-paused", effect: complete ? "info" : "degraded",
    }));
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0, routeStatus: "paused", routeStatusSource: "onchain",
    });
  });

  it("never excuses a failed custody-critical probe even with a reviewed complete roster", async () => {
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: {
        census: { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] },
        redemptionCapacity: {
          kind: "honey-factory-vaults", factoryAddress: HONEY_FACTORY,
          expectedHoneyAddress: HONEY_TOKEN, maxAssets: 4,
          stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
          sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
        },
      },
    });
    await expect(runBranches(config, honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT],
      custody: true, factoryPaused: true, failConvertToAssets: true,
    }))).rejects.toThrow(/cannot derive custody-mode branch composition/);
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
        { sourceKey: "evm-branch-balances:rootstock:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Sovryn Zero ZUSD", pct: expect.closeTo((1_000_000 / 1_000_428) * 100, 10), risk: "medium" },
        { sourceKey: "evm-branch-balances:rootstock:0xcccccccccccccccccccccccccccccccccccccccc", name: "Dollar on Chain DOC", pct: expect.closeTo((428 / 1_000_428) * 100, 10), risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
      ],
    },
    {
      name: "retains a measured branch far below any display precision",
      secondBalance: 4n,
      expected: [
        { sourceKey: "evm-branch-balances:rootstock:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Sovryn Zero ZUSD", pct: expect.closeTo((1_000_000 / 1_000_004) * 100, 10), risk: "medium" },
        { sourceKey: "evm-branch-balances:rootstock:0xcccccccccccccccccccccccccccccccccccccccc", name: "Dollar on Chain DOC", pct: expect.closeTo((4 / 1_000_004) * 100, 10), risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
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

  it("preserves unreadable constituents as unknown instead of normalizing the remaining balance", async () => {
    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);
    const { result } = await runBranches(config, {
      json: priceJson({ [assetKey("ethereum", "0xdddddddddddddddddddddddddddddddddddddddd")]: 60000 }),
      rpc: branchRpc({
        balances: {
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": null,
          "0xdddddddddddddddddddddddddddddddddddddddd": 500_000_000n,
        },
      }),
    });

    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.valuationComplete).toBe(false);
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
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

  it("rejects an empty observed book without a liability denominator", async () => {
    await expect(runBranches(
      makeBranchConfig([wstEthBranch()]),
      { rpc: branchRpc({ balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 0n } }) },
    )).rejects.toThrow();
  });

  it("publishes an unreadable book as unknown rather than observed zero", async () => {
    const { result } = await runBranches(
      makeBranchConfig([wstEthBranch()]),
      { rpc: branchRpc({ balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": null } }) },
    );
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
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
      { sourceKey: "evm-branch-balances:ethereum:0xdddddddddddddddddddddddddddddddddddddddd", name: "Wrapped stable", pct: expect.closeTo((2 / 3.12) * 100, 8), risk: "low" },
      { sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "USYC", pct: expect.closeTo((1.12 / 3.12) * 100, 8), risk: "low" },
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
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "defillama-quote-missing",
        effect: "degraded",
      }),
    ]);
  });

  it("fails closed when an underlying price substitution has not been reviewed", async () => {
    const { result } = await runBranches(
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

    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((slice) => slice.coinId === "usdc-circle")).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("falls back to the stablecoins cache price for tracked branches missing DefiLlama address prices", async () => {
    const usycUnderlying = TRACKED_META_BY_ID.get("usyc-hashnote")!.contracts!.find(
      (contract) => contract.chain === "ethereum",
    )!.address;
    const now = NOW_SEC;
    const db = mockD1Strict([
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
          census: { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] },
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

  it.each([
    ["reverted", null],
    ["oversized", `0x${"00".repeat(33)}`],
    ["non-hex", "0xnot-a-uint256"],
  ] as const)("withholds collateral when the configured liability read is %s", async (_label, debt) => {
    await expect(runBranches(
      makeBranchConfig([usdcBranch({ priceUsd: 1 })], {
        params: { debtSelector: "0x18160ddd", debtDecimals: 18 },
      }),
      {
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 100_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
          extra: { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totalSupply()": debt },
        }),
      },
    )).rejects.toThrow(/configured liability read/);
  });

  it("publishes observed zero debt without an undefined or infinite coverage quotient", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch({ priceUsd: 1 })], {
        params: { debtSelector: "0x18160ddd", debtDecimals: 18 },
      }),
      {
        rpc: branchRpc({
          balances: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 100_000_000n },
          decimals: { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 6n },
          extra: { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totalSupply()": 0n },
        }),
      },
    );
    expect(result.metadata?.totalDebtUsd).toBe(0);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.warnings?.some((warning) => warning.code === "undercollateralized") ?? false).toBe(false);
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
          census: { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] },
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
          census: { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] },
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
          census: { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] },
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
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").map((call) => call.selector))
      .toEqual([BALANCE_OF_SELECTOR, DECIMALS_SELECTOR]);
  });

});




const CENSUS_NOW_SEC = Date.parse("2026-10-02T12:00:00Z") / 1000;
const fundedBAsset = "0xff4299bca0313c20a61dc5ed597739743bef3f6d";
const usd0Config = usual.liveReservesConfig as LiveReservesConfig;
const usd0Params = readBranchBalanceParams(usd0Config, "evm-branch-balances");

function addressArray(addresses: string[]): string {
  return `0x${[32n, BigInt(addresses.length), ...addresses.map(BigInt)]
    .map((word) => word.toString(16).padStart(64, "0")).join("")}`;
}

function usualNetwork(options: { failedBalance?: string; failedPrice?: string; registry?: string[] } = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    "0x43882c864a406d55411b8c166bca604709fdf624:0x43069d46": addressArray(
      options.registry ?? usd0Params.branches.map((branch) => branch.token.address),
    ),
    "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5:totalSupply()": 100n * WAD,
  };
  for (const branch of usd0Params.branches) {
    rpc[`${branch.token.address}:balanceOf(address)`] = branch.token.address === options.failedBalance
      ? null
      : branch.coinId === "usdtb-ethena" ? 0n
        : (branch.unclassifiedSelfReferential ? 20n : 10n) * 10n ** BigInt(branch.token.decimals);
    rpc[`${branch.token.address}:decimals()`] = BigInt(branch.token.decimals);
    const priceData = `0x41976e09${branch.token.address.slice(2).toLowerCase().padStart(64, "0")}`;
    rpc[`0xb97e163ce6a8296f36112b042891cfe1e23c35bf:${priceData}`] = branch.token.address === options.failedPrice ? null : WAD;
  }
  return { rpc };
}

async function runUsual(network: AdapterNetworkSpec) {
  return runAdapter("evm-branch-balances", "usd0-usual", {
    config: usd0Config, network, nowSec: CENSUS_NOW_SEC,
  });
}

describe("branch reserve census and unavailable residual", () => {
  it("replays XUSD's pinned ten-token basket separately from its historical, undated DOC quote", async () => {
    const rpc: Record<string, AdapterRpcValue> = {};
    for (const read of [...xusdWire.reads, ...xusdDecimals.reads]) {
      if (read.method !== "eth_call") continue;
      const call = read.params[0] as { to: string; data: string };
      if ("result" in read.response) rpc[`${call.to}:${call.data}`] = read.response.result as string;
    }
    const header = xusdWire.block.result;
    const nowSec = Date.parse("2026-10-07T20:47:43Z") / 1000;
    const { result, network } = await runAdapter("evm-branch-balances", "xusd-babelfish", {
      config: babelFish.liveReservesConfig as LiveReservesConfig, nowSec,
      network: {
        rpc,
        block: { number: Number(header.number), timestamp: Number(header.timestamp), hash: header.hash },
        json: {
          "https://coins.llama.fi/prices/current/rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": {
            coins: { "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": { price: 0.9862258051288336 } },
          },
        },
      },
    });
    expect(network.rpcCalls.filter((call) => call.method === "eth_call").every((call) => call.block === "0x8dfda7")).toBe(true);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.9994367388064652, 10);
    const details = result.metadata?.details as {
      valuationBasis: string; liabilityBasis: string;
      nominalReconciliation: { reserveAtParUsd: number; shortfallAtParUsd: number; ratio: number };
      branchObservations: Array<{ name: string; priceObservation: Record<string, unknown> }>;
    };
    expect(details).toMatchObject({ valuationBasis: "mixed-nominal-market", liabilityBasis: "totalSupply-at-par" });
    expect(details.nominalReconciliation.reserveAtParUsd).toBeCloseTo(1_960_802.102552265, 6);
    expect(details.nominalReconciliation.shortfallAtParUsd).toBeCloseTo(2.2792151, 6);
    expect(details.nominalReconciliation.ratio).toBeCloseTo(0.9999988376121969, 12);
    expect(details.branchObservations.filter((entry) => entry.priceObservation.sourceKind === "configured-nominal")).toHaveLength(9);
    expect(details.branchObservations.find((entry) => entry.priceObservation.sourceKind === "market-api")?.priceObservation)
      .toMatchObject({ sourceLookup: "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db", quoteTimestamp: null, quoteConfidence: null });
    // 99.94% coverage sits above the shared 99.5% shortfall threshold; the
    // measured ratio stays published.
    expect(result.warnings?.some((warning) => warning.code === "undercollateralized") ?? false).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "defillama-quote-quality", effect: "degraded" }));
  });

  it("replays the pinned USD0 registry and positive circular claims without normalizing external legs", async () => {
    const rpc = usualNetwork().rpc!;
    // External balances/prices are captured production context, not new
    // independent RPC evidence; registry and circular words below are E1 wire.
    for (const observed of usualContext.branches) {
      rpc[`${observed.token}:balanceOf(address)`] = BigInt(observed.balanceRaw);
      rpc[`${observed.token}:decimals()`] = BigInt(observed.observedDecimals);
      if (observed.priceUsd != null) {
        const data = `0x41976e09${observed.token.slice(2).toLowerCase().padStart(64, "0")}`;
        rpc[`0xb97e163ce6a8296f36112b042891cfe1e23c35bf:${data}`] = BigInt(Math.round(observed.priceUsd * 1e18));
      }
    }
    for (const read of usualWire.result) {
      const call = read.params[0] as { to: string; data: string };
      rpc[`${call.to}:${call.data}`] = read.result;
    }
    // Production-scale liability: an external-only ratio would read ~15%.
    rpc["0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5:totalSupply()"] = 545_000_000n * 10n ** 18n;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", {
      config: usd0Config, nowSec: Date.parse(usualWire.observedAt) / 1000,
      network: { rpc, block: {
        number: Number(usualWire.block.number), hash: usualWire.block.hash,
        timestamp: Date.parse(usualWire.block.timestamp) / 1000,
      } },
    });
    expect(result.metadata).toMatchObject({ censusComplete: true, valuationComplete: true, unknownExposurePct: 0 });
    // Circular claims are measured very-high-risk slices, not an unknown residual.
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Self-referential claim (U0R)", pct: expect.closeTo(81.64068855601755, 8), risk: "very-high" }),
      expect.objectContaining({ name: "Self-referential claim (EVK Vault eUSD0-4)", pct: expect.closeTo(2.8507035858793603, 8), risk: "very-high" }),
    ]));
    expect(result.slices.filter((slice) => slice.name.startsWith("Self-referential")).every((slice) =>
      slice.coinId == null && slice.depType == null)).toBe(true);
    expectWarnings(result, ["self-referential-reserve"]);
    expect(result.warnings?.[0]).toMatchObject({ effect: "degraded" });
    const details = result.metadata?.details as { knownReserveValueUsd: number; selfReferentialValueUsd: number };
    // Only external legs enter the collateralization numerator.
    expect(details.selfReferentialValueUsd).toBeCloseTo(460_559_717.41, 1);
    expect(details.knownReserveValueUsd).toBeCloseTo(84_536_896.26, 1);
    // 84% circular claims: the external-only ratio is withheld with a reason.
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.ratioWithheldReason).toBe("self-referential-claims");
    expect(result.warnings?.some((warning) => warning.code === "undercollateralized") ?? false).toBe(false);
    expect(result.metadata?.details).toMatchObject({
      residualUsd: 0, contextualObservationsOnly: false,
      unclassifiedSelfReferentialBranches: ["EVK Vault eUSD0-4", "U0R"],
      branchObservations: expect.arrayContaining([
        expect.objectContaining({ name: "EVK Vault eUSD0-4", balanceRaw: "14867266666424154616700613", classification: "unclassified-self-referential" }),
        expect.objectContaining({ name: "U0R", balanceRaw: "444700000000000000000000000", classification: "unclassified-self-referential" }),
      ]),
    });
  });

  it("does not count independently observed zero circular balances as unknown exposure", async () => {
    const network = usualNetwork();
    for (const branch of usd0Params.branches.filter((entry) => entry.unclassifiedSelfReferential)) {
      network.rpc![`${branch.token.address}:balanceOf(address)`] = 0n;
    }
    const { result } = await runUsual(network);
    expect(result.metadata).toMatchObject({ censusComplete: true, valuationComplete: true, unknownExposurePct: 0 });
    expect(result.metadata?.details).toMatchObject({ unclassifiedSelfReferentialBranches: [] });
  });

  it("includes a newly funded verified BabelFish bAsset before normalizing the basket", async () => {
    const config = babelFish.liveReservesConfig as LiveReservesConfig;
    const params = readBranchBalanceParams(config, "evm-branch-balances");
    const rpc: Record<string, AdapterRpcValue> = {
      "0xb5999795be0ebb5bab23144aa5fd6a02d080299f:totalSupply()": 108n * WAD,
    };
    for (const branch of params.branches) {
      rpc[`${branch.token.address}:balanceOf(address)`] = (branch.token.address === fundedBAsset ? 99n : 1n) * WAD;
      rpc[`${branch.token.address}:decimals()`] = 18n;
    }
    const { result } = await runAdapter("evm-branch-balances", "xusd-babelfish", {
      config, nowSec: CENSUS_NOW_SEC,
      network: {
        rpc,
        block: { timestamp: CENSUS_NOW_SEC },
        json: {
          "https://coins.llama.fi/prices/current/rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": {
            coins: { "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": { price: 1, timestamp: CENSUS_NOW_SEC, confidence: 0.99 } },
          },
        },
      },
    });
    // Nine $1 constituents each keep their exact share of the $108 book; the $99 slice is 99 / 108.
    expect(result.slices.find((slice) => slice.sourceKey?.endsWith(fundedBAsset))?.pct).toBeCloseTo((99 / 108) * 100, 10);
    expect(result.metadata?.unknownExposurePct).toBe(0);
    expect(result.metadata?.collateralizationRatio).toBe(1);
  });

  it("withholds reserve weights rather than deriving missing collateral from liabilities", async () => {
    const failedBalance = usd0Params.branches.find((branch) => branch.coinId === "usyc-hashnote")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedBalance }));
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.valuationComplete).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("keeps an unpriced constituent unavailable instead of deleting it from the denominator", async () => {
    const failedPrice = usd0Params.branches.find((branch) => branch.coinId === "ustbl-spiko")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedPrice }));
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((slice) => slice.coinId === "ustbl-spiko")).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it.each(["extra", "replacement", "removed", "duplicate", "unreadable"])("rejects a %s on-chain registry rather than certifying configured rows", async (change) => {
    const registry = usd0Params.branches.map((branch) => branch.token.address);
    const unknown = "0x0000000000000000000000000000000000000001";
    if (change === "extra") registry.push(unknown);
    if (change === "replacement") registry[0] = unknown;
    if (change === "removed") registry.pop();
    if (change === "duplicate") registry[0] = registry[1];
    const network = usualNetwork({ registry });
    if (change === "unreadable") network.rpc!["0x43882c864a406d55411b8c166bca604709fdf624:0x43069d46"] = null;
    await expect(runUsual(network)).rejects.toThrow(/reserve registry/);
  });

  it("certifies a same-run holder registry without confusing vault identities with reserve tokens", async () => {
    const branch = usd0Params.branches[0];
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [branch], census: { ...usd0Params.census, identity: "holder" },
    } } as LiveReservesConfig;
    const accepted = await runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: usualNetwork({ registry: [branch.holder] }), nowSec: CENSUS_NOW_SEC,
    });
    expect(accepted.result.metadata).toMatchObject({ censusComplete: true, unknownExposurePct: 0, collateralizationRatio: 0.1 });
    await expect(runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: usualNetwork({ registry: [branch.token.address] }), nowSec: CENSUS_NOW_SEC,
    })).rejects.toThrow(/reserve registry drift/);
  });

  it("keeps observed zero USDtb distinct from USD0-denominated circular claims", async () => {
    const { result } = await runUsual(usualNetwork());
    expect(result.metadata?.censusComplete).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBe(0);
    expect(result.slices.some((slice) => slice.name === "U0R" || slice.name === "EVK Vault eUSD0-4")).toBe(false);
    expect(result.slices.filter((slice) => slice.name.startsWith("Self-referential claim")).map((slice) => slice.name).sort())
      .toEqual(["Self-referential claim (EVK Vault eUSD0-4)", "Self-referential claim (U0R)"]);
    const details = result.metadata?.details as {
      branchObservations: Array<{ name: string; balanceRaw: string | null }>;
      unavailableBranches: Array<{ name: string; reason: string }>;
      unclassifiedSelfReferentialBranches: string[];
    };
    expect(details.branchObservations.find((entry) => entry.name.startsWith("USDtb"))?.balanceRaw).toBe("0");
    expect(details.unavailableBranches).toEqual([]);
    expect(details.unclassifiedSelfReferentialBranches.sort()).toEqual(["EVK Vault eUSD0-4", "U0R"]);
  });

  it("preserves a partial book without a denominator as unknown, not a normalized known-only mix", () => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [
        { branch, balanceRaw: 10n ** BigInt(branch.token.decimals) },
        { branch: usd0Params.branches[1], balanceRaw: null },
      ],
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.unknownExposureUnavailableReason).toBe("partial-book-without-residual-bound");
  });

  it.each([undefined, 20, 100, 1000])("never uses liabilities %s to bound a partial collateral book", (liabilityUsd) => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [{ branch, balanceRaw: 40n * 10n ** BigInt(branch.token.decimals), observedDecimals: BigInt(branch.token.decimals) },
        { branch: usd0Params.branches[1], balanceRaw: null }],
      censusComplete: true, liabilityUsd,
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata?.details).toMatchObject({ knownReserveValueUsd: 40, residualUsd: null, contextualObservationsOnly: true });
  });

  it.each([
    ["2099-01-01", CENSUS_NOW_SEC, false],
    ["2026-10-02", CENSUS_NOW_SEC, false],
    ["2026-10-01", CENSUS_NOW_SEC, true],
    ["2025-10-02", CENSUS_NOW_SEC, false],
    ["2025-10-02", Date.parse("2025-10-02T00:00:00Z") / 1000 + V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec, true],
    ["2025-10-02", Date.parse("2025-10-02T00:00:00Z") / 1000 + V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec + 1, false],
  ] as const)("gates reviewed census %s at %s", async (reviewedAt, nowSec, admitted) => {
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [usd0Params.branches[0]], census: { kind: "reviewed-roster", reviewedAt, sourceUrls: ["https://example.com/census"] },
    } } as LiveReservesConfig;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", { config, network: { ...usualNetwork(), block: { timestamp: nowSec } }, nowSec });
    expect(result.metadata?.censusComplete).toBe(admitted);
    expect(result.metadata?.collateralizationRatio).toBe(admitted ? 0.1 : undefined);
    expect(result.metadata?.unknownExposurePct).toBe(admitted ? 0 : undefined);
  });

  it("does not let an elapsed current review certify an observation pinned before that review", async () => {
    const config = { ...usd0Config, params: { ...usd0Config.params,
      branches: [usd0Params.branches[0]], census: { kind: "reviewed-roster", reviewedAt: "2026-10-01", sourceUrls: ["https://example.com/census"] },
    } } as LiveReservesConfig;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", {
      config, network: { ...usualNetwork(), block: { timestamp: Date.parse("2026-10-01T12:00:00Z") / 1000 } }, nowSec: CENSUS_NOW_SEC,
    });
    expect(result.metadata?.censusComplete).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
  });

  it("does not claim zero unknown exposure from an uncertified configured roster", () => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [{ branch, balanceRaw: 10n ** BigInt(branch.token.decimals) }],
    });
    expect(result.metadata?.censusComplete).toBe(false);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.metadata?.unknownExposureUnavailableReason).toBe("configured-branches-not-certified-census");
  });

  it("rejects an unsupported census mode instead of silently dropping its completeness contract", () => {
    expect(() => readBranchBalanceParams({
      ...usd0Config, params: { ...usd0Config.params, census: { kind: "assumed-complete" } },
    }, "evm-branch-balances")).toThrow();
  });
});

const token = "0x1111111111111111111111111111111111111111";
const holder = "0x2222222222222222222222222222222222222222";
const underlying = "0x3333333333333333333333333333333333333333";
const usdcToken = "0x4444444444444444444444444444444444444444";

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

const POOL = "0x1116898dda4015ed8ddefb84b6e8bc24528af2d8";
const TOKENS = [
  { name: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, price: 0.9995 },
  { name: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, price: 1.0001 },
  { name: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, price: 1.0002 },
];
const LP_BALANCE = toFunctionSelector("getTokenBalance(uint8)");

// Real pinned reads from W3R31 research.json and R19 pinned-research.json.
// Prices are deliberately non-par fixture quotes, not historical price evidence.
const SNAPSHOTS = [
  {
    label: "W3R31", block: 26_122_495, timestamp: 1_791_160_000,
    lp: [617389085826156595665681n, 566903163736n, 789980651321n],
    admin: [97384663098483469878n, 89102822n, 171511020n],
    raw: [617486470489255079135559n, 566992266558n, 790152162341n],
  },
  {
    label: "R19", block: 26_124_986, timestamp: 1_791_189_059,
    lp: [548198898201131974057105n, 558846038023n, 867241759398n],
    admin: [104303681860985932031n, 90039784n, 171511020n],
    raw: [548303201882992959989136n, 558936077807n, 867413270418n],
  },
];

type Snapshot = typeof SNAPSHOTS[number];
function networkFor(snapshot: Snapshot, options: {
  multicall?: boolean; missingBalance?: number; missingPrice?: number; wrongDecimals?: number;
} = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {};
  const coins: Record<string, unknown> = {};
  for (const [index, token] of TOKENS.entries()) {
    const args = BigInt(index).toString(16).padStart(64, "0");
    rpc[`${POOL}:${LP_BALANCE}${args}`] = index === options.missingBalance ? null : snapshot.lp[index];
    // Positive raw balances remain available: failed LP reads must never use them.
    rpc[`${token.address}:balanceOf(address)`] = snapshot.raw[index];
    rpc[`${token.address}:decimals()`] = index === options.wrongDecimals ? 18n : BigInt(token.decimals);
    if (index !== options.missingPrice) {
      coins[`ethereum:${token.address}`] = { price: token.price, timestamp: snapshot.timestamp, confidence: 0.99 };
    }
  }
  return {
    block: { number: snapshot.block, timestamp: snapshot.timestamp },
    multicall: options.multicall,
    rpc,
    json: {
      [`https://coins.llama.fi/prices/current/${TOKENS.filter((_, index) => index !== options.missingBalance).map(token => `ethereum:${token.address}`).sort().join(",")}`]: { coins },
    },
  };
}

function pricedValue(amount: bigint, index: number): number {
  return Number(amount) / 10 ** TOKENS[index].decimals * TOKENS[index].price;
}

describe("nUSD LP-attributable reserve observation", () => {
  for (const snapshot of SNAPSHOTS) {
    it.each([true, false])(`excludes ${snapshot.label} admin balances with multicall=%s at one pinned block`, async (multicall) => {
      const { result, network } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall }), nowSec: snapshot.timestamp,
      });
      const lpValue = snapshot.lp.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      const adminValue = snapshot.admin.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      const rawValue = snapshot.raw.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      expect(rawValue - lpValue).toBeCloseTo(adminValue, 7);
      const details = result.metadata!.details as {
        knownReserveValueUsd: number;
        branchObservations: Array<{ name: string; balanceRaw: string }>;
      };
      // The production valuation rounds each of the three values to USD micros.
      expect(Math.abs(details.knownReserveValueUsd - lpValue)).toBeLessThanOrEqual(0.0000015);
      expect(details.branchObservations.map(row => row.balanceRaw)).toEqual(snapshot.lp.map(String));
      expect(result.slices).toHaveLength(3);
      expect(result.slices).toEqual(expect.arrayContaining(TOKENS.map((token, index) => expect.objectContaining({
        name: token.name, pct: expect.closeTo(pricedValue(snapshot.lp[index], index) / lpValue * 100, 8),
      }))));
      expect(result.metadata).toMatchObject({
        observedBlock: { chain: "ethereum", number: snapshot.block, timestamp: snapshot.timestamp },
        valuationComplete: true, censusComplete: false,
        unknownExposureUnavailableReason: "configured-branches-not-certified-census",
      });
      expect(result.metadata!.collateralizationRatio).toBeUndefined();
      const reads = network.rpcCalls.filter(call => call.method === "eth_call");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(call => call.block === `0x${snapshot.block.toString(16)}`)).toBe(true);
    });
  }

  for (const missingBalance of [0, 1, 2]) {
    it.each([true, false])(`withholds weights when LP branch ${missingBalance} is unavailable, multicall=%s`, async (multicall) => {
      const snapshot = SNAPSHOTS[1];
      const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall, missingBalance }), nowSec: snapshot.timestamp,
      });
      expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
      expect(result.metadata).toMatchObject({ valuationComplete: false, censusComplete: false, unknownExposurePct: 100 });
      expect(result.metadata!.details).toMatchObject({
        contextualObservationsOnly: true,
        unavailableBranches: [{ name: TOKENS[missingBalance].name, reason: "balance-unavailable" }],
      });
      expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch-reserve-book-partial" })]));
    });
  }

  it("withholds weights when a positive LP constituent is unpriced", async () => {
    const snapshot = SNAPSHOTS[1];
    const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
      network: networkFor(snapshot, { missingPrice: 1 }), nowSec: snapshot.timestamp,
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata).toMatchObject({ valuationComplete: false, unknownExposurePct: 100 });
    expect(result.metadata!.details).toMatchObject({ unavailableBranches: [{ name: "USDC", reason: "price-unavailable" }] });
  });

  it("rejects a changed token-decimals identity instead of admitting LP amounts at the wrong scale", async () => {
    const snapshot = SNAPSHOTS[1];
    const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
      network: networkFor(snapshot, { wrongDecimals: 1 }), nowSec: snapshot.timestamp,
    });
    expect(result.metadata).toMatchObject({ valuationComplete: false, unknownExposurePct: 100 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch-token-decimals-mismatch", effect: "fatal" })]));
  });
});
