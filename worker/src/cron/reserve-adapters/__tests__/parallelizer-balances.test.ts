import { encodeAbiParameters } from "viem/utils";
import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { expectWarnings, installAdapterNetwork, runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const ETH_VAULT = "0x1000000000000000000000000000000000000001";
const HYPER_VAULT = "0x2000000000000000000000000000000000000002";
const ETH_USDP = "0x3000000000000000000000000000000000000003";
const HYPER_USDP = "0x4000000000000000000000000000000000000004";
const FRXUSD = "0x5000000000000000000000000000000000000005";
const SUSDE = "0x6000000000000000000000000000000000000006";
const UNKNOWN = "0x7000000000000000000000000000000000000007";
const ETH_RPC = "https://ethereum.example/rpc";
const HYPER_RPC = "https://hyperevm.example/rpc";
const BLOCK_NUMBER = 23_000_000;
const BLOCK_TIMESTAMP = 1_757_000_000;

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
        rpcUrl: ETH_RPC,
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
        rpcUrl: HYPER_RPC,
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
const TEST_DEPLOYMENTS = config.params?.deployments;

function oracleResult(priceUsd: bigint): string {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [priceUsd * 2n, priceUsd, 1n, 1n, priceUsd],
  );
}

interface ParallelizerNetworkOptions {
  pausedVaults?: string[];
  decimalsByAddress?: Record<string, bigint>;
  tokenP?: bigint;
}

function parallelizerNetwork(options: ParallelizerNetworkOptions = {}): AdapterNetworkSpec {
  const pausedVaults = (options.pausedVaults ?? []).map((vault) => vault.toLowerCase());
  const decimalsByAddress: Record<string, bigint> = {
    [FRXUSD.toLowerCase()]: 18n,
    [SUSDE.toLowerCase()]: 18n,
    [UNKNOWN.toLowerCase()]: 6n,
    ...options.decimalsByAddress,
  };
  return {
    chains: { ethereum: ETH_RPC, hyperevm: HYPER_RPC },
    block: { number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP },
    rpc: {
      "0x1978a5ed": ({ chain }) => options.tokenP ?? (chain === "ethereum" ? BigInt(ETH_USDP) : BigInt(HYPER_USDP)),
      "0x0d126627": ({ contract }) => pausedVaults.includes(contract.toLowerCase()) ? 1n : 0n,
      "0xeb7aac5f": ({ data }) => {
        const address = `0x${data.slice(-40)}`.toLowerCase();
        return decimalsByAddress[address] ?? 6n;
      },
      "0x70a08231": ({ contract }) => {
        if (contract === FRXUSD.toLowerCase()) return 100n * 10n ** 18n;
        if (contract === SUSDE.toLowerCase()) return 300n * 10n ** 18n;
        if (contract === UNKNOWN.toLowerCase()) return 50n * 10n ** 6n;
        return null;
      },
      "0xb7181361": ({ chain }) => chain === "ethereum"
        ? encodeAbiParameters([{ type: "address[]" }], [[FRXUSD]])
        : encodeAbiParameters([{ type: "address[]" }], [[SUSDE, UNKNOWN]]),
      "0x38c269eb": oracleResult(1_000_000_000_000_000_000n),
    },
  };
}

function runParallel(
  network: AdapterNetworkSpec,
  validate = true,
) {
  return runAdapter("parallelizer-balances", "usdp-parallel", {
    network: installAdapterNetwork(network),
    params: { deployments: TEST_DEPLOYMENTS },
    nowSec: BLOCK_TIMESTAMP,
    ...(validate ? {} : { validate: false as const }),
  });
}

describe("fetchParallelizerBalancesReserves", () => {
  it("enumerates balances, aggregates reviewed names, and quantifies unlinked residuals", async () => {
    const { result, network } = await runParallel(parallelizerNetwork());

    expect(result.slices).toEqual([
      {
        sourceKey: "parallelizer-balances:0x6000000000000000000000000000000000000006",
        name: "sUSDe (Ethereum + HyperEVM branches)",
        pct: 66.666667,
        risk: "medium",
        coinId: "susde-ethena",
        depType: "collateral",
      },
      {
        sourceKey: "parallelizer-balances:0x5000000000000000000000000000000000000005",
        name: "frxUSD (Ethereum branch)",
        pct: 22.222222,
        risk: "low",
        coinId: "frxusd-frax",
        depType: "collateral",
      },
      {
        sourceKey: "parallelizer-balances:0x7000000000000000000000000000000000000007",
        name: `Untracked Parallelizer collateral ${UNKNOWN.toLowerCase()}`,
        pct: 11.111111,
        risk: "high",
      },
    ]);
    expectWarnings(result, ["parallelizer-unlinked-collateral"]);
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
    // 15 inner multicall calls: per deployment, identity (tokenP + getCollateralList)
    // then redemption-pause (needs collateralAddresses[0], so it cannot merge into
    // the identity batch), then per collateral decimals + balanceOf(vault) +
    // getOracleValues. Ethereum (1 collateral) = 6, HyperEVM (2) = 9.
    expect(network.rpcCalls.filter((call) => call.viaMulticall)).toHaveLength(15);
    expect(network.rpcCalls.every((call) => call.viaMulticall)).toBe(true);
  });

  it("degrades the route and excludes a paused deployment's basket from capacity", async () => {
    const { result } = await runParallel(parallelizerNetwork({ pausedVaults: [HYPER_VAULT] }));

    expect(result.slices.map((slice) => slice.name)).toContain("sUSDe (Ethereum + HyperEVM branches)");
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 450,
      redemption: {
        capacityUsd: 100,
        routeStatus: "degraded",
        routeStatusReason: expect.any(String),
      },
    });
  });

  it("pauses the route with zero capacity when every deployment is paused", async () => {
    const { result } = await runParallel(parallelizerNetwork({ pausedVaults: [ETH_VAULT, HYPER_VAULT] }));

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 450,
      redemption: {
        capacityUsd: 0,
        routeStatus: "paused",
      },
    });
  });

  it("fails closed when configured decimals disagree with the vault's on-chain decimals", async () => {
    await expect(runParallel(parallelizerNetwork({
      decimalsByAddress: { [FRXUSD.toLowerCase()]: 6n },
    }), false)).rejects.toThrow("decimals mismatch (6 != 18)");
  });

  it("fails closed when a deployment identity changes", async () => {
    await expect(runParallel(parallelizerNetwork({ tokenP: BigInt("0xdead") }), false))
      .rejects.toThrow("tokenP identity mismatch");
  });

  it("rejects a renamed collateral-list field instead of publishing a plausible snapshot", async () => {
    await expect(runParallel({
      ...parallelizerNetwork(),
      rpc: {
        ...parallelizerNetwork().rpc,
        "0xb7181361": null,
      },
    }, false)).rejects.toThrow("getCollateralList");
  });
});
