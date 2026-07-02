import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
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
const BERABORROW_DEBT_SELECTOR = "0x795d26c3";
const BERABORROW_SHUTDOWN_SELECTOR = "0x9484fb8e";

function encodeAddress(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function encodeUint(value: bigint | number): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;
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
      nectBeraborrow as StablecoinMeta,
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
