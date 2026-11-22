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

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const ADDR_D = "0xdddddddddddddddddddddddddddddddddddddddd";
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
const PRICES_BASE = "https://coins.llama.fi/prices/current";
const REVIEWED_CENSUS = { kind: "reviewed-roster", reviewedAt: "2023-11-13", sourceUrls: ["https://example.com/census"] };
const UNKNOWN_SLICE = { name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" };

const addressWord = (address: string) => BigInt(address);
const abiWords = (...words: bigint[]) => `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}`;
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const uintArrayResult = (values: bigint[]) => abiWords(32n, BigInt(values.length), ...values);
const callArg = (call: AdapterRpcCall) => BigInt(`0x${call.data.slice(10)}`);
const callAddressArg = (call: AdapterRpcCall) => `0x${call.data.slice(-40)}`;
const assetKey = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

const wstEthBranch = (overrides: Record<string, unknown> = {}) => ({
  name: "wstETH", holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 18 }, risk: "low", ...overrides,
});
const wbtcBranch = (overrides: Record<string, unknown> = {}) => ({
  name: "WBTC", holder: ADDR_C, token: { chain: "ethereum", address: ADDR_D, decimals: 8 }, risk: "medium", ...overrides,
});
const honeyBranch = (overrides: Record<string, unknown> = {}) => ({
  name: "USDC.e", holder: HONEY_VAULT, token: { chain: "berachain", address: HONEY_ASSET, decimals: 6 }, risk: "low", priceUsd: 1, ...overrides,
});
const usdcBranch = (overrides: Record<string, unknown> = {}) => ({
  name: "USDC branch", holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 6 }, risk: "low", coinId: "usdc-circle", ...overrides,
});

function makeBranchConfig(
  branches?: unknown[],
  options: { chain?: string; params?: Record<string, unknown> } = {},
): LiveReservesConfig {
  return {
    adapter: "evm-branch-balances", version: 1, semantics: "collateral-mix",
    inputs: { primary: { kind: "onchain-evm", chain: options.chain ?? "ethereum", rpcMode: "public-rpc" } },
    params: { ...(branches === undefined ? {} : { branches }), ...options.params },
  } as LiveReservesConfig;
}

function makeHoneyConfig(opts: {
  branches?: unknown[];
  maxAssets?: number;
  stableAssets?: Array<{ address: string; decimals: number }>;
  census?: boolean;
} = {}): LiveReservesConfig {
  return makeBranchConfig(opts.branches ?? [honeyBranch()], {
    chain: "berachain",
    params: {
      ...(opts.census ? { census: REVIEWED_CENSUS } : {}),
      redemptionCapacity: {
        kind: "honey-factory-vaults",
        factoryAddress: HONEY_FACTORY,
        expectedHoneyAddress: HONEY_TOKEN,
        maxAssets: opts.maxAssets ?? 4,
        stableAssets: opts.stableAssets ?? [{ address: HONEY_ASSET, decimals: 6 }],
        sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
      },
    },
  });
}

function priceJson(entries: Record<string, number>): Record<string, unknown> {
  const coins = Object.fromEntries(Object.entries(entries).map(([k, price]) => [k, { price, timestamp: NOW_SEC, confidence: 0.99 }]));
  return { [`${PRICES_BASE}/${Object.keys(coins).sort().join(",")}`]: { coins } };
}

interface BranchRpcOptions {
  balances?: Record<string, bigint | null>;
  decimals?: Record<string, bigint | null>;
  extra?: Record<string, AdapterRpcValue>;
}

function branchRpc(options: BranchRpcOptions = {}): Record<string, AdapterRpcValue> {
  const rpc: Record<string, AdapterRpcValue> = {};
  for (const [token, balance] of Object.entries(options.balances ?? {})) rpc[`${token}:${BALANCE_OF_SELECTOR}`] = balance;
  for (const [token, decimals] of Object.entries(options.decimals ?? {})) rpc[`${token}:${DECIMALS_SELECTOR}`] = decimals;
  return { ...rpc, ...options.extra };
}

interface HoneyOptions {
  assetCount?: number;
  assetAddresses?: string[];
  vaultAddresses?: string[];
  custody?: boolean;
  failVaultAsset?: boolean;
  failConvertToAssets?: boolean;
  convertToAssets?: bigint | null;
  factoryShares?: bigint;
  collectedFees?: bigint;
  factoryPaused?: boolean;
  globalCap?: bigint;
  relativeCap?: bigint;
  assetBalanceByHolder?: (holder: string) => bigint;
}

function honeyNetwork(options: HoneyOptions = {}): AdapterNetworkSpec {
  const assetCount = options.assetCount ?? 1;
  const assets = options.assetAddresses ?? Array.from({ length: assetCount }, (_, i) => `0x${(0xa1 + i).toString(16).padStart(40, "0")}`);
  const vaults = options.vaultAddresses ?? Array.from({ length: assetCount }, (_, i) => `0x${(0xb1 + i).toString(16).padStart(40, "0")}`);
  const custodyHolders = Array.from({ length: assetCount }, (_, i) => `0x${(0xc1 + i).toString(16).padStart(40, "0")}`);
  const custody = options.custody ?? false;
  const vaultOfAsset = Object.fromEntries(assets.map((a, i) => [a.toLowerCase(), vaults[i]]));

  const rpc: Record<string, AdapterRpcValue> = {
    [`${HONEY_ASSET}:balanceOf(address)`]: 8_000_000n,
    [`${HONEY_ASSET}:decimals()`]: 6n,
    [`${HONEY_FACTORY}:honey()`]: HONEY_TOKEN,
    [`${HONEY_FACTORY}:numRegisteredAssets()`]: BigInt(assetCount),
    [`${HONEY_FACTORY}:registeredAssets(uint256)`]: (call: AdapterRpcCall) => assets[Number(callArg(call))],
    [`${HONEY_FACTORY}:vaults(address)`]: (call: AdapterRpcCall) => vaultOfAsset[callAddressArg(call).toLowerCase()],
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
  assets.forEach((asset, i) => {
    const vault = vaults[i];
    rpc[`${vault}:asset()`] = options.failVaultAsset ? null : asset;
    rpc[`${vault}:paused()`] = 0n;
    rpc[`${vault}:custodyInfo()`] = custody ? abiWords(1n, addressWord(custodyHolders[i])) : abiWords(0n, 0n);
    rpc[`${vault}:${BALANCE_OF_SELECTOR}`] = options.factoryShares ?? 10n * WAD;
    rpc[`${vault}:convertToAssets(uint256)`] = options.failConvertToAssets ? null : options.convertToAssets ?? 10_000_000n;
    rpc[`${asset}:${DECIMALS_SELECTOR}`] = 6n;
    if (options.assetBalanceByHolder) {
      for (const h of [vault, custodyHolders[i]]) {
        rpc[`${asset}:${BALANCE_OF_SELECTOR}${word(addressWord(h)).slice(2)}`] = options.assetBalanceByHolder(h.toLowerCase());
      }
    } else {
      rpc[`${asset}:${BALANCE_OF_SELECTOR}`] = 8_000_000n;
    }
    if (custody) rpc[`${asset}:allowance(address,address)`] = 7_000_000n;
  });
  return { chains: { berachain: BERACHAIN_RPC_URL }, rpc };
}

async function runBranches(
  config: LiveReservesConfig,
  network: AdapterNetworkSpec | AdapterNetwork = {},
  options: { ctx?: Record<string, unknown>; validate?: false } = {},
) {
  return runAdapter("evm-branch-balances", "jpyt-dephaser", {
    network, config, nowSec: NOW_SEC,
    ...(options.ctx ? { ctx: options.ctx } : {}),
    ...(options.validate === false ? { validate: false as const } : {}),
  });
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
        quoteTimestamp: "timestamp" in quote ? quote.timestamp : null, quoteConfidence: quote.confidence,
      } })],
    });
    expect(result.warnings?.some((w) => w.code === "defillama-quote-quality") ?? false).toBe(degraded);
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
        sourceKind: "configured-nominal", sourceLookup: "config:WBTC:priceUsd", quoteTimestamp: null, quoteConfidence: null,
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

describe("fetchEvmBranchBalancesReserves", () => {
  it("preserves the legacy reserve result without redemption opt-in", async () => {
    const { result, network } = await runBranches(makeBranchConfig([wstEthBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 2000 }),
      rpc: branchRpc({ balances: { [ADDR_B]: WAD }, decimals: { [ADDR_B]: 18n } }),
    });
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:ethereum:${ADDR_B}`, name: "wstETH", pct: 100, risk: "low" }]);
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(network.rpcCalls.filter((c) => c.method === "eth_call").map((c) => c.selector))
      .toEqual([BALANCE_OF_SELECTOR, DECIMALS_SELECTOR]);
  });

  it("emits HoneyFactory live direct capacity without changing reserve slices", async () => {
    const { result } = await runBranches(makeHoneyConfig(), honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT],
    }));
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:berachain:${HONEY_ASSET}`, name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.metadata?.redemption).toEqual(expect.objectContaining({
      capacityUsd: 8, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
      routeStatus: "open", routeStatusSource: "onchain", feeBps: 5,
    }));
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
  });

  it("publishes observed HoneyFactory closure and guard degradation", async () => {
    const config = makeHoneyConfig();
    const paused = await runBranches(config, honeyNetwork({ assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT], factoryPaused: true }));
    expect(paused.result.metadata?.redemption).toMatchObject({
      capacityUsd: 0, routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "HoneyFactory paused() returned true",
    });
    const capGuarded = await runBranches(config, honeyNetwork({ assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT], relativeCap: WAD - 1n }));
    expect(capGuarded.result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded", routeStatusSource: "onchain" });
  });

  it.each([
    { custody: false, wave5Length: 8, expectedCapacity: 32 },
    { custody: true, wave5Length: 12, expectedCapacity: 28 },
  ])("batches the configured four Honey assets into five dependency waves (custody=$custody)", async ({ custody, wave5Length, expectedCapacity }) => {
    const config = makeHoneyConfig({
      stableAssets: Array.from({ length: 4 }, (_, i) => ({ address: `0x${(0xa1 + i).toString(16).padStart(40, "0")}`, decimals: 6 })),
    });
    const { result, network } = await runBranches(config, honeyNetwork({ assetCount: 4, custody }));

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: expectedCapacity });
    const honeyMembers = network.rpcCalls.filter((c) => c.viaMulticall && c.contract !== HONEY_ASSET);
    const selectors = honeyMembers.map((c) => c.selector);
    expect(honeyMembers).toHaveLength(2 + 9 + 20 + 20 + wave5Length);
    expect(selectors.slice(0, 2)).toEqual([toFunctionSelector("honey()"), toFunctionSelector("numRegisteredAssets()")]);
    expect(selectors[2]).toBe(toFunctionSelector("registeredAssets(uint256)"));
    expect(selectors[11]).toBe(toFunctionSelector("vaults(address)"));
    expect(selectors[31]).toBe(toFunctionSelector("asset()"));
    expect(selectors[51]).toBe(toFunctionSelector("convertToAssets(uint256)"));
  });

  it("batches four same-chain branch balances and decimals reads into one Multicall3 wave", async () => {
    const branches = Array.from({ length: 4 }, (_, i) => ({
      name: `branch-${i}`, holder: `0x${(0xd1 + i).toString(16).padStart(40, "0")}`,
      token: { chain: "ethereum", address: `0x${(0xe1 + i).toString(16).padStart(40, "0")}`, decimals: 6 },
      risk: "low", priceUsd: 1,
    }));
    const { result, network } = await runBranches(makeBranchConfig(branches), {
      rpc: Object.fromEntries(branches.flatMap((b, i) => [
        [`${b.token.address}:${BALANCE_OF_SELECTOR}`, BigInt(i + 1) * 1_000_000n],
        [`${b.token.address}:${DECIMALS_SELECTOR}`, 6n],
      ])),
    });
    expect(result.slices).toHaveLength(4);
    expect(network.rpcCalls).toHaveLength(8);
    expect(network.rpcCalls.every((c) => c.viaMulticall)).toBe(true);
  });

  it("values a mixed-decimals basket correctly when on-chain decimals match config", async () => {
    const b1 = "0x00000000000000000000000000000000000000b1";
    const b2 = "0x00000000000000000000000000000000000000b2";
    const { result } = await runBranches(makeBranchConfig([
      { name: "Six-decimals stable", holder: "0x00000000000000000000000000000000000000a1", token: { chain: "ethereum", address: b1, decimals: 6 }, risk: "low", priceUsd: 1 },
      { name: "Eighteen-decimals stable", holder: "0x00000000000000000000000000000000000000a2", token: { chain: "ethereum", address: b2, decimals: 18 }, risk: "low", priceUsd: 1 },
    ]), { rpc: branchRpc({ balances: { [b1]: 3_000_000n, [b2]: 2n * WAD }, decimals: { [b1]: 6n, [b2]: 18n } }) });

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      { sourceKey: `evm-branch-balances:ethereum:${b1}`, name: "Six-decimals stable", pct: 60, risk: "low" },
      { sourceKey: `evm-branch-balances:ethereum:${b2}`, name: "Eighteen-decimals stable", pct: 40, risk: "low" },
    ]);
  });

  it("emits a fatal warning when a branch token's on-chain decimals differ from config", async () => {
    const b1 = "0x00000000000000000000000000000000000000b1";
    const { result } = await runBranches(
      makeBranchConfig([{ name: "M by M^0 (via UsualM wrapper)", holder: "0x00000000000000000000000000000000000000a1", token: { chain: "ethereum", address: b1, decimals: 18 }, risk: "low", priceUsd: 1 }]),
      { rpc: branchRpc({ balances: { [b1]: 50_000_000n }, decimals: { [b1]: 6n } }) },
      { validate: false },
    );
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-token-decimals-mismatch", effect: "fatal" }));
    expect(hasFatalWarnings(result.warnings)).toBe(true);
  });

  it("keeps the configured scale with an info warning when decimals() reverts", async () => {
    const b1 = "0x00000000000000000000000000000000000000b1";
    const { result } = await runBranches(
      makeBranchConfig([{ name: "Non-ERC20 branch", holder: "0x00000000000000000000000000000000000000a1", token: { chain: "ethereum", address: b1, decimals: 6 }, risk: "low", priceUsd: 1 }]),
      { rpc: branchRpc({ balances: { [b1]: 1_000_000n }, decimals: { [b1]: null } }) },
    );
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:ethereum:${b1}`, name: "Non-ERC20 branch", pct: 100, risk: "low" }]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "branch-token-decimals-unavailable", effect: "info" })]);
  });

  it.each([
    { name: "enumeration exceeds the configured bound", honeyOptions: { assetCount: 2 }, maxAssets: 1 },
    { name: "any required vault read fails", honeyOptions: { failVaultAsset: true }, maxAssets: 4 },
  ])("fails closed when $name", async ({ honeyOptions, maxAssets }) => {
    await expect(runBranches(makeHoneyConfig({ maxAssets }), honeyNetwork(honeyOptions)))
      .rejects.toThrow(/HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/);
  });

  it("derives custody-mode branch composition from factory-owned net shares", async () => {
    const { result } = await runBranches(makeHoneyConfig(), honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT], custody: true,
      factoryShares: 184_630_645_591_044_543n, collectedFees: 155_489_553_000_000_000n, convertToAssets: 29_141n,
      assetBalanceByHolder: (holder) => (holder === HONEY_VAULT.toLowerCase() ? 0n : 274_114n),
    }));
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:berachain:${HONEY_ASSET}`, name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({ branchCount: 1, redemption: { capacityUsd: 0.029141, routeStatus: "open" } });
  });

  it("fails closed when custody vault share conversion is unreadable", async () => {
    await expect(runBranches(makeHoneyConfig(), honeyNetwork({ custody: true, failConvertToAssets: true })))
      .rejects.toThrow(/HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/);
  });

  it.each([true, false])("keeps skipped-asset capacity conservative with complete census %s", async (complete) => {
    const skippedAsset = "0x00000000000000000000000000000000000000a2";
    const skippedVault = "0x00000000000000000000000000000000000000b2";
    const config = makeHoneyConfig({
      census: complete,
      branches: [
        honeyBranch(),
        { name: "Unconfigured capacity collateral", holder: skippedVault, token: { chain: "berachain", address: skippedAsset, decimals: 6 }, risk: "high", priceUsd: 1 },
      ],
    });
    const { result } = await runBranches(config, honeyNetwork({
      assetCount: 2, assetAddresses: [HONEY_ASSET, skippedAsset], vaultAddresses: [HONEY_VAULT, skippedVault],
      custody: true, convertToAssets: 20_000_000n,
    }));
    expect(result.metadata).toMatchObject({ censusComplete: complete, valuationComplete: true, redemption: { capacityUsd: 7, routeStatus: "open", routeStatusSource: "onchain" } });
    expect(result.slices).toHaveLength(2);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "redemption-capacity-non-stable-assets-skipped", effect: complete ? "info" : "degraded",
    }));
  });

  it.each([true, false])("separates a Honey pause only when composition is complete %s", async (complete) => {
    const { result } = await runBranches(makeHoneyConfig({ census: complete }), honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT], custody: true, factoryPaused: true,
    }));
    expect(result.slices[0]).toMatchObject({ pct: 100 });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "honey-redemption-paused", effect: complete ? "info" : "degraded",
    }));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "paused", routeStatusSource: "onchain" });
  });

  it("never excuses a failed custody-critical probe even with a reviewed complete roster", async () => {
    await expect(runBranches(makeHoneyConfig({ census: true }), honeyNetwork({
      assetAddresses: [HONEY_ASSET], vaultAddresses: [HONEY_VAULT], custody: true, factoryPaused: true, failConvertToAssets: true,
    }))).rejects.toThrow(/cannot derive custody-mode branch composition/);
  });

  it("computes percentage slices from branch balances and prices", async () => {
    const { result } = await runBranches(makeBranchConfig([wstEthBranch(), wbtcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 2000, [assetKey("ethereum", ADDR_D)]: 60000 }),
      rpc: branchRpc({ balances: { [ADDR_B]: WAD, [ADDR_D]: 100_000_000n }, decimals: { [ADDR_B]: 18n, [ADDR_D]: 8n } }),
    });
    expect(result.slices).toHaveLength(2);
    expect(Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10).toBe(100);
    expect(result.slices[0]).toMatchObject({ name: "WBTC", risk: "medium" });
    expect(result.slices[1]).toMatchObject({ name: "wstETH", risk: "low" });
    expect(result.slices[0].pct).toBeCloseTo(96.8, 0);
    expect(result.slices[1].pct).toBeCloseTo(3.2, 0);
    expect(result.metadata).toMatchObject({ branchCount: 2, freshnessMode: "not-applicable", details: { proofKind: "onchain-branch-balances" } });
  });

  it.each([
    { name: "retains a measured sub-tenth-percent tracked branch", secondBalance: 428n, total: 1_000_428 },
    { name: "retains a measured branch far below any display precision", secondBalance: 4n, total: 1_000_004 },
  ])("$name", async ({ secondBalance, total }) => {
    const config = makeBranchConfig([
      { name: "Sovryn Zero ZUSD", holder: ADDR_A, token: { chain: "rootstock", address: ADDR_B, decimals: 0 }, risk: "medium", priceUsd: 1 },
      { name: "Dollar on Chain DOC", holder: ADDR_A, token: { chain: "rootstock", address: ADDR_C, decimals: 0 }, risk: "medium", coinId: "doc-money-on-chain", depType: "collateral", priceUsd: 1 },
    ], { chain: "rootstock" });

    const { result } = await runBranches(config, {
      chains: { rootstock: ROOTSTOCK_RPC_URL },
      json: priceJson({ [assetKey("rootstock", ADDR_B)]: 1, [assetKey("rootstock", ADDR_C)]: 1 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 1_000_000n, [ADDR_C]: secondBalance }, decimals: { [ADDR_B]: 0n, [ADDR_C]: 0n } }),
    });
    expect(result.slices).toEqual([
      { sourceKey: `evm-branch-balances:rootstock:${ADDR_B}`, name: "Sovryn Zero ZUSD", pct: expect.closeTo((1_000_000 / total) * 100, 10), risk: "medium" },
      { sourceKey: `evm-branch-balances:rootstock:${ADDR_C}`, name: "Dollar on Chain DOC", pct: expect.closeTo((Number(secondBalance) / total) * 100, 10), risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
    ]);
  });

  it("uses an explicit branch price token for DefiLlama price lookup", async () => {
    const receiptToken = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const priceToken = "0xffffffffffffffffffffffffffffffffffffffff";
    const { result } = await runBranches(makeBranchConfig([{
      name: "Receipt token", holder: ADDR_A, token: { chain: "berachain", address: receiptToken, decimals: 18 },
      priceToken: { chain: "berachain", address: priceToken }, risk: "high",
    }], { chain: "berachain" }), {
      chains: { berachain: BERACHAIN_RPC_URL },
      json: priceJson({ [assetKey("berachain", priceToken)]: 75_000 }),
      rpc: branchRpc({ balances: { [receiptToken]: WAD }, decimals: { [receiptToken]: 18n } }),
    });
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:berachain:${receiptToken}`, name: "Receipt token", pct: 100, risk: "high" }]);
  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    const config = makeBranchConfig([wstEthBranch()], {
      params: { redemptionRateProbe: { contract: "0xf949982b91c8c61e952b3ba942cbbfaef5386684", selector: "0xc52861f2", decimals: 18 } },
    });
    const { result } = await runBranches(config, {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 2000 }),
      rpc: branchRpc({
        balances: { [ADDR_B]: WAD }, decimals: { [ADDR_B]: 18n },
        extra: { "0xf949982b91c8c61e952b3ba942cbbfaef5386684:0xc52861f2": 5_000_000_000_000_000n },
      }),
    }, { validate: false });
    expect(result.metadata).toMatchObject({
      branchCount: 1, freshnessMode: "not-applicable", redemption: { feeBps: 50 }, details: { proofKind: "onchain-branch-balances" },
    });
  });

  it("preserves unreadable constituents as unknown instead of normalizing the remaining balance", async () => {
    const { result } = await runBranches(makeBranchConfig([wstEthBranch(), wbtcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_D)]: 60000 }),
      rpc: branchRpc({ balances: { [ADDR_B]: null, [ADDR_D]: 500_000_000n } }),
    });
    expect(result.metadata).toMatchObject({ unknownExposurePct: 100, valuationComplete: false });
    expect(result.slices).toEqual([UNKNOWN_SLICE]);
  });

  it("filters out branches with zero balances", async () => {
    const { result } = await runBranches(makeBranchConfig([wstEthBranch(), wbtcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_D)]: 60000 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 0n, [ADDR_D]: 100_000_000n } }),
    });
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({ name: "WBTC", pct: 100 });
  });

  it("rejects an empty observed book without a liability denominator", async () => {
    await expect(runBranches(makeBranchConfig([wstEthBranch()]), { rpc: branchRpc({ balances: { [ADDR_B]: 0n } }) })).rejects.toThrow();
  });

  it("publishes an unreadable book as unknown rather than observed zero", async () => {
    const { result } = await runBranches(makeBranchConfig([wstEthBranch()]), { rpc: branchRpc({ balances: { [ADDR_B]: null } }) });
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("uses fixed price overrides for branches without DefiLlama pricing", async () => {
    const { result } = await runBranches(makeBranchConfig([
      { name: "USYC", holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 6 }, risk: "low" },
      { name: "Wrapped stable", holder: ADDR_C, token: { chain: "ethereum", address: ADDR_D, decimals: 18 }, risk: "low", priceUsd: 1 },
    ]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 1.12 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 1_000_000n, [ADDR_D]: 2n * WAD }, decimals: { [ADDR_B]: 6n, [ADDR_D]: 18n } }),
    });
    expect(result.slices).toEqual([
      { sourceKey: `evm-branch-balances:ethereum:${ADDR_D}`, name: "Wrapped stable", pct: expect.closeTo((2 / 3.12) * 100, 8), risk: "low" },
      { sourceKey: `evm-branch-balances:ethereum:${ADDR_B}`, name: "USYC", pct: expect.closeTo((1.12 / 3.12) * 100, 8), risk: "low" },
    ]);
  });

  it("falls through to the underlying coin price when the wrapper address lookup is missing", async () => {
    const usdcUnderlying = TRACKED_META_BY_ID.get("usdc-circle")!.contracts!.find((c) => c.chain === "ethereum")!.address;
    const { result } = await runBranches(makeBranchConfig([{ ...usdcBranch(), underlyingPrice1to1: true }]), {
      json: {
        [`${PRICES_BASE}/${assetKey("ethereum", ADDR_B)}`]: { coins: {} },
        ...priceJson({ [assetKey("ethereum", usdcUnderlying)]: 1.0 }),
      },
      rpc: branchRpc({ balances: { [ADDR_B]: 50_000_000n }, decimals: { [ADDR_B]: 6n } }),
    });
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:ethereum:${ADDR_B}`, name: "USDC branch", pct: 100, risk: "low", coinId: "usdc-circle" }]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "defillama-quote-missing", effect: "degraded" })]);
  });

  it("fails closed when an underlying price substitution has not been reviewed", async () => {
    const { result } = await runBranches(makeBranchConfig([usdcBranch()]), {
      json: { [`${PRICES_BASE}/${assetKey("ethereum", ADDR_B)}`]: { coins: {} } },
      rpc: branchRpc({ balances: { [ADDR_B]: 50_000_000n }, decimals: { [ADDR_B]: 6n } }),
    });
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((s) => s.coinId === "usdc-circle")).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("falls back to the stablecoins cache price for tracked branches missing DefiLlama address prices", async () => {
    const usycUnderlying = TRACKED_META_BY_ID.get("usyc-hashnote")!.contracts!.find((c) => c.chain === "ethereum")!.address;
    const db = mockD1Strict([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"],
      rows: [{
        key: "stablecoins", updated_at: NOW_SEC - 60,
        value: JSON.stringify({ peggedAssets: [{ id: "usyc-hashnote", name: "Hashnote USYC", symbol: "USYC", price: 1.1245 }] }),
      }],
    }]);
    const { result, network } = await runBranches(
      makeBranchConfig([{ ...usdcBranch(), name: "Hashnote USYC", coinId: "usyc-hashnote", underlyingPrice1to1: true }]),
      {
        json: { [`${PRICES_BASE}/${assetKey("ethereum", ADDR_B)}`]: { coins: {} }, [`${PRICES_BASE}/${assetKey("ethereum", usycUnderlying)}`]: { coins: {} } },
        rpc: branchRpc({ balances: { [ADDR_B]: 1_000_000n }, decimals: { [ADDR_B]: 6n } }),
      },
      { ctx: { db } },
    );
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:ethereum:${ADDR_B}`, name: "Hashnote USYC", pct: 100, risk: "low", coinId: "usyc-hashnote" }]);
    expect(network.requests.filter((r) => r.url.startsWith(PRICES_BASE))).toHaveLength(2);
  });

  it("emits degraded warning when a USD-pegged wrapper price is outside 5% but within 20% of peg", async () => {
    const { result } = await runBranches(makeBranchConfig([usdcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 0.9 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 50_000_000n }, decimals: { [ADDR_B]: 6n } }),
    });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "wrapper-depeg-detected", severity: "warning" })]);
  });

  it("does not emit USD peg warnings for explicit wrapper dependencies", async () => {
    const { result } = await runBranches(makeBranchConfig([{
      ...usdcBranch(), name: "sUSDe branch", token: { chain: "ethereum", address: ADDR_B, decimals: 18 },
      risk: "medium", coinId: "usde-ethena", depType: "wrapper",
    }]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 1.23 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 50n * WAD }, decimals: { [ADDR_B]: 18n } }),
    });
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([{
      sourceKey: `evm-branch-balances:ethereum:${ADDR_B}`, name: "sUSDe branch", pct: 100, risk: "medium", coinId: "usde-ethena", depType: "wrapper",
    }]);
  });

  it("throws when a USD-pegged wrapper price is outside the 0.5-1.5 fatal band", async () => {
    await expect(runBranches(makeBranchConfig([usdcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 0.4 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 50_000_000n }, decimals: { [ADDR_B]: 6n } }),
    })).rejects.toThrow(/extreme depeg/);
  });

  it("does not warn when a USD-pegged wrapper trades within 5% of peg", async () => {
    const { result } = await runBranches(makeBranchConfig([usdcBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 1.02 }),
      rpc: branchRpc({ balances: { [ADDR_B]: 50_000_000n }, decimals: { [ADDR_B]: 6n } }),
    });
    expect(result.warnings).toBeUndefined();
  });

  it.each([
    { name: "params.branches is missing", branches: undefined },
    { name: "params.branches is empty", branches: [] as unknown[] },
    { name: "invalid fixed price overrides", branches: [{ name: "USYC", holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 6 }, risk: "low", priceUsd: 0 }] },
  ])("throws when $name", async ({ branches }) => {
    const network = installAdapterNetwork({ rpc: branchRpc() });
    await expect(runBranches(makeBranchConfig(branches), network)).rejects.toThrow("evm-branch-balances adapter params invalid");
    expect(network.rpcCalls).toEqual([]);
  });

  it("emits collateralizationRatio metadata when a debtSelector is configured", async () => {
    const { result } = await runBranches(
      makeBranchConfig([wbtcBranch({ holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 8 } })], {
        params: { debtSelector: "0x18160ddd", debtDecimals: 18, census: REVIEWED_CENSUS },
      }),
      {
        json: priceJson({ [assetKey("ethereum", ADDR_B)]: 60000 }),
        rpc: branchRpc({ balances: { [ADDR_B]: 100_000_000n }, decimals: { [ADDR_B]: 8n }, extra: { [`${ADDR_A}:totalSupply()`]: 50_000n * WAD } }),
      },
    );
    expect(result.metadata?.totalDebtUsd).toBe(50000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.2, 2);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it.each([
    ["reverted", null],
    ["oversized", `0x${"00".repeat(33)}`],
    ["non-hex", "0xnot-a-uint256"],
  ] as const)("withholds collateral when the configured liability read is %s", async (_label, debt) => {
    await expect(runBranches(
      makeBranchConfig([usdcBranch({ priceUsd: 1 })], { params: { debtSelector: "0x18160ddd", debtDecimals: 18 } }),
      { rpc: branchRpc({ balances: { [ADDR_B]: 100_000_000n }, decimals: { [ADDR_B]: 6n }, extra: { [`${ADDR_A}:totalSupply()`]: debt } }) },
    )).rejects.toThrow(/configured liability read/);
  });

  it("publishes observed zero debt without an undefined or infinite coverage quotient", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch({ priceUsd: 1 })], { params: { debtSelector: "0x18160ddd", debtDecimals: 18 } }),
      { rpc: branchRpc({ balances: { [ADDR_B]: 100_000_000n }, decimals: { [ADDR_B]: 6n }, extra: { [`${ADDR_A}:totalSupply()`]: 0n } }) },
    );
    expect(result.metadata?.totalDebtUsd).toBe(0);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("supports the USDN wstETH holder balance plus token supply debt shape", async () => {
    const wstEth = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
    const usdn = "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2";
    const { result } = await runBranches(
      makeBranchConfig([{
        name: "wstETH-backed USDN vault", holder: "0x656cb8c6d154aad29d8771384089be5b5141f01a",
        token: { chain: "ethereum", address: wstEth, decimals: 18 }, risk: "medium",
      }], { params: { debtSelector: "0x18160ddd", debtContract: usdn, debtDecimals: 18, census: REVIEWED_CENSUS } }),
      {
        json: priceJson({ [assetKey("ethereum", wstEth)]: 2879.58 }),
        rpc: branchRpc({
          balances: { [wstEth]: 729_665_660_446_827_366_025n }, decimals: { [wstEth]: 18n },
          extra: { [`${usdn}:totalSupply()`]: 1_256_625_428_863_930_548_011_778n },
        }),
      },
    );
    expect(result.slices).toEqual([{ sourceKey: `evm-branch-balances:ethereum:${wstEth}`, name: "wstETH-backed USDN vault", pct: 100, risk: "medium" }]);
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(1_256_625.43, 2);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("emits an undercollateralized warning when collateralizationRatio < 1.0", async () => {
    const { result } = await runBranches(
      makeBranchConfig([wbtcBranch({ holder: ADDR_A, token: { chain: "ethereum", address: ADDR_B, decimals: 8 } })], {
        params: { debtSelector: "0x18160ddd", debtDecimals: 18, census: REVIEWED_CENSUS },
      }),
      {
        json: priceJson({ [assetKey("ethereum", ADDR_B)]: 60000 }),
        rpc: branchRpc({ balances: { [ADDR_B]: 100_000_000n }, decimals: { [ADDR_B]: 8n }, extra: { [`${ADDR_A}:totalSupply()`]: 80_000n * WAD } }),
      },
    );
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.75, 2);
    expect(result.warnings?.find((w) => w.code === "undercollateralized")).toMatchObject({ severity: "warning" });
  });

  it("preserves wrapper depeg warnings when debt reconciliation also warns", async () => {
    const { result } = await runBranches(
      makeBranchConfig([usdcBranch()], { params: { debtSelector: "0x18160ddd", debtDecimals: 18, census: REVIEWED_CENSUS } }),
      {
        json: priceJson({ [assetKey("ethereum", ADDR_B)]: 0.9 }),
        rpc: branchRpc({ balances: { [ADDR_B]: 100_000_000n }, decimals: { [ADDR_B]: 6n }, extra: { [`${ADDR_A}:totalSupply()`]: 100n * WAD } }),
      },
    );
    expect(result.warnings?.map((w) => w.code)).toEqual(["wrapper-depeg-detected", "undercollateralized"]);
  });

  it("skips debt reconciliation when debtSelector is omitted", async () => {
    const { result, network } = await runBranches(makeBranchConfig([wstEthBranch()]), {
      json: priceJson({ [assetKey("ethereum", ADDR_B)]: 2000 }),
      rpc: branchRpc({ balances: { [ADDR_B]: WAD }, decimals: { [ADDR_B]: 18n } }),
    });
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalDebtUsd).toBeUndefined();
    expect(network.rpcCalls.filter((c) => c.method === "eth_call").map((c) => c.selector))
      .toEqual([BALANCE_OF_SELECTOR, DECIMALS_SELECTOR]);
  });
});

const CENSUS_NOW_SEC = Date.parse("2026-10-02T12:00:00Z") / 1000;
const fundedBAsset = "0xff4299bca0313c20a61dc5ed597739743bef3f6d";
const usd0Config = usual.liveReservesConfig as LiveReservesConfig;
const usd0Params = readBranchBalanceParams(usd0Config, "evm-branch-balances");

function addressArray(addresses: string[]): string {
  return abiWords(32n, BigInt(addresses.length), ...addresses.map(BigInt));
}

function usualNetwork(options: { failedBalance?: string; failedPrice?: string; registry?: string[] } = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    "0x43882c864a406d55411b8c166bca604709fdf624:0x43069d46": addressArray(options.registry ?? usd0Params.branches.map((b) => b.token.address)),
    "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5:totalSupply()": 100n * WAD,
  };
  for (const b of usd0Params.branches) {
    rpc[`${b.token.address}:balanceOf(address)`] = b.token.address === options.failedBalance
      ? null
      : b.coinId === "usdtb-ethena" ? 0n : (b.unclassifiedSelfReferential ? 20n : 10n) * 10n ** BigInt(b.token.decimals);
    rpc[`${b.token.address}:decimals()`] = BigInt(b.token.decimals);
    rpc[`0xb97e163ce6a8296f36112b042891cfe1e23c35bf:0x41976e09${b.token.address.slice(2).toLowerCase().padStart(64, "0")}`] =
      b.token.address === options.failedPrice ? null : WAD;
  }
  return { rpc };
}

const runUsual = (network: AdapterNetworkSpec) =>
  runAdapter("evm-branch-balances", "usd0-usual", { config: usd0Config, network, nowSec: CENSUS_NOW_SEC });

describe("branch reserve census and unavailable residual", () => {
  it("replays XUSD's pinned ten-token basket separately from its historical, undated DOC quote", async () => {
    const rpc: Record<string, AdapterRpcValue> = {};
    for (const read of [...xusdWire.reads, ...xusdDecimals.reads]) {
      if (read.method !== "eth_call") continue;
      const call = read.params[0] as { to: string; data: string };
      if ("result" in read.response) rpc[`${call.to}:${call.data}`] = read.response.result as string;
    }
    const header = xusdWire.block.result;
    const { result, network } = await runAdapter("evm-branch-balances", "xusd-babelfish", {
      config: babelFish.liveReservesConfig as LiveReservesConfig,
      nowSec: Date.parse("2026-10-07T20:47:43Z") / 1000,
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
    expect(network.rpcCalls.filter((c) => c.method === "eth_call").every((c) => c.block === "0x8dfda7")).toBe(true);
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
    expect(details.branchObservations.filter((e) => e.priceObservation.sourceKind === "configured-nominal")).toHaveLength(9);
    expect(details.branchObservations.find((e) => e.priceObservation.sourceKind === "market-api")?.priceObservation)
      .toMatchObject({ sourceLookup: "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db", quoteTimestamp: null, quoteConfidence: null });
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "defillama-quote-quality", effect: "degraded" }));
  });

  it("replays the pinned USD0 registry and positive circular claims without normalizing external legs", async () => {
    const rpc = usualNetwork().rpc!;
    for (const o of usualContext.branches) {
      rpc[`${o.token}:balanceOf(address)`] = BigInt(o.balanceRaw);
      rpc[`${o.token}:decimals()`] = BigInt(o.observedDecimals);
      if (o.priceUsd != null) {
        rpc[`0xb97e163ce6a8296f36112b042891cfe1e23c35bf:0x41976e09${o.token.slice(2).toLowerCase().padStart(64, "0")}`] = BigInt(Math.round(o.priceUsd * 1e18));
      }
    }
    for (const read of usualWire.result) {
      const call = read.params[0] as { to: string; data: string };
      rpc[`${call.to}:${call.data}`] = read.result;
    }
    rpc["0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5:totalSupply()"] = 545_000_000n * WAD;
    const { result } = await runAdapter("evm-branch-balances", "usd0-usual", {
      config: usd0Config, nowSec: Date.parse(usualWire.observedAt) / 1000,
      network: { rpc, block: { number: Number(usualWire.block.number), hash: usualWire.block.hash, timestamp: Date.parse(usualWire.block.timestamp) / 1000 } },
    });
    expect(result.metadata).toMatchObject({ censusComplete: true, valuationComplete: true, unknownExposurePct: 0, ratioWithheldReason: "self-referential-claims" });
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Self-referential claim (U0R)", pct: expect.closeTo(81.64068855601755, 8), risk: "very-high" }),
      expect.objectContaining({ name: "Self-referential claim (EVK Vault eUSD0-4)", pct: expect.closeTo(2.8507035858793603, 8), risk: "very-high" }),
    ]));
    expect(result.slices.filter((s) => s.name.startsWith("Self-referential")).every((s) => s.coinId == null && s.depType == null)).toBe(true);
    expectWarnings(result, ["self-referential-reserve"]);
    expect(result.warnings?.[0]).toMatchObject({ effect: "degraded" });
    const details = result.metadata?.details as { knownReserveValueUsd: number; selfReferentialValueUsd: number };
    expect(details.selfReferentialValueUsd).toBeCloseTo(460_559_717.41, 1);
    expect(details.knownReserveValueUsd).toBeCloseTo(84_536_896.26, 1);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
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
    for (const b of usd0Params.branches.filter((e) => e.unclassifiedSelfReferential)) {
      network.rpc![`${b.token.address}:balanceOf(address)`] = 0n;
    }
    const { result } = await runUsual(network);
    expect(result.metadata).toMatchObject({ censusComplete: true, valuationComplete: true, unknownExposurePct: 0 });
    expect(result.metadata?.details).toMatchObject({ unclassifiedSelfReferentialBranches: [] });
  });

  it("includes a newly funded verified BabelFish bAsset before normalizing the basket", async () => {
    const config = babelFish.liveReservesConfig as LiveReservesConfig;
    const params = readBranchBalanceParams(config, "evm-branch-balances");
    const rpc: Record<string, AdapterRpcValue> = { "0xb5999795be0ebb5bab23144aa5fd6a02d080299f:totalSupply()": 108n * WAD };
    for (const b of params.branches) {
      rpc[`${b.token.address}:balanceOf(address)`] = (b.token.address === fundedBAsset ? 99n : 1n) * WAD;
      rpc[`${b.token.address}:decimals()`] = 18n;
    }
    const { result } = await runAdapter("evm-branch-balances", "xusd-babelfish", {
      config, nowSec: CENSUS_NOW_SEC,
      network: {
        rpc, block: { timestamp: CENSUS_NOW_SEC },
        json: {
          "https://coins.llama.fi/prices/current/rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": {
            coins: { "rootstock:0xe700691da7b9851f2f35f8b8182c69c53ccad9db": { price: 1, timestamp: CENSUS_NOW_SEC, confidence: 0.99 } },
          },
        },
      },
    });
    expect(result.slices.find((s) => s.sourceKey?.endsWith(fundedBAsset))?.pct).toBeCloseTo((99 / 108) * 100, 10);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 0, collateralizationRatio: 1 });
  });

  it("withholds reserve weights rather than deriving missing collateral from liabilities", async () => {
    const failedBalance = usd0Params.branches.find((b) => b.coinId === "usyc-hashnote")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedBalance }));
    expect(result.slices).toEqual([UNKNOWN_SLICE]);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 100, valuationComplete: false });
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "branch-reserve-book-partial", effect: "degraded" }));
  });

  it("keeps an unpriced constituent unavailable instead of deleting it from the denominator", async () => {
    const failedPrice = usd0Params.branches.find((b) => b.coinId === "ustbl-spiko")!.token.address;
    const { result } = await runUsual(usualNetwork({ failedPrice }));
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.slices.some((s) => s.coinId === "ustbl-spiko")).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it.each(["extra", "replacement", "removed", "duplicate", "unreadable"])("rejects a %s on-chain registry rather than certifying configured rows", async (change) => {
    const registry = usd0Params.branches.map((b) => b.token.address);
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
    const config = { ...usd0Config, params: { ...usd0Config.params, branches: [branch], census: { ...usd0Params.census, identity: "holder" } } } as LiveReservesConfig;
    const accepted = await runAdapter("evm-branch-balances", "usd0-usual", { config, network: usualNetwork({ registry: [branch.holder] }), nowSec: CENSUS_NOW_SEC });
    expect(accepted.result.metadata).toMatchObject({ censusComplete: true, unknownExposurePct: 0, collateralizationRatio: 0.1 });
    await expect(runAdapter("evm-branch-balances", "usd0-usual", { config, network: usualNetwork({ registry: [branch.token.address] }), nowSec: CENSUS_NOW_SEC }))
      .rejects.toThrow(/reserve registry drift/);
  });

  it("keeps observed zero USDtb distinct from USD0-denominated circular claims", async () => {
    const { result } = await runUsual(usualNetwork());
    expect(result.metadata).toMatchObject({ censusComplete: true, unknownExposurePct: 0 });
    expect(result.slices.some((s) => s.name === "U0R" || s.name === "EVK Vault eUSD0-4")).toBe(false);
    expect(result.slices.filter((s) => s.selfReferential).map((s) => s.name).sort())
      .toEqual(["Self-referential claim (EVK Vault eUSD0-4)", "Self-referential claim (U0R)"]);
    const details = result.metadata?.details as {
      branchObservations: Array<{ name: string; balanceRaw: string | null }>;
      unavailableBranches: Array<{ name: string; reason: string }>;
      unclassifiedSelfReferentialBranches: string[];
    };
    expect(details.branchObservations.find((e) => e.name.startsWith("USDtb"))?.balanceRaw).toBe("0");
    expect(details.unavailableBranches).toEqual([]);
    expect(details.unclassifiedSelfReferentialBranches.sort()).toEqual(["EVK Vault eUSD0-4", "U0R"]);
  });

  it("preserves a partial book without a denominator as unknown, not a normalized known-only mix", () => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [{ branch, balanceRaw: 10n ** BigInt(branch.token.decimals) }, { branch: usd0Params.branches[1], balanceRaw: null }],
    });
    expect(result.slices).toEqual([UNKNOWN_SLICE]);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 100, unknownExposureUnavailableReason: "partial-book-without-residual-bound" });
  });

  it.each([undefined, 20, 100, 1000])("never uses liabilities %s to bound a partial collateral book", (liabilityUsd) => {
    const branch = usd0Params.branches[0];
    const result = adaptBranchBalanceReserves({
      adapterKey: "evm-branch-balances", priceMap: new Map([[branch.name, 1]]),
      balances: [
        { branch, balanceRaw: 40n * 10n ** BigInt(branch.token.decimals), observedDecimals: BigInt(branch.token.decimals) },
        { branch: usd0Params.branches[1], balanceRaw: null },
      ],
      censusComplete: true, liabilityUsd,
    });
    expect(result.slices).toEqual([UNKNOWN_SLICE]);
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

const optBranch = (name: string, chain = "optimism", tokenAddress = token) => ({
  name, chain, holder, token: { chain, address: tokenAddress, decimals: 6 }, risk: "low", priceUsd: 1,
});

async function runOpt(branches: unknown[], network: AdapterNetworkSpec = {}, options: { validate?: false } = {}) {
  return runAdapter("evm-branch-balances", "jpyt-dephaser", {
    network: { block: { number: 100, timestamp: 1_800_000_000 }, ...network },
    config: makeBranchConfig(branches, { chain: "optimism" }),
    nowSec: 1_800_000_000,
    ...(options.validate === false ? { validate: false as const } : {}),
  });
}

describe("branch multichain and receipt observations", () => {
  it("aggregates holdings using each chain's pinned block", async () => {
    const { result, network } = await runOpt([optBranch("USDT"), optBranch("USDC", "base")], {
      rpc: { [`optimism:${token}:${BALANCE_OF_SELECTOR}`]: 75_000_000n, [`base:${token}:${BALANCE_OF_SELECTOR}`]: 25_000_000n, [`${token}:decimals()`]: 6n },
    });
    expect(result.slices.map(({ name, pct }) => ({ name, pct }))).toEqual([{ name: "USDT", pct: 75 }, { name: "USDC", pct: 25 }]);
    expect(result.metadata?.details?.observedBlocks).toEqual([
      { chain: "optimism", number: 100, timestamp: 1_800_000_000 },
      { chain: "base", number: 100, timestamp: 1_800_000_000 },
    ]);
    expect(network.rpcCalls.filter((c) => c.chain === "base" && c.viaMulticall).length).toBeGreaterThan(0);
  });

  it("converts aggregate cToken claims before pricing and retains the receipt decimals gate", async () => {
    const receipt = {
      ...optBranch("meUSDC"), token: { chain: "optimism", address: token, decimals: 8 },
      priceToken: { chain: "optimism", address: underlying }, receipt: { kind: "compound-v2" },
      balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] },
    };
    const makeNetwork = (aggregateDecimals: bigint): AdapterNetworkSpec => ({
      rpc: {
        [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 100n * 10n ** 8n,
        [`${token}:decimals()`]: aggregateDecimals, [`${usdcToken}:decimals()`]: 6n,
        [`${usdcToken}:${BALANCE_OF_SELECTOR}`]: 2_327_425n, [`${token}:0x182df0f5`]: 232_742_590_670_167n,
        [`${token}:0x6f307dc3`]: BigInt(underlying), [`${underlying}:decimals()`]: 6n,
      },
    });

    const accepted = await runOpt([receipt, optBranch("USDC", "optimism", usdcToken)], makeNetwork(8n), { validate: false });
    expect(accepted.result.slices.map(({ pct }) => pct)).toEqual([50, 50]);
    expect(hasFatalWarnings(accepted.result.warnings)).toBe(false);

    const rejected = await runOpt([receipt, optBranch("USDC", "optimism", usdcToken)], makeNetwork(18n), { validate: false });
    expect(hasFatalWarnings(rejected.result.warnings)).toBe(true);
    expect(rejected.result.warnings).toContainEqual(expect.objectContaining({ code: "branch-token-decimals-mismatch" }));
  });

  it("keeps aggregate decimals checks on individual fallback and rejects receipt identity drift", async () => {
    const makeNetwork = (withReceipt: boolean): AdapterNetworkSpec => ({
      multicall: false,
      rpc: {
        "0x82ad56cb": null, [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 1_000_000n,
        [`${token}:decimals()`]: 18n, [`${token}:0x182df0f5`]: 1_000_000n, [`${token}:0x6f307dc3`]: 1_000_000n,
        ...(withReceipt ? { [`${underlying}:decimals()`]: 6n } : {}),
      },
    });
    const aggregate = { ...optBranch("USDC"), balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] } };
    const drifted = await runOpt([aggregate], makeNetwork(false), { validate: false });
    expect(hasFatalWarnings(drifted.result.warnings)).toBe(true);

    const withReceipt = { ...aggregate, receipt: { kind: "compound-v2" }, priceToken: { chain: "optimism", address: underlying } };
    await expect(runOpt([withReceipt], makeNetwork(true))).rejects.toThrow("underlying identity");
  });

  it("scales 18-decimal underlying claims and rejects missing conversion rates", async () => {
    const receipt = {
      ...optBranch("mewETH"), token: { chain: "optimism", address: token, decimals: 8 },
      priceUsd: 2_000, priceToken: { chain: "optimism", address: underlying },
      receipt: { kind: "compound-v2", exchangeRateSelector: "0x12345678" },
    };
    let rate: bigint | null = 2n * 10n ** 26n;
    const network: AdapterNetworkSpec = {
      rpc: {
        [`${holder}:0xa5fdc5de${word(BigInt(token)).slice(2)}`]: 10n * 10n ** 8n,
        [`${token}:0x70a08231`]: 10n * 10n ** 8n, [`${usdcToken}:decimals()`]: 6n,
        [`${usdcToken}:${BALANCE_OF_SELECTOR}`]: 100_000_000n, [`${token}:0x12345678`]: () => rate,
        [`${token}:0x6f307dc3`]: BigInt(underlying), [`${underlying}:decimals()`]: 18n,
      },
    };
    const priced = await runOpt([receipt, optBranch("USDC", "optimism", usdcToken)], network);
    expect(priced.result.slices.map(({ pct }) => pct)).toEqual([80, 20]);
    rate = null;
    await expect(runOpt([receipt], network)).rejects.toThrow("exchange rate unavailable");
  });
});

const POOL = "0x1116898dda4015ed8ddefb84b6e8bc24528af2d8";
const TOKENS = [
  { name: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, price: 0.9995 },
  { name: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, price: 1.0001 },
  { name: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, price: 1.0002 },
];
const LP_BALANCE = toFunctionSelector("getTokenBalance(uint8)");

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
  for (const [i, t] of TOKENS.entries()) {
    rpc[`${POOL}:${LP_BALANCE}${BigInt(i).toString(16).padStart(64, "0")}`] = i === options.missingBalance ? null : snapshot.lp[i];
    rpc[`${t.address}:balanceOf(address)`] = snapshot.raw[i];
    rpc[`${t.address}:decimals()`] = i === options.wrongDecimals ? 18n : BigInt(t.decimals);
    if (i !== options.missingPrice) coins[`ethereum:${t.address}`] = { price: t.price, timestamp: snapshot.timestamp, confidence: 0.99 };
  }
  return {
    block: { number: snapshot.block, timestamp: snapshot.timestamp }, multicall: options.multicall, rpc,
    json: { [`${PRICES_BASE}/${TOKENS.filter((_, i) => i !== options.missingBalance).map((t) => `ethereum:${t.address}`).sort().join(",")}`]: { coins } },
  };
}

const pricedValue = (amount: bigint, index: number) => Number(amount) / 10 ** TOKENS[index].decimals * TOKENS[index].price;

describe("nUSD LP-attributable reserve observation", () => {
  for (const snapshot of SNAPSHOTS) {
    it.each([true, false])(`excludes ${snapshot.label} admin balances with multicall=%s at one pinned block`, async (multicall) => {
      const { result, network } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall }), nowSec: snapshot.timestamp,
      });
      const lpValue = snapshot.lp.reduce((sum, amt, i) => sum + pricedValue(amt, i), 0);
      const adminValue = snapshot.admin.reduce((sum, amt, i) => sum + pricedValue(amt, i), 0);
      const rawValue = snapshot.raw.reduce((sum, amt, i) => sum + pricedValue(amt, i), 0);
      expect(rawValue - lpValue).toBeCloseTo(adminValue, 7);
      const details = result.metadata!.details as { knownReserveValueUsd: number; branchObservations: Array<{ name: string; balanceRaw: string }> };
      expect(Math.abs(details.knownReserveValueUsd - lpValue)).toBeLessThanOrEqual(0.0000015);
      expect(details.branchObservations.map((r) => r.balanceRaw)).toEqual(snapshot.lp.map(String));
      expect(result.slices).toHaveLength(3);
      expect(result.slices).toEqual(expect.arrayContaining(TOKENS.map((t, i) => expect.objectContaining({
        name: t.name, pct: expect.closeTo(pricedValue(snapshot.lp[i], i) / lpValue * 100, 8),
      }))));
      expect(result.metadata).toMatchObject({
        observedBlock: { chain: "ethereum", number: snapshot.block, timestamp: snapshot.timestamp },
        valuationComplete: true, censusComplete: false, unknownExposureUnavailableReason: "configured-branches-not-certified-census",
      });
      expect(result.metadata!.collateralizationRatio).toBeUndefined();
      const reads = network.rpcCalls.filter((c) => c.method === "eth_call");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((c) => c.block === `0x${snapshot.block.toString(16)}`)).toBe(true);
    });
  }

  for (const missingBalance of [0, 1, 2]) {
    it.each([true, false])(`withholds weights when LP branch ${missingBalance} is unavailable, multicall=%s`, async (multicall) => {
      const snapshot = SNAPSHOTS[1];
      const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall, missingBalance }), nowSec: snapshot.timestamp,
      });
      expect(result.slices).toEqual([UNKNOWN_SLICE]);
      expect(result.metadata).toMatchObject({ valuationComplete: false, censusComplete: false, unknownExposurePct: 100 });
      expect(result.metadata!.details).toMatchObject({
        contextualObservationsOnly: true, unavailableBranches: [{ name: TOKENS[missingBalance].name, reason: "balance-unavailable" }],
      });
      expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch-reserve-book-partial" })]));
    });
  }

  it("withholds weights when a positive LP constituent is unpriced", async () => {
    const snapshot = SNAPSHOTS[1];
    const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
      network: networkFor(snapshot, { missingPrice: 1 }), nowSec: snapshot.timestamp,
    });
    expect(result.slices).toEqual([UNKNOWN_SLICE]);
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
