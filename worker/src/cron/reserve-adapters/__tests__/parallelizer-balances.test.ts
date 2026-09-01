import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  const fetchOnchainMulticall3 = vi.fn(async ({ calls, ...options }) => Promise.all(
    calls.map(async (call: { label: string; contract: string; data: string }) => {
      const selector = call.data.slice(0, 10);
      const raw = selector === "0xb7181361" || selector === "0x38c269eb"
        ? await fetchOnchainRawCall({ ...options, contract: call.contract, data: call.data })
        : await fetchOnchainUint256({ ...options, contract: call.contract, data: call.data });
      return {
        label: call.label,
        success: raw != null,
        returnData: typeof raw === "bigint"
          ? `0x${raw.toString(16).padStart(64, "0")}`
          : raw ?? "0x",
      };
    }),
  ));
  return {
    ...actual,
    fetchOnchainUint256,
    fetchOnchainRawCall,
    fetchOnchainMulticall3,
  };
});

import { fetchOnchainMulticall3, fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";
import { fetchParallelizerBalancesReserves } from "../parallelizer-balances";

const ETH_VAULT = "0x1000000000000000000000000000000000000001";
const HYPER_VAULT = "0x2000000000000000000000000000000000000002";
const ETH_USDP = "0x3000000000000000000000000000000000000003";
const HYPER_USDP = "0x4000000000000000000000000000000000000004";
const FRXUSD = "0x5000000000000000000000000000000000000005";
const SUSDE = "0x6000000000000000000000000000000000000006";
const UNKNOWN = "0x7000000000000000000000000000000000000007";

const config: LiveReservesConfig = {
  adapter: "parallelizer-balances",
  version: 1,
  semantics: "collateral-mix",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
  },
  params: {
    deployments: [
      {
        chain: "ethereum",
        vaultAddress: ETH_VAULT,
        expectedTokenP: ETH_USDP,
        rpcUrl: "https://ethereum.example/rpc",
        assets: [
          {
            address: FRXUSD,
            decimals: 18,
            name: "frxUSD (Ethereum branch)",
            risk: "low",
            coinId: "frxusd-frax",
            depType: "collateral",
          },
        ],
      },
      {
        chain: "hyperevm",
        vaultAddress: HYPER_VAULT,
        expectedTokenP: HYPER_USDP,
        rpcUrl: "https://hyperevm.example/rpc",
        assets: [
          {
            address: SUSDE,
            decimals: 18,
            name: "sUSDe (Ethereum + HyperEVM branches)",
            risk: "medium",
            coinId: "susde-ethena",
            depType: "collateral",
          },
        ],
      },
    ],
    sourceUrls: ["https://docs.parallel.example/"],
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
  },
};

function oracleResult(priceUsd: bigint): string {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [priceUsd, priceUsd, 1n, 1n, priceUsd],
  );
}

/**
 * Standard mock wiring. Decimals are served per address (chain truth); the
 * Redeem pause read is served per vault, mirroring the contract's global
 * `isRedemptionLive` flag (LibSetters._setPauseState ignores the collateral
 * argument for Redeem).
 */
function mockOnchain(options: {
  pausedVaults?: string[];
  decimalsByAddress?: Record<string, bigint>;
} = {}): void {
  const pausedVaults = (options.pausedVaults ?? []).map((vault) => vault.toLowerCase());
  const decimalsByAddress: Record<string, bigint> = {
    [FRXUSD.toLowerCase()]: 18n,
    [SUSDE.toLowerCase()]: 18n,
    [UNKNOWN.toLowerCase()]: 6n,
    ...options.decimalsByAddress,
  };
  vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data, chain }) => {
    const selector = data.slice(0, 10);
    if (selector === "0x1978a5ed") return chain === "ethereum" ? BigInt(ETH_USDP) : BigInt(HYPER_USDP);
    if (selector === "0x0d126627") return pausedVaults.includes(contract.toLowerCase()) ? 1n : 0n;
    if (selector === "0x70a08231") {
      if (contract.toLowerCase() === FRXUSD.toLowerCase()) return 100n * 10n ** 18n;
      if (contract.toLowerCase() === SUSDE.toLowerCase()) return 300n * 10n ** 18n;
      if (contract.toLowerCase() === UNKNOWN.toLowerCase()) return 50n * 10n ** 6n;
    }
    if (selector === "0xeb7aac5f") {
      const address = `0x${data.slice(-40)}`.toLowerCase();
      return decimalsByAddress[address] ?? 6n;
    }
    throw new Error(`unexpected uint256 read ${chain} ${contract} ${data}`);
  });
  vi.mocked(fetchOnchainRawCall).mockImplementation(async (call) => {
    if (call.data === "0xb7181361") {
      return call.chain === "ethereum"
        ? encodeAbiParameters([{ type: "address[]" }], [[FRXUSD]])
        : encodeAbiParameters([{ type: "address[]" }], [[SUSDE, UNKNOWN]]);
    }
    if (call.data.startsWith("0x38c269eb")) return oracleResult(1_000_000_000_000_000_000n);
    throw new Error(`unexpected raw read ${call.chain} ${call.contract} ${call.data}`);
  });
}

afterEach(() => vi.clearAllMocks());

describe("fetchParallelizerBalancesReserves", () => {
  it("enumerates balances, aggregates reviewed names, and quantifies unlinked residuals", async () => {
    mockOnchain();

    const result = await fetchParallelizerBalancesReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      {
        name: "sUSDe (Ethereum + HyperEVM branches)",
        pct: 66.666667,
        risk: "medium",
        coinId: "susde-ethena",
        depType: "collateral",
      },
      {
        name: "frxUSD (Ethereum branch)",
        pct: 22.222222,
        risk: "low",
        coinId: "frxusd-frax",
        depType: "collateral",
      },
      {
        name: `Untracked Parallelizer collateral ${UNKNOWN.toLowerCase()}`,
        pct: 11.111111,
        risk: "high",
      },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "parallelizer-unlinked-collateral", severity: "info" }),
    ]);
    expect(result.warnings?.[0]?.message).toContain("11.111111% of reserves");
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 450,
      unlinkedCollateralPct: 11.111111,
      unknownExposurePct: 11.111111,
      redemption: {
        capacityUsd: 450,
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    });
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(6);
    for (const chain of ["ethereum", "hyperevm"]) {
      const stages = vi.mocked(fetchOnchainMulticall3).mock.calls
        .map(([options]) => options)
        .filter((options) => options.chain === chain);
      expect(stages.map((stage) => stage.calls.map((call) => call.label))).toEqual([
        ["token-p", "collateral-list"],
        ["redemption-paused"],
        ...(chain === "ethereum"
          ? [["asset:0:decimals", "asset:0:balance", "asset:0:oracle"]]
          : [[
              "asset:0:decimals",
              "asset:0:balance",
              "asset:0:oracle",
              "asset:1:decimals",
              "asset:1:balance",
              "asset:1:oracle",
            ]]),
      ]);
    }
  });

  it("degrades the route and excludes a paused deployment's basket from capacity", async () => {
    // Redeem pause is vault-global: pausing the HyperEVM vault removes its
    // whole proportional basket (sUSDe + untracked) while Ethereum redeems on.
    mockOnchain({ pausedVaults: [HYPER_VAULT] });

    const result = await fetchParallelizerBalancesReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    // Composition still reports the paused holdings; only capacity drops.
    expect(result.slices.map((slice) => slice.name)).toContain("sUSDe (Ethereum + HyperEVM branches)");
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 450,
      immediateRedeemableUsd: 100,
      redemption: {
        capacityUsd: 100,
        routeStatus: "degraded",
        routeStatusReason: expect.stringContaining("paused on hyperevm"),
      },
    });
  });

  it("pauses the route with zero capacity when every deployment is paused", async () => {
    mockOnchain({ pausedVaults: [ETH_VAULT, HYPER_VAULT] });

    const result = await fetchParallelizerBalancesReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 450,
      immediateRedeemableUsd: 0,
      redemption: {
        capacityUsd: 0,
        routeStatus: "paused",
      },
    });
  });

  it("fails closed when configured decimals disagree with the vault's on-chain decimals", async () => {
    mockOnchain({ decimalsByAddress: { [FRXUSD.toLowerCase()]: 6n } });

    await expect(
      fetchParallelizerBalancesReserves(
        { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
        config,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow("decimals mismatch (6 != 18)");
  });

  it("fails closed when a deployment identity changes", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValue(BigInt("0xdead"));
    await expect(
      fetchParallelizerBalancesReserves(
        { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
        config,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow("tokenP identity mismatch");
  });
});
