import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: vi.fn((input: { chain: string; rpcMode: string }, options: Record<string, unknown>) => ({
      uint256: (contract: string, data: string) => fetchOnchainUint256({
        contract,
        data,
        chain: input.chain,
        rpcMode: input.rpcMode,
        ...options,
      }),
      raw: (contract: string, data: string) => fetchOnchainRawCall({
        contract,
        data,
        chain: input.chain,
        rpcMode: input.rpcMode,
        ...options,
      }),
    })),
  };
});

import { fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";
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

function addressWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function oracleResult(priceUsd: bigint): string {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [priceUsd, priceUsd, 1n, 1n, priceUsd],
  );
}

afterEach(() => vi.clearAllMocks());

describe("fetchParallelizerBalancesReserves", () => {
  it("enumerates balances, aggregates reviewed names, and leaves residuals unlinked", async () => {
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data, chain }) => {
      const selector = data.slice(0, 10);
      if (selector === "0x1978a5ed") return chain === "ethereum" ? BigInt(ETH_USDP) : BigInt(HYPER_USDP);
      if (selector === "0x0d126627") return 0n;
      if (selector === "0x70a08231") {
        if (contract.toLowerCase() === FRXUSD.toLowerCase()) return 100n * 10n ** 18n;
        if (contract.toLowerCase() === SUSDE.toLowerCase()) return 300n * 10n ** 18n;
        if (contract.toLowerCase() === UNKNOWN.toLowerCase()) return 50n * 10n ** 6n;
      }
      if (selector === "0xeb7aac5f") return 6n;
      throw new Error(`unexpected uint256 read ${chain} ${contract} ${data}`);
    });
    vi.mocked(fetchOnchainRawCall).mockImplementation(async (call) => {
      if (call.data === "0xb7181361") {
        return call.chain === "ethereum"
          ? encodeAbiParameters([{ type: "address[]" }], [[FRXUSD]])
          : encodeAbiParameters([{ type: "address[]" }], [[SUSDE, UNKNOWN]]);
      }
      if (call.data.startsWith("0x38c269eb")) {
        return call.data.endsWith(addressWord(FRXUSD))
          ? oracleResult(1_000_000_000_000_000_000n)
          : call.data.endsWith(addressWord(SUSDE))
            ? oracleResult(1_000_000_000_000_000_000n)
            : oracleResult(1_000_000_000_000_000_000n);
      }
      throw new Error(`unexpected raw read ${call.chain} ${call.contract} ${call.data}`);
    });

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
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 450,
      redemption: {
        capacityUsd: 450,
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    });
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

  it("degrades the route and excludes a paused non-first collateral from capacity", async () => {
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data, chain }) => {
      const selector = data.slice(0, 10);
      if (selector === "0x1978a5ed") return chain === "ethereum" ? BigInt(ETH_USDP) : BigInt(HYPER_USDP);
      if (selector === "0x0d126627") return data.includes(addressWord(SUSDE)) ? 1n : 0n;
      if (selector === "0x70a08231") {
        if (contract.toLowerCase() === FRXUSD.toLowerCase()) return 100n * 10n ** 18n;
        if (contract.toLowerCase() === SUSDE.toLowerCase()) return 300n * 10n ** 18n;
        if (contract.toLowerCase() === UNKNOWN.toLowerCase()) return 50n * 10n ** 6n;
      }
      if (selector === "0xeb7aac5f") return 6n;
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

    const result = await fetchParallelizerBalancesReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    // Composition still reports the paused holding; only redeemable capacity drops.
    expect(result.slices.map((slice) => slice.name)).toContain("sUSDe (Ethereum + HyperEVM branches)");
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 450,
      immediateRedeemableUsd: 150,
      redemption: {
        capacityUsd: 150,
        routeStatus: "degraded",
        routeStatusReason: expect.stringContaining("hyperevm:sUSDe (Ethereum + HyperEVM branches)"),
      },
    });
  });

  it("pauses the route with zero capacity when every collateral is paused", async () => {
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data, chain }) => {
      const selector = data.slice(0, 10);
      if (selector === "0x1978a5ed") return chain === "ethereum" ? BigInt(ETH_USDP) : BigInt(HYPER_USDP);
      if (selector === "0x0d126627") return 1n;
      if (selector === "0x70a08231") {
        if (contract.toLowerCase() === FRXUSD.toLowerCase()) return 100n * 10n ** 18n;
        if (contract.toLowerCase() === SUSDE.toLowerCase()) return 300n * 10n ** 18n;
        if (contract.toLowerCase() === UNKNOWN.toLowerCase()) return 50n * 10n ** 6n;
      }
      if (selector === "0xeb7aac5f") return 6n;
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
});
