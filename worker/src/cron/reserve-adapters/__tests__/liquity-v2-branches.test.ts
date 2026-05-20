import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
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
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchErc20Balance: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
    fetchOnchainRateBps: vi.fn(),
    fetchOnchainRawCall: vi.fn(),
    fetchOnchainUint256: vi.fn(),
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

describe("fetchLiquityV2BranchReserves multicall fast-path", () => {
  it("uses multicall for branch balances and debt/shutdown reads when fully decodable", async () => {
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
    vi.mocked(fetchOnchainMulticall3)
      .mockResolvedValueOnce([
        { label: "balance:0", success: true, returnData: encodeUint(2_000_000_000_000_000_000n) },
      ])
      .mockResolvedValueOnce([
        { label: "debt:0", success: true, returnData: encodeUint(1_250_000_000_000_000_000_000n) },
        { label: "shutdown:0", success: true, returnData: encodeUint(0) },
      ]);
    vi.mocked(fetchOnchainRawCall).mockResolvedValue(null);

    const result = await fetchLiquityV2BranchReserves(
      { id: "test-liquity-v2" } as StablecoinMeta,
      testConfig,
      AbortSignal.timeout(5_000),
    );

    expect(result.metadata).toMatchObject({
      totalDebtUsd: 1250,
      immediateRedeemableUsd: 1250,
      redemption: {
        routeStatus: "open",
      },
    });
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(2);
    expect(fetchErc20Balance).not.toHaveBeenCalled();
    expect(fetchOnchainUint256).not.toHaveBeenCalledWith(expect.objectContaining({
      data: "0x45507998",
    }));
  });
});
