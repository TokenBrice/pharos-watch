import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiquityV2Warnings,
  buildLiquityV2RedemptionMetadata,
  fetchLiquityV2BranchReserves,
} from "../liquity-v2-branches";
import {
  expectValidAdapterOutput,
  expectWarningEffect,
  expectWarnings,
  installAdapterNetwork,
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";

const NOW = 1_788_991_200;
const WAD = 10n ** 18n;
const BLOCK = { number: 23_456_789, timestamp: NOW };

const DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
const SHUTDOWN_SELECTOR = "0x06ff8dfb"; // hasBeenShutDown()
const BRANCH_PRICE_SELECTOR = "0x0fdb11cf"; // fetchPrice()
const REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()
const MECHANISM_PRICE_SELECTOR = "0x4ea15f37"; // getUnbackedPortionPriceAndDecayAndRedeemability
const STABILITY_POOL_DEPOSITS_SELECTOR = "0xf71c6940";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const DECIMALS_SELECTOR = "0x313ce567";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const AGGREGATE3_SELECTOR = "0x82ad56cb";

const bold = resolveAdapterCoin("liquity-v2-branches", "bold-liquity");
const boldParams = parseLiveReserveAdapterParams("liquity-v2-branches", bold.config.params);
const boldProbe = boldParams.redemptionRateProbe!;
const boldMechanism = boldParams.mechanismMetrics!;

const nect = resolveAdapterCoin("liquity-v2-branches", "nect-beraborrow");
const nectParams = parseLiveReserveAdapterParams("liquity-v2-branches", nect.config.params);
const wberaBranch = nectParams.branches.find((branch) => branch.name === "WBERA")!;
const pumpBtcBranch = nectParams.branches.find((branch) => branch.name === "pumpBTC")!;

afterEach(() => vi.unstubAllGlobals());

function llamaUrl(tokens: ReadonlyArray<{ chain: string; address: string }>): string {
  const keys = tokens.map((token) => `${token.chain}:${token.address.toLowerCase()}`);
  return `https://coins.llama.fi/prices/current/${[...new Set(keys)].sort().join(",")}`;
}

function encodeUint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Three-word getUnbackedPortionPriceAndDecayAndRedeemability payload: (_, price, redeemable). */
function encodeMechanismPrice(price: bigint, redeemable: boolean): string {
  return `0x${encodeUint(0n).slice(2)}${encodeUint(price).slice(2)}${encodeUint(redeemable ? 1n : 0n).slice(2)}`;
}

function boldCoinQuotes(pricesByName: Record<string, number>) {
  const coins: Record<string, { price: number; timestamp: number; confidence: number }> = {};
  for (const branch of boldParams.branches) {
    const price = pricesByName[branch.name];
    if (price != null) {
      coins[`ethereum:${branch.token.address.toLowerCase()}`] = { price, timestamp: NOW, confidence: 1 };
    }
  }
  return { coins };
}

const BOLD_LLAMA_URL = llamaUrl(boldParams.branches.map((branch) => branch.token));
const BOLD_FULL_QUOTES = boldCoinQuotes({
  "wstETH (Lido)": 2_000,
  WETH: 1_800,
  "rETH (Rocket Pool)": 1_900,
});

function boldBranchRpc(entries: {
  balances: Map<string, bigint>;
  debts: Map<string, bigint | null>;
  feeRaw: bigint | null;
}): Record<string, AdapterRpcValue> {
  const rpc: Record<string, AdapterRpcValue> = {};
  for (const branch of boldParams.branches) {
    rpc[`${branch.token.address}:balanceOf(address)`] = entries.balances.get(branch.name) ?? 0n;
    rpc[`${branch.holder}:${DEBT_SELECTOR}`] = entries.debts.get(branch.name) ?? null;
    rpc[`${branch.holder}:${SHUTDOWN_SELECTOR}`] = false;
    // No branch is an ERC4626 wrapper: the share-adaptation probe must fail.
    rpc[`${branch.token.address}:asset()`] = null;
  }
  rpc[`${boldProbe.contract}:${REDEMPTION_RATE_SELECTOR}`] = entries.feeRaw;
  return rpc;
}

function boldMechanismRpc(entries: {
  totalSupply: bigint | null;
  prices: Map<string, bigint>;
  redeemable: Map<string, boolean>;
  deposits: Map<string, bigint>;
}): Record<string, AdapterRpcValue> {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${boldMechanism.supplyTokenAddress}:totalSupply()`]: entries.totalSupply,
  };
  for (const binding of boldMechanism.branches) {
    rpc[`${binding.troveManagerAddress}:${MECHANISM_PRICE_SELECTOR}`] = encodeMechanismPrice(
      entries.prices.get(binding.name) ?? 0n,
      entries.redeemable.get(binding.name) ?? true,
    );
    rpc[`${binding.stabilityPoolAddress}:${STABILITY_POOL_DEPOSITS_SELECTOR}`] =
      entries.deposits.get(binding.name) ?? 0n;
  }
  return rpc;
}

/** Every Liquity read arrives as individual eth_calls: Multicall3 is unavailable. */
function boldFallbackNetwork(debts: Map<string, bigint | null>): AdapterNetworkSpec {
  return {
    multicall: false,
    block: BLOCK,
    rpc: {
      ...boldBranchRpc({
        balances: new Map(boldParams.branches.map((branch) => [branch.name, 1_000n * WAD])),
        debts,
        feeRaw: null,
      }),
      [AGGREGATE3_SELECTOR]: null,
    },
    json: { [BOLD_LLAMA_URL]: BOLD_FULL_QUOTES },
  };
}

describe("buildLiquityV2RedemptionMetadata", () => {
  const branch = {
    name: "WETH",
    holder: "0x1111111111111111111111111111111111111111",
    token: {
      chain: "ethereum",
      address: "0x2222222222222222222222222222222222222222",
      decimals: 18,
    },
    risk: "very-low" as const,
  };

  it("publishes same-run direct redemption capacity from active-pool debt", () => {
    const metadata = buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: 52,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 1_250_000_000_000_000_000_000n,
          shutDown: false,
          redemptionFeeBps: 52,
        },
      ],
    });

    expect(metadata).toMatchObject({
      redemption: {
        capacityUsd: 1250,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.liquity.org/v2-faq/redemptions-and-delegation",
          "https://docs.liquity.org/v2-faq/technical-resources",
        ],
        feeBps: 52,
      },
      details: {
        proofKind: "liquity-v2-active-pool-debt",
      },
    });
  });

  it("degrades route status when a branch is shut down", () => {
    const metadata = buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: null,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 1_250_000_000_000_000_000_000n,
          shutDown: true,
          redemptionFeeBps: null,
        },
      ],
    });

    expect(metadata.redemption).toMatchObject({
      routeStatus: "degraded",
    });
  });

  it("excludes protocol-disabled branches from immediate redemption capacity", () => {
    const rEthBranch = {
      ...branch,
      name: "rETH (Rocket Pool)",
      holder: "0x3333333333333333333333333333333333333333",
    };
    const metadata = buildLiquityV2RedemptionMetadata(
      {
        balances: [
          { branch, balanceRaw: 2_000_000_000_000_000_000n },
          { branch: rEthBranch, balanceRaw: 1_000_000_000_000_000_000n },
        ],
        redemptionFeeBps: 50,
        debts: [
          {
            entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
            debtRaw: 1_250_000_000_000_000_000_000n,
            shutDown: false,
            redemptionFeeBps: null,
          },
          {
            entry: { branch: rEthBranch, balanceRaw: 1_000_000_000_000_000_000n },
            debtRaw: 750_000_000_000_000_000_000n,
            shutDown: false,
            redemptionFeeBps: null,
          },
        ],
      },
      18,
      ["https://example.com/reviewed-source"],
      new Map([
        ["WETH", true],
        ["rETH (Rocket Pool)", false],
      ]),
    );

    expect(metadata).toMatchObject({
      totalDebtUsd: 2_000,
      redemption: {
        capacityUsd: 1_250,
        routeStatus: "degraded",
      },
      details: {
        nonRedeemableBranches: ["rETH (Rocket Pool)"],
        branchDebt: [
          expect.objectContaining({ name: "WETH", redeemable: true }),
          expect.objectContaining({ name: "rETH (Rocket Pool)", redeemable: false }),
        ],
      },
    });
  });

  it("leaves redemption unrated when required branch redeemability is unreadable", () => {
    const metadata = buildLiquityV2RedemptionMetadata(
      {
        balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
        redemptionFeeBps: 50,
        debts: [
          {
            entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
            debtRaw: 1_250_000_000_000_000_000_000n,
            shutDown: false,
            redemptionFeeBps: null,
          },
        ],
      },
      18,
      ["https://example.com/reviewed-source"],
      null,
    );

    expect(metadata.totalDebtUsd).toBe(1_250);
    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.redemption).toBeUndefined();
    expect(metadata.details).toMatchObject({
      unreadableRedeemabilityBranches: ["WETH"],
      branchDebt: [expect.objectContaining({ name: "WETH", redeemable: null })],
    });
  });

  it("marks unreadable shutdown status as unknown and emits a degraded warning", () => {
    const snapshot = {
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: null,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 1_250_000_000_000_000_000_000n,
          shutDown: null,
          redemptionFeeBps: null,
        },
      ],
    };
    const metadata = buildLiquityV2RedemptionMetadata(snapshot);
    const warnings = buildLiquityV2Warnings(snapshot);

    expect(metadata.redemption).toMatchObject({
      routeStatus: "unknown",
    });
    expectWarnings({ warnings }, ["redemption-route-status-unreadable"]);
    expectWarningEffect({ warnings }, "redemption-route-status-unreadable", "degraded");
  });

  it("fails closed when active-pool debt is zero", () => {
    expect(() => buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: null,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 0n,
          shutDown: false,
          redemptionFeeBps: null,
        },
      ],
    })).toThrow(/active-pool debt/);
  });
});

describe("Base Dollar production bindings", () => {
  const config = resolveAdapterCoin("liquity-v2-branches", "bd-basedollar").config;
  const params = config.params as {
    rpcUrl: string;
    fallbackRpcUrl: string;
    sourceUrls: string[];
    redemptionRateProbe: { contract: string; selector: string };
    branches: Array<{
      name: string;
      holder: string;
      token: { chain: string; address: string; decimals: number };
      priceToken?: { chain: string; address: string };
    }>;
    mechanismMetrics: {
      supplyTokenAddress: string;
      branchPriceSelector: string;
      stabilityPoolDepositsSelector: string;
      branches: Array<{
        name: string;
        troveManagerAddress: string;
        stabilityPoolAddress: string;
      }>;
    };
  };

  it("pins all five launch branches to the production ActivePools and mechanism contracts", () => {
    expect(config.inputs.primary).toMatchObject({ kind: "onchain-evm", chain: "base", rpcMode: "alchemy" });
    expect(params).toMatchObject({
      rpcUrl: "https://mainnet.base.org",
      fallbackRpcUrl: "https://base-rpc.publicnode.com",
      redemptionRateProbe: {
        contract: "0x7551ebfc8340b7f91874942be9c653733d4fb04f",
        selector: "0xc52861f2",
      },
      mechanismMetrics: {
        supplyTokenAddress: "0x252d36f435582ecb01686448d21e8c9ea0b2ca65",
        branchPriceSelector: MECHANISM_PRICE_SELECTOR,
        stabilityPoolDepositsSelector: STABILITY_POOL_DEPOSITS_SELECTOR,
      },
    });
    expect(params.sourceUrls).toEqual(expect.arrayContaining([
      expect.stringContaining("contracts/script/DeployLiquity2.s.sol"),
      expect.stringContaining("contracts/broadcast/DeployLiquity2.s.sol/8453/run-latest.json"),
    ]));
    expect(params.branches).toMatchObject([
      {
        name: "WETH",
        holder: "0x254a8267d4e12a8c0f283274632a18a33e49f7c0",
        token: { chain: "base", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      },
      {
        name: "wstETH (Lido)",
        holder: "0x1021fefc406c9573ab3579fc55be13e3300ef6b1",
        token: { chain: "base", address: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", decimals: 18 },
      },
      {
        name: "rETH (Rocket Pool)",
        holder: "0x1b9a62798e8bae0cea4eb21b4b3775359beb819f",
        token: { chain: "base", address: "0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c", decimals: 18 },
      },
      {
        name: "cbBTC (Coinbase)",
        holder: "0xcaa72df531554087318eaf24646958500668b230",
        token: { chain: "base", address: "0x92a7aee8afaa71ba0a9cc04a3dbe1f34237c33e0", decimals: 18 },
        priceToken: { chain: "base", address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" },
      },
      {
        name: "cbETH (Coinbase)",
        holder: "0xddac84ab417677f553cced8ababf497226112218",
        token: { chain: "base", address: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", decimals: 18 },
      },
    ]);
    expect(params.mechanismMetrics.branches).toMatchObject([
      {
        name: "WETH",
        troveManagerAddress: "0xa957d42c4c43eb97d5f71b8435eb638e5dd9f639",
        stabilityPoolAddress: "0x7d837bf114785642d225d1101145ddb8af4ba438",
      },
      {
        name: "wstETH (Lido)",
        troveManagerAddress: "0x79a6a3361eae4d4b80939206426f2320c11a4bfb",
        stabilityPoolAddress: "0xc65a05737d31e0f42c0806c739f3c88dd009c05f",
      },
      {
        name: "rETH (Rocket Pool)",
        troveManagerAddress: "0xd31987fcba98f471b6e4220c52f7741b11b2fc5e",
        stabilityPoolAddress: "0x4eb3b6970fd358d34195b5d40e4eb64e0e3c0b6a",
      },
      {
        name: "cbBTC (Coinbase)",
        troveManagerAddress: "0x835b04eefbb0e32d8f75cfe96acb527a42f1a0d9",
        stabilityPoolAddress: "0x6bd55dd953507641c84a03956760f83d29d65726",
      },
      {
        name: "cbETH (Coinbase)",
        troveManagerAddress: "0x482de97e667330afba99f8ced527118aec66f15d",
        stabilityPoolAddress: "0x25afbb09d9804482ed8e24295be4a12704fe93ea",
      },
    ]);
    expect(params.mechanismMetrics.branches.map((entry) => entry.name)).toEqual(
      params.branches.map((entry) => entry.name),
    );
  });
});

describe("fetchLiquityV2BranchReserves BOLD mechanism metrics", () => {
  it("binds every configured reserve branch to a TroveManager and Stability Pool", () => {
    expect(bold.config.adapter).toBe("liquity-v2-branches");
    expect(bold.config.version).toBe(2);
    expect(boldMechanism).toMatchObject({
      supplyTokenAddress: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      branchPriceSelector: MECHANISM_PRICE_SELECTOR,
      stabilityPoolDepositsSelector: STABILITY_POOL_DEPOSITS_SELECTOR,
    });
    expect(boldMechanism.branches.map((entry) => entry.name).sort()).toEqual(
      boldParams.branches.map((entry) => entry.name).sort(),
    );
  });

  it("publishes mechanism metrics and excludes a protocol-disabled branch from redemption capacity", async () => {
    const { result, network } = await runAdapter("liquity-v2-branches", "bold-liquity", {
      network: {
        block: BLOCK,
        rpc: {
          ...boldBranchRpc({
            balances: new Map([
              ["wstETH (Lido)", 20_000n * WAD],
              ["WETH", 8_000n * WAD],
              ["rETH (Rocket Pool)", 5_000n * WAD],
            ]),
            debts: new Map([
              ["wstETH (Lido)", 17_000_000n * WAD],
              ["WETH", 8_000_000n * WAD],
              ["rETH (Rocket Pool)", 5_000_000n * WAD],
            ]),
            feeRaw: 5n * 10n ** 15n,
          }),
          ...boldMechanismRpc({
            totalSupply: 30_000_000n * WAD,
            prices: new Map([
              ["wstETH (Lido)", 2_000n * WAD],
              ["WETH", 1_800n * WAD],
              ["rETH (Rocket Pool)", 1_900n * WAD],
            ]),
            redeemable: new Map([["rETH (Rocket Pool)", false]]),
            deposits: new Map([
              ["wstETH (Lido)", 12_000_000n * WAD],
              ["WETH", 10_000_000n * WAD],
              ["rETH (Rocket Pool)", 3_000_000n * WAD],
            ]),
          }),
        },
        json: { [BOLD_LLAMA_URL]: BOLD_FULL_QUOTES },
      },
      nowSec: NOW,
    });

    expect(result.slices.map((slice) => slice.name)).toEqual(["wstETH (Lido)", "WETH", "rETH (Rocket Pool)"]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(63_900_000, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(2.13, 6);
    expect(result.metadata?.liquidationCapacityRatio).toBeCloseTo(25 / 30, 6);
    expect(result.metadata?.totalDebtUsd).toBe(30_000_000);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 25_000_000,
      routeStatus: "degraded",
      feeBps: 50,
    });
    expect(result.metadata?.details).toMatchObject({
      proofKind: "liquity-v2-active-pool-debt",
      nonRedeemableBranches: ["rETH (Rocket Pool)"],
      mechanismMetrics: {
        proofKind: "liquity-v2-protocol-priced-system-state",
        totalSupplyRaw: (30_000_000n * WAD).toString(),
        totalDebtRaw: (30_000_000n * WAD).toString(),
        totalStabilityPoolDepositsRaw: (25_000_000n * WAD).toString(),
        branchCappedLiquidationCapacityRatio: 23 / 30,
      },
    });
    expectWarnings(result, []);
    const mechanismContracts = new Set<string>([
      boldMechanism.supplyTokenAddress.toLowerCase(),
      ...boldMechanism.branches.flatMap((binding) => [
        binding.troveManagerAddress.toLowerCase(),
        binding.stabilityPoolAddress.toLowerCase(),
      ]),
    ]);
    const mechanismCalls = network.rpcCalls.filter((call) => mechanismContracts.has(call.contract));
    expect(mechanismCalls.map((call) => call.selector)).toEqual([
      TOTAL_SUPPLY_SELECTOR,
      ...boldMechanism.branches.flatMap((_binding) => [
        MECHANISM_PRICE_SELECTOR,
        STABILITY_POOL_DEPOSITS_SELECTOR,
      ]),
    ]);
    expect(mechanismCalls.every((call) => call.viaMulticall)).toBe(true);
  });

  it("keeps reserves but leaves redemption unrated when branch redeemability is unreadable", async () => {
    const { result } = await runAdapter("liquity-v2-branches", "bold-liquity", {
      network: boldFallbackNetwork(new Map(boldParams.branches.map((branch) => [branch.name, 1_000_000n * WAD as bigint]))),
      nowSec: NOW,
    });

    expect(result.slices).toHaveLength(3);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.liquidationCapacityRatio).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details).toMatchObject({
      unreadableRedeemabilityBranches: ["wstETH (Lido)", "WETH", "rETH (Rocket Pool)"],
    });
    expectWarnings(result, [
      "liquity-v2-mechanism-metrics-unavailable",
      "liquity-v2-redeemability-unavailable",
    ]);
    expectWarningEffect(result, "liquity-v2-mechanism-metrics-unavailable", "info");
    expectWarningEffect(result, "liquity-v2-redeemability-unavailable", "degraded");
  });

  it("keeps redemption rated when optional solvency metrics fail after redeemability is readable", async () => {
    const { result } = await runAdapter("liquity-v2-branches", "bold-liquity", {
      network: {
        block: BLOCK,
        rpc: {
          ...boldBranchRpc({
            balances: new Map(boldParams.branches.map((branch) => [branch.name, 1_000n * WAD])),
            debts: new Map(boldParams.branches.map((branch) => [branch.name, 1_000_000n * WAD as bigint])),
            feeRaw: 5n * 10n ** 15n,
          }),
          ...boldMechanismRpc({
            totalSupply: null,
            prices: new Map(boldParams.branches.map((branch) => [branch.name, 2_000n * WAD])),
            redeemable: new Map(),
            deposits: new Map(boldParams.branches.map((branch) => [branch.name, 500_000n * WAD])),
          }),
        },
        json: { [BOLD_LLAMA_URL]: BOLD_FULL_QUOTES },
      },
      nowSec: NOW,
    });

    expect(result.slices).toHaveLength(3);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 3_000_000,
      routeStatus: "open",
      feeBps: 50,
    });
    expectWarnings(result, ["liquity-v2-mechanism-metrics-unavailable"]);
    expectWarningEffect(result, "liquity-v2-mechanism-metrics-unavailable", "info");
  });

  it("rejects shape drift when a branch debt read disappears", async () => {
    const debts = new Map<string, bigint | null>(
      boldParams.branches.map((branch) => [branch.name, branch.name === "WETH" ? null : 1_000_000n * WAD]),
    );
    await expect(
      runAdapter("liquity-v2-branches", "bold-liquity", {
        network: boldFallbackNetwork(debts),
        nowSec: NOW,
      }),
    ).rejects.toThrow(/active-pool debt/);
  });
});

describe("fetchLiquityV2BranchReserves Beraborrow branches", () => {
  const WBERA_VAULT_ASSET = "0x6969696969696969696969696969696969696969";
  const PUMP_BTC_VAULT_ASSET = "0x1fcca65fb6ae3b2758b9b2b394cb227eae404e1e";

  const balanceByToken = new Map<string, bigint>([
    [wberaBranch.token.address.toLowerCase(), 50n * WAD],
    [pumpBtcBranch.token.address.toLowerCase(), 10n * WAD],
  ]);
  const debtByHolder = new Map<string, bigint>([
    [wberaBranch.holder.toLowerCase(), 1_250n * WAD],
    [pumpBtcBranch.holder.toLowerCase(), 50n * WAD],
  ]);
  const feeByHolder = new Map<string, bigint>([[wberaBranch.holder.toLowerCase(), 5n * 10n ** 15n]]);
  const shutdownByHolder = new Set<string>([pumpBtcBranch.holder.toLowerCase()]);
  const assetByToken = new Map<string, string>([
    [wberaBranch.token.address.toLowerCase(), WBERA_VAULT_ASSET],
    [pumpBtcBranch.token.address.toLowerCase(), PUMP_BTC_VAULT_ASSET],
  ]);
  const decimalsByAsset = new Map<string, number>([
    [WBERA_VAULT_ASSET, 18],
    [PUMP_BTC_VAULT_ASSET, 8],
  ]);
  const totalAssetsByToken = new Map<string, bigint>([
    [wberaBranch.token.address.toLowerCase(), 200n * WAD],
    [pumpBtcBranch.token.address.toLowerCase(), 10_000_000n],
  ]);
  const totalSupplyByToken = new Map<string, bigint>([
    [wberaBranch.token.address.toLowerCase(), 100n * WAD],
    [pumpBtcBranch.token.address.toLowerCase(), 100n * WAD],
  ]);

  /**
   * One answer table serves both transports: with Multicall3 enabled the same
   * entries are read inside each aggregate3 batch, with it disabled the
   * adapter re-reads every branch through individual calls.
   */
  function beraborrowNetwork({ multicall = false }: { multicall?: boolean } = {}): AdapterNetworkSpec {
    const spec: AdapterNetworkSpec = {
      block: BLOCK,
      json: {
        // Price lookups run on the ERC4626-adapted branch tokens, so the
        // quotes are keyed by the underlying vault assets.
        [llamaUrl([
          { chain: wberaBranch.token.chain, address: WBERA_VAULT_ASSET },
          { chain: pumpBtcBranch.token.chain, address: PUMP_BTC_VAULT_ASSET },
        ])]: {
          coins: {
            [`berachain:${WBERA_VAULT_ASSET}`]: { price: 0.4, timestamp: NOW, confidence: 1 },
          },
        },
      },
      rpc: {
        "balanceOf(address)": (call) => balanceByToken.get(call.contract) ?? 0n,
        [nectParams.debtSelector!]: (call) => debtByHolder.get(call.contract) ?? 0n,
        [nectParams.shutdownSelector!]: (call) => shutdownByHolder.has(call.contract),
        [REDEMPTION_RATE_SELECTOR]: (call) => feeByHolder.get(call.contract) ?? 0n,
        "asset()": (call) => assetByToken.get(call.contract) ?? null,
        "decimals()": (call) => decimalsByAsset.get(call.contract) ?? null,
        "totalAssets()": (call) => totalAssetsByToken.get(call.contract) ?? null,
        "totalSupply()": (call) => totalSupplyByToken.get(call.contract) ?? null,
        [BRANCH_PRICE_SELECTOR]: (call) =>
          call.contract === pumpBtcBranch.holder.toLowerCase() ? 80_000n * WAD : null,
      },
    };
    if (!multicall) {
      spec.multicall = false;
      spec.rpc![AGGREGATE3_SELECTOR] = null;
    }
    return spec;
  }

  it("keeps the reviewed Berachain branch set and selectors in metadata", () => {
    expect(nect.config.adapter).toBe("liquity-v2-branches");
    expect(nect.config.version).toBe(2);
    expect(nect.config.inputs.primary).toMatchObject({
      kind: "onchain-evm",
      chain: "berachain",
      rpcMode: "public-rpc",
    });
    expect(nect.config.params).toMatchObject({
      debtSelector: "0x795d26c3",
      shutdownSelector: "0x9484fb8e",
    });
    expect(nectParams.branches.map((entry) => entry.name)).toEqual([
      "WBERA",
      "pumpBTC",
      "solvBTC",
      "solvBTC.bbn",
      "uniBTC",
      "beraETH",
      "Stakestone ETH",
      "WETH",
      "ylstETH",
      "rsETH",
      "WBTC-HONEY Kodiak Island",
      "WETH-HONEY Kodiak Island",
      "WETH-WBTC Kodiak Island",
    ]);
    const solvBtcBranch = nectParams.branches.find((entry) => entry.name === "solvBTC")!;
    expect(solvBtcBranch).toMatchObject({
      priceToken: {
        chain: "coingecko",
        address: "solv-btc",
      },
    });
  });

  it("reads ERC4626 vault shares, DenManager debt, sunsetting status, and branch fee telemetry", async () => {
    const { result, network } = await runAdapter("liquity-v2-branches", "nect-beraborrow", {
      network: beraborrowNetwork(),
      nowSec: NOW,
    });
    const metadata = result.metadata as NonNullable<typeof result.metadata>;

    expect(result.slices.map((slice) => slice.name)).toEqual(["pumpBTC", "WBERA"]);
    expect(metadata).toMatchObject({
      totalDebtUsd: 1300,
      redemption: {
        capacityUsd: 1300,
        routeStatus: "degraded",
        feeBps: 50,
      },
    });
    expect(metadata.details).toMatchObject({
      branchDebt: expect.arrayContaining([
        expect.objectContaining({
          name: "WBERA",
          debtRaw: "1250000000000000000000",
          shutDown: false,
          redemptionFeeBps: 50,
        }),
        expect.objectContaining({
          name: "pumpBTC",
          debtRaw: "50000000000000000000",
          shutDown: true,
          redemptionFeeBps: 0,
        }),
      ]),
    });
    expectWarnings(result, ["branch-protocol-price-fallback"]);
    expectWarningEffect(result, "branch-protocol-price-fallback", "info");
    expect(network.rpcCalls.some((call) =>
      call.contract === wberaBranch.holder.toLowerCase() && call.selector === nectParams.debtSelector
    )).toBe(true);
    expect(network.rpcCalls.some((call) =>
      call.contract === pumpBtcBranch.holder.toLowerCase() && call.selector === nectParams.shutdownSelector
    )).toBe(true);
  });

  it("derives the same branch redemption fee from the individual fallback as from the batch", async () => {
    const batched = await runAdapter("liquity-v2-branches", "nect-beraborrow", {
      network: beraborrowNetwork({ multicall: true }),
      nowSec: NOW,
    });
    const fallback = await runAdapter("liquity-v2-branches", "nect-beraborrow", {
      network: beraborrowNetwork({ multicall: false }),
      nowSec: NOW,
    });

    expect(batched.result.metadata?.redemption).toMatchObject({ feeBps: 50 });
    expect(fallback.result.metadata?.redemption).toMatchObject({ feeBps: 50 });
  });
});

describe("fetchLiquityV2BranchReserves Enosys branches", () => {
  const enosys = resolveAdapterCoin("liquity-v2-branches", "cdp-enosys");
  const config = enosys.config;
  const params = config.params as { branches: Array<{ name: string; holder: string }> };

  it("keeps the reviewed Flare branch set and redemption-rate probe", () => {
    expect(config.adapter).toBe("liquity-v2-branches");
    expect(config.version).toBe(2);
    expect(config.inputs.primary).toMatchObject({
      kind: "onchain-evm",
      chain: "flare",
      rpcMode: "public-rpc",
    });
    expect(config.params).toMatchObject({
      rpcUrl: "https://flare-api.flare.network/ext/C/rpc",
      redemptionRateProbe: {
        contract: "0x9474206bc035D03d142264fd9913d1D51246d3AC",
        selector: REDEMPTION_RATE_SELECTOR,
      },
      sourceUrls: [
        "https://help.enosys.global/enosys/enosys-ecosystem/enosys-loans",
        "https://flare.network/news/enosys-loans-xrp-backed-stablecoin-flare",
      ],
    });
    expect(params.branches.map((entry) => entry.name)).toEqual(["FXRP", "WFLR", "stXRP", "sFLR"]);
    expect(params.branches.map((entry) => entry.holder)).toEqual([
      "0x65C378Bf4A68491436C84d8Da020b14FEfE03D17",
      "0xE4Fc0543990128612d8112c90cdECc252165D255",
      "0x6988515B4e69Ab8AfA56E6079A1787F5A0a71Be7",
      "0x8fc9996d9B7c88F84e21fCCf46397cE534A2B17b",
    ]);
  });
});

describe("fetchLiquityV2BranchReserves staged branch reads", () => {
  it("preserves N/B/P/M dependencies across three base batches and the optional price batch", async () => {
    const branches = Array.from({ length: 3 }, (_, index) => ({
      name: `branch-${index}`,
      holder: `0x${(0x11 + index).toString(16).padStart(40, "0")}`,
      token: {
        chain: "ethereum",
        address: `0x${(0x21 + index).toString(16).padStart(40, "0")}`,
        decimals: 18,
      },
      risk: "very-low" as const,
    }));
    const underlying = "0x0000000000000000000000000000000000000031";
    const testConfig: LiveReservesConfig = {
      adapter: "liquity-v2-branches",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches,
      },
    };

    const balanceByToken = new Map<string, bigint>([
      [branches[0]!.token.address, 10n * WAD],
      [branches[1]!.token.address, 5n * WAD],
    ]);
    const debtByHolder = new Map<string, bigint>([
      [branches[0]!.holder, 100n * WAD],
      [branches[1]!.holder, 50n * WAD],
    ]);
    const feeByHolder = new Map<string, bigint>([
      [branches[0]!.holder, 50n * 10n ** 14n],
      [branches[1]!.holder, 60n * 10n ** 14n],
      [branches[2]!.holder, 70n * 10n ** 14n],
    ]);
    const network = installAdapterNetwork({
      block: BLOCK,
      json: {
        // branch-0 is ERC4626-adapted to the underlying before pricing;
        // branch-1 keeps its own token and falls back to the branch oracle.
        [llamaUrl([
          { chain: "ethereum", address: underlying },
          { chain: "ethereum", address: branches[1]!.token.address },
        ])]: {
          coins: {
            [`ethereum:${underlying}`]: { price: 1, timestamp: NOW, confidence: 1 },
          },
        },
      },
      rpc: {
        "balanceOf(address)": (call) => balanceByToken.get(call.contract) ?? 0n,
        [DEBT_SELECTOR]: (call) => debtByHolder.get(call.contract) ?? 0n,
        [SHUTDOWN_SELECTOR]: false,
        [REDEMPTION_RATE_SELECTOR]: (call) => feeByHolder.get(call.contract) ?? 0n,
        "asset()": (call) => (call.contract === branches[0]!.token.address ? underlying : null),
        "totalAssets()": 20n * WAD,
        "totalSupply()": 10n * WAD,
        "decimals()": 18,
        [BRANCH_PRICE_SELECTOR]: 2n * WAD,
      },
    });
    const signal = new AbortController().signal;
    const result = await fetchLiquityV2BranchReserves(
      { id: "test-liquity-v2" } as StablecoinMeta,
      testConfig,
      signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), nowSec: NOW, abortSignal: signal },
    );

    expectValidAdapterOutput("liquity-v2-branches", result, { now: NOW });
    expect(result.slices.map((slice) => slice.name)).toEqual(["branch-0", "branch-1"]);
    expect(result.metadata).toMatchObject({
      totalDebtUsd: 150,
      redemption: {
        capacityUsd: 150,
        feeBps: 70,
        routeStatus: "open",
      },
      observedBlock: { chain: "ethereum", number: 23_456_789 },
    });

    // The waves are pinned end to end: balance/debt/shutdown/fee for every
    // branch, then asset() probes only for funded branches, then vault
    // metadata only for probed wrappers, then branch prices only for
    // unfunded DefiLlama quotes — every read inside a Multicall3 batch.
    const calls = network.rpcCalls;
    expect(calls.every((call) => call.viaMulticall)).toBe(true);
    expect(calls).toHaveLength(18);
    expect(calls.slice(0, 12).map((call) => call.selector)).toEqual(
      branches.flatMap(() => ["0x70a08231", DEBT_SELECTOR, SHUTDOWN_SELECTOR, REDEMPTION_RATE_SELECTOR]),
    );
    expect(calls.slice(12, 14).map((call) => [call.selector, call.contract])).toEqual([
      [ERC4626_ASSET_SELECTOR, branches[0]!.token.address],
      [ERC4626_ASSET_SELECTOR, branches[1]!.token.address],
    ]);
    expect(calls.slice(14, 17).map((call) => call.selector)).toEqual([
      ERC4626_TOTAL_ASSETS_SELECTOR,
      TOTAL_SUPPLY_SELECTOR,
      DECIMALS_SELECTOR,
    ]);
    expect(calls.slice(17, 18).map((call) => [call.selector, call.contract])).toEqual([
      [BRANCH_PRICE_SELECTOR, branches[1]!.holder],
    ]);
  });
});
