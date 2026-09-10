import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const WRAPPER = "0x437cc33344a0b27a429f795ff6b469c72698b291";
const M_TOKEN = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const SWAP_FACILITY = "0xb6807116b3b1b321a390594e31ecd6e0076f6278";
const SWAPPER = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";

function word(value: bigint | number): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function balanceOf(owner: string): `0x${string}` {
  return `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

function canSwapViaPath(swapper: string, fromToken: string, toToken: string): `0x${string}` {
  return `0xd8e21132${swapper.slice(2).toLowerCase().padStart(64, "0")}${fromToken.slice(2).toLowerCase().padStart(64, "0")}${toToken.slice(2).toLowerCase().padStart(64, "0")}`;
}

function baseConfig(overrides: Partial<LiveReservesConfig["params"]> = {}): LiveReservesConfig {
  return {
    adapter: "m0-wrapper-underlying",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      mode: "wrapped-m-token",
      wrapperAddress: WRAPPER,
      expectedMTokenAddress: M_TOKEN,
      slice: {
        name: "M token held by wrapper",
        risk: "very-low",
        coinId: "m-m0",
        depType: "wrapper",
      },
      ...overrides,
    },
  };
}

function wrapperNetwork(
  deployments: Record<string, { supply: bigint; balance: bigint; unavailable?: boolean }>,
  extension = false,
  routeUnavailable = false,
): AdapterNetworkSpec {
  const rpc: Record<string, `0x${string}` | null> = {};
  for (const [chain, deployment] of Object.entries(deployments)) {
    const chainId = chain === "https://rpc.example"
      ? "ethereum"
      : chain === "https://rpc.fluent.xyz"
        ? "fluent"
        : chain;
    const answer = <T extends `0x${string}`>(value: T): T | null => deployment.unavailable ? null : value;
    rpc[`${chainId}:${WRAPPER}:0xc3b6f939`] = answer(addressWord(M_TOKEN));
    rpc[`${chainId}:${WRAPPER}:0x18160ddd`] = answer(word(deployment.supply));
    rpc[`${chainId}:${WRAPPER}:0x313ce567`] = answer(word(6));
    rpc[`${chainId}:${M_TOKEN}:${balanceOf(WRAPPER)}`] = answer(word(deployment.balance));
    rpc[`${chainId}:${M_TOKEN}:0x313ce567`] = answer(word(6));
    if (extension) {
      rpc[`${chainId}:${WRAPPER}:0xae06b7e4`] = answer(addressWord(SWAP_FACILITY));
      rpc[`${chainId}:${SWAP_FACILITY}:0x5c975abb`] = routeUnavailable ? null : answer(word(0));
      rpc[`${chainId}:${SWAP_FACILITY}:${canSwapViaPath(SWAPPER, WRAPPER, M_TOKEN)}`] =
        routeUnavailable ? null : answer(word(1));
    }
  }
  return {
    chains: {
      ethereum: "https://rpc.example",
      fluent: "https://rpc.fluent.xyz",
    },
    rpc,
  };
}

function wrapperCoin(id: string, config: LiveReservesConfig): StablecoinMeta {
  return {
    id,
    contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }],
    liveReservesConfig: config,
  } as StablecoinMeta;
}

function runWrapper(
  id: string,
  config: LiveReservesConfig,
  network: AdapterNetworkSpec,
) {
  return runAdapter("m0-wrapper-underlying", wrapperCoin(id, config), { network });
}

describe("fetchM0WrapperUnderlyingReserves", () => {
  it("reads direct WrappedMToken M balance as live redemption capacity", async () => {
    const { result } = await runWrapper(
      "wm-m0",
      baseConfig(),
      wrapperNetwork({ "https://rpc.example": { supply: 80_000_000_000000n, balance: 81_000_000_000000n } }),
    );

    expect(result.slices).toEqual([
      { sourceKey: "m0-wrapper-underlying:m", name: "M token held by wrapper", pct: 100, risk: "very-low", coinId: "m-m0", depType: "wrapper" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      wrapperAddress: WRAPPER,
      mTokenAddress: M_TOKEN,
      totalSupplyRaw: "80000000000000",
      underlyingBalanceRaw: "81000000000000",
      collateralizationRatio: 1.0125,
      redemption: {
        capacityUsd: 81_000_000,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
      },
    });
    expect(result.metadata?.deployments).toBeUndefined();
  });

  it("verifies an M extension route through SwapFacility", async () => {
    const { result } = await runWrapper(
      "usdsc-startale",
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      wrapperNetwork(
        { "https://rpc.example": { supply: 4_000_000_000000n, balance: 4_000_000_000000n } },
        true,
      ),
    );

    expect(result.metadata).toMatchObject({
      swapFacilityAddress: SWAP_FACILITY,
      swapFacilityPaused: false,
      swapperCanRedeem: true,
      redemption: {
        capacityUsd: 4_000_000,
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
      },
    });
  });

  it("degrades M extension capacity when route probes cannot be verified", async () => {
    const { result } = await runWrapper(
      "usdsc-startale",
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      wrapperNetwork(
        { "https://rpc.example": { supply: 4_000_000_000000n, balance: 4_000_000_000000n } },
        true,
        true,
      ),
    );

    expect(result.metadata).toMatchObject({
      redemption: {
        capacityUsd: 4_000_000,
        routeStatus: "unknown",
        routeStatusSource: "onchain",
        routeStatusReason: "Could not verify M0 SwapFacility redemption path status",
      },
    });
    expectWarnings(result, ["m0-extension-route-unverified"]);
  });

  it("degrades under-backed wrappers instead of publishing score-grade coverage", async () => {
    const { result } = await runWrapper(
      "wm-m0",
      baseConfig(),
      wrapperNetwork({ "https://rpc.example": { supply: 100_000_000_000000n, balance: 92_000_000_000000n } }),
    );

    expect(result.metadata).toMatchObject({
      totalSupplyRaw: "100000000000000",
      underlyingBalanceRaw: "92000000000000",
      collateralizationRatio: 0.92,
      redemption: {
        capacityUsd: 92_000_000,
        capacityRatioOfSupply: 0.92,
      },
    });
    expectWarnings(result, ["reserve-undercollateralized"]);
  });

  it("aggregates supply and underlying balance across the primary chain and additionalDeployments", async () => {
    const ETHEREUM_TOTAL_SUPPLY = 130_407_000000n;
    const ETHEREUM_M_BALANCE = 130_470_000000n;
    const FLUENT_TOTAL_SUPPLY = 2_925_967_000000n;
    const FLUENT_M_BALANCE = 2_929_656_000000n;

    const { result } = await runWrapper(
      "usdnr-nerona",
      baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
      wrapperNetwork({
        "https://rpc.example": { supply: ETHEREUM_TOTAL_SUPPLY, balance: ETHEREUM_M_BALANCE },
        "https://rpc.fluent.xyz": { supply: FLUENT_TOTAL_SUPPLY, balance: FLUENT_M_BALANCE },
      }),
    );

    const totalSupplyRaw = ETHEREUM_TOTAL_SUPPLY + FLUENT_TOTAL_SUPPLY;
    const underlyingBalanceRaw = ETHEREUM_M_BALANCE + FLUENT_M_BALANCE;
    expect(result.metadata).toMatchObject({
      totalSupplyRaw: totalSupplyRaw.toString(),
      underlyingBalanceRaw: underlyingBalanceRaw.toString(),
      deployments: [
        {
          chain: "ethereum",
          totalSupplyRaw: ETHEREUM_TOTAL_SUPPLY.toString(),
          underlyingBalanceRaw: ETHEREUM_M_BALANCE.toString(),
        },
        {
          chain: "fluent",
          totalSupplyRaw: FLUENT_TOTAL_SUPPLY.toString(),
          underlyingBalanceRaw: FLUENT_M_BALANCE.toString(),
        },
      ],
    });
    const collateralizationRatio = result.metadata?.collateralizationRatio as number;
    expect(collateralizationRatio).toBeCloseTo(Number(underlyingBalanceRaw) / Number(totalSupplyRaw), 6);
    expect(collateralizationRatio).toBeGreaterThan(1);
    expectWarnings(result, []);
  });

  it("fails closed when an additional deployment's reads fail, refusing to aggregate fewer chains", async () => {
    await expect(runWrapper(
      "usdnr-nerona",
      baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
      wrapperNetwork({
        "https://rpc.example": { supply: 130_407_000000n, balance: 130_470_000000n },
        "https://rpc.fluent.xyz": { supply: 0n, balance: 0n, unavailable: true },
      }),
    )).rejects.toThrow(/additional deployment fluent .*refusing partial aggregate/);
  });
});
