import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchJsonWithRetry: vi.fn(),
  };
});

vi.mock("../chainlink-nav-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chainlink-nav-core")>();
  return {
    ...actual,
    fetchChainlinkNavCore: vi.fn(),
  };
});

import { adaptSuperstateLiquidity, fetchSuperstateLiquidityReserves } from "../superstate-liquidity";
import { fetchErc20Balance, fetchJsonWithRetry } from "../helpers";
import { fetchChainlinkNavCore } from "../chainlink-nav-core";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

function makeSignal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptSuperstateLiquidity", () => {
  const navResult = {
    slices: [{ name: "Short-duration U.S. government securities", pct: 100, risk: "very-low" as const }],
    metadata: {
      navPerToken: "10.15",
      totalSupplyFormatted: "1000000",
      sourceTimestamp: 1_776_000_000,
      freshnessMode: "verified" as const,
    },
  };

  it("preserves NAV reserve slices and emits the on-chain RedemptionIdle balance as direct capacity", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "2696887.17",
          usdc_redemption_idle_balance: "3412248.944618",
        },
      },
      "USTB",
      9_310_000,
    );

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata).toMatchObject({
      navPerToken: "10.15",
      freshnessMode: "verified",
      superstateLiquidityTicker: "USTB",
      circleUsdAvailable: 2_696_887.17,
      usdcRedemptionIdle: 3_412_248.944618,
      apiLiquidityUsd: 6_109_136.114618,
      immediateRedeemableUsd: 9_310_000,
      redemption: {
        capacityUsd: 9_310_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      liquidityFreshnessSource: "same-run-onchain",
      details: {
        apiLiquidityUsd: 6_109_136.114618,
        liquidityFreshnessSource: "same-run-onchain",
      },
    });
    expect(result.metadata?.sourceTimestamp).toBe(1_776_000_000);
    expect(result.metadata?.redemption?.sourceTimestamp).toBeUndefined();

    expectValidAdapterOutput("superstate-liquidity", result);
  });

  it("marks the route paused when the on-chain RedemptionIdle balance is zero", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "0",
          usdc_redemption_idle_balance: "0",
        },
      },
      "USTB",
      0,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
    });
  });

  it("throws when the requested ticker is absent", () => {
    expect(() => adaptSuperstateLiquidity(navResult, {}, "USTB", 9_310_000)).toThrow("missing USTB");
  });

  it("throws on malformed liquidity amounts", () => {
    expect(() =>
      adaptSuperstateLiquidity(
        navResult,
        {
          USTB: {
            circle_usd_available_amount: "not-a-number",
            usdc_redemption_idle_balance: "0",
          },
        },
        "USTB",
        9_310_000,
      ),
    ).toThrow("invalid circle_usd_available_amount");
  });
});

describe("fetchSuperstateLiquidityReserves", () => {
  const coin = { id: "ustb-superstate", contracts: [] } as unknown as StablecoinMeta;

  const config: LiveReservesConfig = {
    adapter: "superstate-liquidity",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" },
    },
    params: {
      oracleAddress: "0x289B5036cd942e619E1Ee48670F98d214E745AAC",
      tokenAddress: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e",
      assetLabel: "Short-duration U.S. government securities",
      assetRisk: "very-low",
      liquidityUrl: "https://api.superstate.com/v1/funds/liquidity",
      ticker: "USTB",
    },
  };

  it("reads the on-chain USDC balance of the RedemptionIdle contract and emits it as direct capacity", async () => {
    vi.mocked(fetchChainlinkNavCore).mockResolvedValueOnce({
      slices: [{ name: "Short-duration U.S. government securities", pct: 100, risk: "very-low" }],
      metadata: { navPerToken: "10.15" },
    });
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      USTB: {
        circle_usd_available_amount: "2696887.17",
        usdc_redemption_idle_balance: "3412248.944618",
      },
    });
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(9_310_000_000000n);

    const result = await fetchSuperstateLiquidityReserves(coin, config, makeSignal());

    expect(fetchErc20Balance).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "ethereum" }),
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0x4c21b7577c8fe8b0b0669165ee7c8f67fa1454cf",
      expect.anything(),
      undefined,
      undefined,
      undefined,
    );
    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 9_310_000,
      redemption: {
        capacityUsd: 9_310_000,
        capacityKind: "live-direct-bounded",
      },
    });
    expectValidAdapterOutput("superstate-liquidity", result);
  });

  it("fails closed when the on-chain RedemptionIdle balance cannot be read", async () => {
    vi.mocked(fetchChainlinkNavCore).mockResolvedValueOnce({
      slices: [{ name: "Short-duration U.S. government securities", pct: 100, risk: "very-low" }],
      metadata: { navPerToken: "10.15" },
    });
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      USTB: {
        circle_usd_available_amount: "2696887.17",
        usdc_redemption_idle_balance: "3412248.944618",
      },
    });
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(null);

    await expect(fetchSuperstateLiquidityReserves(coin, config, makeSignal()))
      .rejects.toThrow(/RedemptionIdle contract USDC balance/);
  });
});
