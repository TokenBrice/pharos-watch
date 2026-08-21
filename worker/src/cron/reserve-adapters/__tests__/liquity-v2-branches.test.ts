import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import bdBaseDollar from "@shared/data/stablecoins/coins/bd-basedollar.json";
import boldLiquity from "@shared/data/stablecoins/coins/bold-liquity.json";
import cdpEnosys from "@shared/data/stablecoins/coins/cdp-enosys.json";
import nectBeraborrow from "@shared/data/stablecoins/coins/nect-beraborrow.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiquityV2Warnings,
  buildLiquityV2RedemptionMetadata,
  fetchLiquityV2BranchReserves,
} from "../liquity-v2-branches";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  fetchOnchainMulticall3,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  probeOptionalRedemptionRateBps,
} from "../helpers";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainRawCall = vi.fn();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchErc20Balance: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
    fetchOnchainRateBps: vi.fn(),
    fetchOnchainRawCall,
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((
      input: { chain?: string; rpcMode?: unknown },
      options: { signal: AbortSignal; ctx?: unknown; rpcUrl?: string; fallbackRpcUrl?: string; timeoutMs?: number },
    ) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          contract,
          data,
          signal: options.signal,
          ctx: options.ctx,
          rpcMode: input.rpcMode,
          chain: input.chain,
          rpcUrl: options.rpcUrl,
          fallbackRpcUrl: options.fallbackRpcUrl,
          timeoutMs: options.timeoutMs,
        }),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          contract,
          data,
          signal: options.signal,
          ctx: options.ctx,
          rpcMode: input.rpcMode,
          chain: input.chain,
          rpcUrl: options.rpcUrl,
          fallbackRpcUrl: options.fallbackRpcUrl,
          timeoutMs: options.timeoutMs,
        }),
    })),
    probeOptionalRedemptionRateBps: vi.fn(),
  };
});

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

const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const BRANCH_PRICE_SELECTOR = "0x0fdb11cf";
const BOLD_MECHANISM_PRICE_SELECTOR = "0x4ea15f37";
const BOLD_STABILITY_POOL_DEPOSITS_SELECTOR = "0xf71c6940";
const BERABORROW_DEBT_SELECTOR = "0x795d26c3";
const BERABORROW_SHUTDOWN_SELECTOR = "0x9484fb8e";

function encodeAddress(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function encodeUint(value: bigint | number): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;
}

function encodeMechanismPrice(price: bigint, redeemable = true): `0x${string}` {
  return `0x${encodeUint(0).slice(2)}${encodeUint(price).slice(2)}${encodeUint(redeemable ? 1 : 0).slice(2)}`;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildLiquityV2RedemptionMetadata", () => {
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
      immediateRedeemableUsd: 1250,
      redemptionFeeBps: 52,
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
      routeStatusReason: "Collateral branch shutdown/sunset detected for: WETH",
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
      immediateRedeemableUsd: 1_250,
      redemption: {
        capacityUsd: 1_250,
        routeStatus: "degraded",
        routeStatusReason: "Protocol redemption disabled for: rETH (Rocket Pool)",
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
      redemptionCapacityUnratedReason: "Could not verify branch redeemability for: WETH",
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
      routeStatusReason: "Could not verify branch shutdown status for: WETH",
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "redemption-route-status-unreadable",
        effect: "degraded",
      }),
    ]);
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
    })).toThrow("active-pool debt reads returned zero capacity");
  });
});

describe("Base Dollar production bindings", () => {
  const config = bdBaseDollar.liveReservesConfig as LiveReservesConfig;
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
        branchPriceSelector: BOLD_MECHANISM_PRICE_SELECTOR,
        stabilityPoolDepositsSelector: BOLD_STABILITY_POOL_DEPOSITS_SELECTOR,
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
  const config = boldLiquity.liveReservesConfig as LiveReservesConfig;
  const params = config.params as {
    branches: typeof branch[];
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

  it("binds every configured reserve branch to a TroveManager and Stability Pool", () => {
    expect(params.mechanismMetrics).toMatchObject({
      supplyTokenAddress: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      branchPriceSelector: BOLD_MECHANISM_PRICE_SELECTOR,
      stabilityPoolDepositsSelector: BOLD_STABILITY_POOL_DEPOSITS_SELECTOR,
    });
    expect(params.mechanismMetrics.branches.map((entry) => entry.name).sort()).toEqual(
      params.branches.map((entry) => entry.name).sort(),
    );
  });

  it("publishes mechanism metrics and excludes a protocol-disabled branch from redemption capacity", async () => {
    const unit = 10n ** 18n;
    const balances = new Map([
      ["wstETH (Lido)", 20_000n * unit],
      ["WETH", 8_000n * unit],
      ["rETH (Rocket Pool)", 5_000n * unit],
    ]);
    const debts = new Map([
      ["wstETH (Lido)", 17_000_000n * unit],
      ["WETH", 8_000_000n * unit],
      ["rETH (Rocket Pool)", 5_000_000n * unit],
    ]);
    const protocolPrices = new Map([
      ["wstETH (Lido)", 2_000n * unit],
      ["WETH", 1_800n * unit],
      ["rETH (Rocket Pool)", 1_900n * unit],
    ]);
    const stabilityPoolDeposits = new Map([
      ["wstETH (Lido)", 12_000_000n * unit],
      ["WETH", 10_000_000n * unit],
      ["rETH (Rocket Pool)", 3_000_000n * unit],
    ]);

    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
      ["wstETH (Lido)", 2_000],
      ["WETH", 1_800],
      ["rETH (Rocket Pool)", 1_900],
    ]));
    vi.mocked(fetchErc20Balance).mockImplementation(async (_input, _contract, holder) => {
      const entry = params.branches.find((candidate) => candidate.holder === holder);
      return entry ? (balances.get(entry.name) ?? null) : null;
    });
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => (
      data === "0x06ff8dfb" ? encodeUint(0) : null
    ));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      if (data !== "0x45507998") return null;
      const entry = params.branches.find((candidate) => candidate.holder === contract);
      return entry ? (debts.get(entry.name) ?? null) : null;
    });
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        if (call.label === "mechanism:total-supply") {
          return { label: call.label, success: true, returnData: encodeUint(30_000_000n * unit) };
        }
        const metricBranch = params.mechanismMetrics.branches.find((entry) =>
          call.label.endsWith(`:${entry.name}`)
        );
        if (!metricBranch) {
          return { label: call.label, success: false, returnData: "0x" as const };
        }
        if (call.label.startsWith("mechanism:price:")) {
          return {
            label: call.label,
            success: true,
            returnData: encodeMechanismPrice(
              protocolPrices.get(metricBranch.name) ?? 0n,
              metricBranch.name !== "rETH (Rocket Pool)",
            ),
          };
        }
        return {
          label: call.label,
          success: true,
          returnData: encodeUint(stabilityPoolDeposits.get(metricBranch.name) ?? 0n),
        };
      })
    );

    const result = await fetchLiquityV2BranchReserves(
      boldLiquity as unknown as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.metadata?.totalReserveUsd).toBeCloseTo(63_900_000, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(2.13, 6);
    expect(result.metadata?.liquidationCapacityRatio).toBeCloseTo(25 / 30, 6);
    expect(result.metadata?.totalDebtUsd).toBe(30_000_000);
    expect(result.metadata?.immediateRedeemableUsd).toBe(25_000_000);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 25_000_000,
      routeStatus: "degraded",
      routeStatusReason: "Protocol redemption disabled for: rETH (Rocket Pool)",
    });
    expect(result.metadata?.details).toMatchObject({
      proofKind: "liquity-v2-active-pool-debt",
      nonRedeemableBranches: ["rETH (Rocket Pool)"],
      mechanismMetrics: {
        proofKind: "liquity-v2-protocol-priced-system-state",
        totalSupplyRaw: (30_000_000n * unit).toString(),
        totalDebtRaw: (30_000_000n * unit).toString(),
        totalStabilityPoolDepositsRaw: (25_000_000n * unit).toString(),
        branchCappedLiquidationCapacityRatio: 23 / 30,
      },
    });
    expect(result.warnings).toBeUndefined();
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(1);
    expect(fetchOnchainMulticall3).toHaveBeenCalledWith(expect.objectContaining({
      calls: expect.arrayContaining([
        expect.objectContaining({
          label: "mechanism:total-supply",
          contract: params.mechanismMetrics.supplyTokenAddress,
        }),
        expect.objectContaining({
          label: "mechanism:price:WETH",
          contract: params.mechanismMetrics.branches.find((entry) => entry.name === "WETH")?.troveManagerAddress,
        }),
        expect.objectContaining({
          label: "mechanism:stability-pool:WETH",
          contract: params.mechanismMetrics.branches.find((entry) => entry.name === "WETH")?.stabilityPoolAddress,
        }),
      ]),
    }));
  });

  it("keeps reserves but leaves redemption unrated when branch redeemability is unreadable", async () => {
    const unit = 10n ** 18n;
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
      ["wstETH (Lido)", 2_000],
      ["WETH", 1_800],
      ["rETH (Rocket Pool)", 1_900],
    ]));
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000n * unit);
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => (
      data === "0x06ff8dfb" ? encodeUint(0) : null
    ));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => (
      data === "0x45507998" ? 1_000_000n * unit : null
    ));
    vi.mocked(fetchOnchainMulticall3).mockResolvedValue(null);

    const result = await fetchLiquityV2BranchReserves(
      boldLiquity as unknown as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toHaveLength(3);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.liquidationCapacityRatio).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details).toMatchObject({
      unreadableRedeemabilityBranches: ["wstETH (Lido)", "WETH", "rETH (Rocket Pool)"],
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "liquity-v2-mechanism-metrics-unavailable",
        severity: "info",
      }),
      expect.objectContaining({
        code: "liquity-v2-redeemability-unavailable",
        effect: "degraded",
      }),
    ]));
  });

  it("keeps redemption rated when optional solvency metrics fail after redeemability is readable", async () => {
    const unit = 10n ** 18n;
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
      ["wstETH (Lido)", 2_000],
      ["WETH", 1_800],
      ["rETH (Rocket Pool)", 1_900],
    ]));
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000n * unit);
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => (
      data === "0x06ff8dfb" ? encodeUint(0) : null
    ));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => (
      data === "0x45507998" ? 1_000_000n * unit : null
    ));
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        if (call.label === "mechanism:total-supply") {
          return { label: call.label, success: false, returnData: "0x" as const };
        }
        if (call.label.startsWith("mechanism:price:")) {
          return {
            label: call.label,
            success: true,
            returnData: encodeMechanismPrice(2_000n * unit, true),
          };
        }
        return { label: call.label, success: true, returnData: encodeUint(500_000n * unit) };
      })
    );

    const result = await fetchLiquityV2BranchReserves(
      boldLiquity as unknown as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toHaveLength(3);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 3_000_000,
      routeStatus: "open",
      feeBps: 50,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "liquity-v2-mechanism-metrics-unavailable",
        severity: "info",
      }),
    ]);
  });
});

describe("fetchLiquityV2BranchReserves Beraborrow branches", () => {
  const config = nectBeraborrow.liveReservesConfig as LiveReservesConfig;
  const branches = (config.params as { branches: typeof branch[] }).branches;
  const wberaBranch = branches.find((entry) => entry.name === "WBERA")!;
  const pumpBtcBranch = branches.find((entry) => entry.name === "pumpBTC")!;
  const solvBtcBranch = branches.find((entry) => entry.name === "solvBTC")!;
  const wberaAsset = "0x6969696969696969696969696969696969696969";
  const pumpBtcAsset = "0x1fCca65fb6Ae3b2758b9b2B394CB227eAE404e1E";

  it("keeps the reviewed Berachain branch set and selectors in metadata", () => {
    expect(config.adapter).toBe("liquity-v2-branches");
    expect(config.version).toBe(2);
    expect(config.inputs.primary).toMatchObject({
      kind: "onchain-evm",
      chain: "berachain",
      rpcMode: "public-rpc",
    });
    expect(config.params).toMatchObject({
      debtSelector: BERABORROW_DEBT_SELECTOR,
      shutdownSelector: BERABORROW_SHUTDOWN_SELECTOR,
    });
    expect(branches.map((entry) => entry.name)).toEqual([
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
    expect(solvBtcBranch).toMatchObject({
      priceToken: {
        chain: "coingecko",
        address: "solv-btc",
      },
    });
  });

  it("reads ERC4626 vault shares, DenManager debt, sunsetting status, and branch fee telemetry", async () => {
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchErc20Balance).mockImplementation(async (_input, contract) => {
      if (contract === wberaBranch.token.address) return 50_000_000_000_000_000_000n;
      if (contract === pumpBtcBranch.token.address) return 10_000_000_000_000_000_000n;
      return 0n;
    });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBERA", 0.4]]));
    vi.mocked(fetchOnchainRateBps).mockImplementation(async (_input, probe) => {
      if (probe.contract === wberaBranch.holder) return 50;
      if (probe.contract === pumpBtcBranch.holder) return 0;
      return 0;
    });
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      if (data === ERC4626_ASSET_SELECTOR) {
        if (contract === wberaBranch.token.address) return encodeAddress(wberaAsset);
        if (contract === pumpBtcBranch.token.address) return encodeAddress(pumpBtcAsset);
        return null;
      }
      if (data === ERC20_DECIMALS_SELECTOR) {
        if (contract.toLowerCase() === wberaAsset.toLowerCase()) return encodeUint(18);
        if (contract.toLowerCase() === pumpBtcAsset.toLowerCase()) return encodeUint(8);
        return null;
      }
      if (data === BERABORROW_SHUTDOWN_SELECTOR) {
        return encodeUint(contract === pumpBtcBranch.holder ? 1 : 0);
      }
      return null;
    });
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      if (data === ERC4626_TOTAL_ASSETS_SELECTOR) {
        if (contract === wberaBranch.token.address) return 200_000_000_000_000_000_000n;
        if (contract === pumpBtcBranch.token.address) return 10_000_000n;
        return null;
      }
      if (data === ERC20_TOTAL_SUPPLY_SELECTOR) {
        if (contract === wberaBranch.token.address) return 100_000_000_000_000_000_000n;
        if (contract === pumpBtcBranch.token.address) return 100_000_000_000_000_000_000n;
        return null;
      }
      if (data === BERABORROW_DEBT_SELECTOR) {
        if (contract === wberaBranch.holder) return 1_250_000_000_000_000_000_000n;
        if (contract === pumpBtcBranch.holder) return 50_000_000_000_000_000_000n;
        return 0n;
      }
      if (data === BRANCH_PRICE_SELECTOR) {
        if (contract === pumpBtcBranch.holder) return 80_000_000_000_000_000_000_000n;
        return null;
      }
      return null;
    });

    const result = await fetchLiquityV2BranchReserves(
      nectBeraborrow as unknown as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );
    const metadata = result.metadata as NonNullable<typeof result.metadata>;

    expect(result.slices.map((slice) => slice.name)).toEqual(["pumpBTC", "WBERA"]);
    expect(metadata).toMatchObject({
      totalDebtUsd: 1300,
      immediateRedeemableUsd: 1300,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: 1300,
        routeStatus: "degraded",
        routeStatusReason: "Collateral branch shutdown/sunset detected for: pumpBTC",
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
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "branch-protocol-price-fallback", effect: "info" }),
    ]));
    expect(fetchOnchainUint256).toHaveBeenCalledWith(expect.objectContaining({
      contract: wberaBranch.holder,
      data: BERABORROW_DEBT_SELECTOR,
    }));
    expect(fetchOnchainRawCall).toHaveBeenCalledWith(expect.objectContaining({
      contract: pumpBtcBranch.holder,
      data: BERABORROW_SHUTDOWN_SELECTOR,
    }));
  });
});

describe("fetchLiquityV2BranchReserves Enosys branches", () => {
  const config = cdpEnosys.liveReservesConfig as LiveReservesConfig;
  const branches = (config.params as { branches: typeof branch[] }).branches;

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
        selector: "0xc52861f2",
      },
      sourceUrls: [
        "https://help.enosys.global/enosys/enosys-ecosystem/enosys-loans",
        "https://flare.network/news/enosys-loans-xrp-backed-stablecoin-flare",
      ],
    });
    expect(branches.map((entry) => entry.name)).toEqual(["FXRP", "WFLR", "stXRP", "sFLR"]);
    expect(branches.map((entry) => entry.holder)).toEqual([
      "0x65C378Bf4A68491436C84d8Da020b14FEfE03D17",
      "0xE4Fc0543990128612d8112c90cdECc252165D255",
      "0x6988515B4e69Ab8AfA56E6079A1787F5A0a71Be7",
      "0x8fc9996d9B7c88F84e21fCCf46397cE534A2B17b",
    ]);
  });
});

describe("fetchLiquityV2BranchReserves direct-call reads", () => {
  it("does not trust sender-dependent Multicall3 balance or debt reads", async () => {
    const testConfig: LiveReservesConfig = {
      adapter: "liquity-v2-branches",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "WETH",
            holder: "0x1111111111111111111111111111111111111111",
            token: {
              chain: "ethereum",
              address: "0x2222222222222222222222222222222222222222",
              decimals: 18,
            },
            risk: "very-low",
          },
        ],
      },
    };

    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WETH", 1_750]]));
    vi.mocked(fetchOnchainMulticall3).mockResolvedValue([
      { label: "balance:0", success: true, returnData: encodeUint(20_000_000_000_000_000_000n) },
      { label: "debt:0", success: true, returnData: encodeUint(12_500_000_000_000_000_000_000n) },
      { label: "shutdown:0", success: true, returnData: encodeUint(0) },
    ]);
    vi.mocked(fetchErc20Balance).mockResolvedValue(2_000_000_000_000_000_000n);
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => (
      data === "0x06ff8dfb" ? encodeUint(1) : null
    ));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => (
      data === "0x45507998" ? 1_250_000_000_000_000_000_000n : null
    ));
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(null);

    const result = await fetchLiquityV2BranchReserves(
      { id: "test-liquity-v2" } as StablecoinMeta,
      testConfig,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([expect.objectContaining({ name: "WETH", pct: 100 })]);
    expect(result.metadata).toMatchObject({
      totalDebtUsd: 1250,
      immediateRedeemableUsd: 1250,
      redemption: {
        routeStatus: "degraded",
        routeStatusReason: "Collateral branch shutdown/sunset detected for: WETH",
      },
    });
    expect(fetchOnchainMulticall3).not.toHaveBeenCalled();
    expect(fetchErc20Balance).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "ethereum" }),
      "0x2222222222222222222222222222222222222222",
      "0x1111111111111111111111111111111111111111",
      expect.any(AbortSignal),
      undefined,
      undefined,
      undefined,
    );
    expect(fetchOnchainUint256).toHaveBeenCalledWith(expect.objectContaining({
      contract: "0x1111111111111111111111111111111111111111",
      data: "0x45507998",
    }));
    expect(fetchOnchainRawCall).toHaveBeenCalledWith(expect.objectContaining({
      contract: "0x1111111111111111111111111111111111111111",
      data: "0x06ff8dfb",
    }));
  });
});
