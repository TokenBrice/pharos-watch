import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { wrapperRpcResponder } from "./m0-wrapper-underlying.test-support";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";
import { fetchM0WrapperUnderlyingReserves } from "../m0-wrapper-underlying";

const WRAPPER = "0x437cc33344a0b27a429f795ff6b469c72698b291";
const M_TOKEN = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const SWAP_FACILITY = "0xb6807116b3b1b321a390594e31ecd6e0076f6278";
const SWAPPER = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";


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

let unexpectedCalls: string[] = [];

function installRpc(deployments: Parameters<typeof wrapperRpcResponder>[0]["deployments"], extension = false, routeUnavailable = false) {
  const fixture = wrapperRpcResponder({
    wrapper: WRAPPER, mToken: M_TOKEN, deployments,
    ...(extension ? { swapFacility: SWAP_FACILITY, swapper: SWAPPER } : {}),
    routeUnavailable,
  });
  unexpectedCalls = fixture.unexpected;
  fetchWithRetryMock.mockImplementation(fixture.respond);
}

describe("fetchM0WrapperUnderlyingReserves", () => {
  beforeEach(() => {
    resetRpcMocks();
  });
  afterEach(() => expect(unexpectedCalls).toEqual([]));

  it("reads direct WrappedMToken M balance as live redemption capacity", async () => {
    installRpc({ "https://rpc.example": { supply: 80_000_000_000000n, balance: 81_000_000_000000n } });

    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "wm-m0", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      { name: "M token held by wrapper", pct: 100, risk: "very-low", coinId: "m-m0", depType: "wrapper" },
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
  }, 15_000);

  it("verifies an M extension route through SwapFacility", async () => {
    installRpc({ "https://rpc.example": { supply: 4_000_000_000000n, balance: 4_000_000_000000n } }, true);

    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdsc-startale" } as StablecoinMeta,
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
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
    installRpc({ "https://rpc.example": { supply: 4_000_000_000000n, balance: 4_000_000_000000n } }, true, true);

    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdsc-startale" } as StablecoinMeta,
      baseConfig({
        mode: "m-extension",
        expectedSwapFacilityAddress: SWAP_FACILITY,
        swapperAddress: SWAPPER,
      }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      redemption: {
        capacityUsd: 4_000_000,
        routeStatus: "unknown",
        routeStatusSource: "onchain",
        routeStatusReason: "Could not verify M0 SwapFacility redemption path status",
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "m0-extension-route-unverified",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("degrades under-backed wrappers instead of publishing score-grade coverage", async () => {
    installRpc({ "https://rpc.example": { supply: 100_000_000_000000n, balance: 92_000_000_000000n } });

    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "wm-m0", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
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
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("aggregates supply and underlying balance across the primary chain and additionalDeployments", async () => {
    const ETHEREUM_TOTAL_SUPPLY = 130_407_000000n;
    const ETHEREUM_M_BALANCE = 130_470_000000n;
    const FLUENT_TOTAL_SUPPLY = 2_925_967_000000n;
    const FLUENT_M_BALANCE = 2_929_656_000000n;

    installRpc({
      "https://rpc.example": { supply: ETHEREUM_TOTAL_SUPPLY, balance: ETHEREUM_M_BALANCE },
      "https://rpc.fluent.xyz": { supply: FLUENT_TOTAL_SUPPLY, balance: FLUENT_M_BALANCE },
    });

    const result = await fetchM0WrapperUnderlyingReserves(
      { id: "usdnr-nerona", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
      baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
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
    expect(result.warnings ?? []).toEqual([]);
  }, 15_000);

  it("fails closed when an additional deployment's reads fail, refusing to aggregate fewer chains", async () => {
    installRpc({
      "https://rpc.example": { supply: 130_407_000000n, balance: 130_470_000000n },
      "https://rpc.fluent.xyz": { supply: 0n, balance: 0n, unavailable: true },
    });

    await expect(
      fetchM0WrapperUnderlyingReserves(
        { id: "usdnr-nerona", contracts: [{ chain: "ethereum", address: WRAPPER, decimals: 6 }] } as StablecoinMeta,
        baseConfig({ additionalDeployments: [{ chain: "fluent" }] }),
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/additional deployment fluent .*refusing partial aggregate/);
  });
});
