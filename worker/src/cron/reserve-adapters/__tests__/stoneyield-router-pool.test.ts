import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import coin from "@shared/data/stablecoins/coins/stusd-stoneyield.json";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterNetworkSpec } from "./reserve-adapter.test-support";
import type { AdapterResult } from "../types";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import { fetchStoneyieldRouterPoolReserves } from "../stoneyield-router-pool";
const STUSD = "0x806dd21af6de051fb811760a5768d04a99160eb9";
const USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const SUSDC = "0xad66385c6db496258771b5fd8ac376e3dd0d1536";
const ROUTER = "0x563f48aad50a75ef3662827a4d536dbd46abb5a2";
const VENUS_VAULT = "0x375defe9293671a4459cf7206ac6f440d0eb0970";
const VUSDC = "0xeca88125a5adbe82614ffC12D0DB554E2e2867C8".toLowerCase();
const TEST_CONFIG = {
  adapter: "stoneyield-router-pool",
  version: 1,
  semantics: "single-asset",
  breakerScope: "stusd-stoneyield",
  inputs: {
    primary: {
      kind: "onchain-evm",
      chain: "bsc",
      rpcMode: "public-rpc",
    },
  },
  params: {
    slice: {
      name: "USDC and yield-bearing USDC strategy positions",
      risk: "medium",
      coinId: "usdc-circle",
      depType: "wrapper",
    },
    stusdAddress: STUSD,
    usdcAddress: USDC,
    susdcAddress: SUSDC,
    routerAddress: ROUTER,
    venusVaultAddress: VENUS_VAULT,
    venusVTokenAddress: VUSDC,
    rpcUrl: "https://rpc.example",
  },
} satisfies LiveReservesConfig;

const STUSD_SUPPLY = 1_000n * 10n ** 18n;
const SUSDC_SUPPLY = 1_000n * 10n ** 18n;
const SUSDC_IDLE = 250n * 10n ** 18n;
const ROUTER_IDLE = 100n * 10n ** 18n;
const ROUTER_MANAGED = 750n * 10n ** 18n;
const VUSDC_BALANCE = 625n * 10n ** 8n;
const VUSDC_RATE = 104n * 10n ** 26n;
const VENUS_POSITION = (
  VUSDC_BALANCE * VUSDC_RATE * 10n ** 18n
) / (10n ** 8n * 10n ** 28n);

function uint256Result(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressResult(address: string): `0x${string}` {
  return `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

function strategyResult(address: string, active = true, weightBps = 10_000n): `0x${string}` {
  return `0x${[
    addressResult(address).slice(2),
    uint256Result(weightBps).slice(2),
    uint256Result(active ? 1n : 0n).slice(2),
  ].join("")}`;
}

function stoneyieldNetwork(
  routerAsset = USDC,
  strategyAddress = VENUS_VAULT,
  overrides: { active?: boolean; count?: bigint; managed?: bigint; rate?: bigint; stusdSupply?: bigint; susdcSupply?: bigint; balance?: bigint } = {},
): AdapterNetworkSpec {
  const balanceOf = (owner: string) => `0x70a08231${owner.slice(2).padStart(64, "0")}`;
  const rows: Array<[string, string, string]> = [
    [STUSD, "0x18160ddd", uint256Result(overrides.stusdSupply ?? STUSD_SUPPLY)],
    [SUSDC, "0x18160ddd", uint256Result(overrides.susdcSupply ?? SUSDC_SUPPLY)],
    [USDC, balanceOf(SUSDC), uint256Result(SUSDC_IDLE)],
    [USDC, "0x313ce567", uint256Result(18n)],
    [USDC, balanceOf(ROUTER), uint256Result(ROUTER_IDLE)],
    [ROUTER, "0x05b2bfb0", uint256Result(overrides.managed ?? ROUTER_MANAGED)],
    [ROUTER, "0x38d52e0f", addressResult(routerAsset)],
    [ROUTER, `0xd574ea3d${"0".repeat(64)}`, strategyResult(strategyAddress, overrides.active ?? true)],
    [ROUTER, "0x22068b44", uint256Result(overrides.count ?? 1n)],
    [VENUS_VAULT, "0x38d52e0f", addressResult(VUSDC)],
    [VUSDC, balanceOf(VENUS_VAULT), uint256Result(overrides.balance ?? VUSDC_BALANCE)],
    [VUSDC, "0x182df0f5", uint256Result(overrides.rate ?? VUSDC_RATE)],
    [VUSDC, "0x313ce567", uint256Result(8n)],
  ];
  return {
    chains: { bsc: "https://rpc.example" },
    rpc: Object.fromEntries(rows.map(([target, data, value]) => [`${target}:${data}`, value])),
  };
}

async function runTracked(
  networkSpec: AdapterNetworkSpec = stoneyieldNetwork(),
): Promise<AdapterResult> {
  const network = installAdapterNetwork(networkSpec);
  const trackedCoin = coin as unknown as StablecoinMeta;
  return fetchStoneyieldRouterPoolReserves(
    trackedCoin,
    TEST_CONFIG,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs },
  );
}

describe("fetchStoneyieldRouterPoolReserves", () => {
  it("reads the split pool and emits one USDC look-through slice", async () => {
    const result = await runTracked();

    expect(result.slices).toEqual([{
      name: "USDC and yield-bearing USDC strategy positions",
      pct: 100,
      risk: "medium",
      coinId: "usdc-circle",
      depType: "wrapper",
    }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "bsc",
      contractAddress: STUSD,
      totalAssetsRaw: STUSD_SUPPLY.toString(),
      totalSupplyRaw: STUSD_SUPPLY.toString(),
      collateralizationRatio: 1,
      details: {
        proofKind: "stoneyield-router-pool-look-through",
        strategyCount: 1,
        usdcDecimals: 18,
        venusVTokenDecimals: 8,
        venusExchangeRateScaleExponent: 28,
        susdcIdleUsdcRaw: SUSDC_IDLE.toString(),
        routerIdleUsdcRaw: ROUTER_IDLE.toString(),
        routerTotalManagedAssetsRaw: ROUTER_MANAGED.toString(),
        routerStrategyAssetsRaw: (ROUTER_MANAGED - ROUTER_IDLE).toString(),
        venusPositionRaw: VENUS_POSITION.toString(),
      },
    });
    expect(result.metadata?.details).toMatchObject({
      venusPositionRaw: (650n * 10n ** 18n).toString(),
    });
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["stoneyield-router-pool"].redemptionTelemetry).toEqual({
      capacity: "none",
      fee: "none",
    });
  });

  it("fails closed when the router's pinned asset identity changes", async () => {
    await expect(runTracked(stoneyieldNetwork("0x1111111111111111111111111111111111111111")))
      .rejects.toThrow(/router\.asset\(\).*expected/);
  });

  it("rejects inactive, unpinned, and additional strategies", async () => {
    await expect(runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { active: false }))).rejects.toThrow(/inactive/);
    await expect(runTracked(stoneyieldNetwork(USDC, STUSD))).rejects.toThrow(/strategies\(0\).*expected/);
    await expect(runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { count: 2n }))).rejects.toThrow(/exactly one/);
  });

  it("rejects impossible managed accounting and a funded zero-rate position", async () => {
    await expect(runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { managed: ROUTER_IDLE - 1n })))
      .rejects.toThrow(/below router idle/);
    await expect(runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { rate: 0n })))
      .rejects.toThrow(/not positive for a funded/);
  });

  it("permits exactly 1% divergence but degrades above it in either direction", async () => {
    for (const [router, venus, warned] of [[990n, 1000n, false], [989n, 1000n, true], [1000n, 990n, false], [1000n, 989n, true]] as const) {
      const result = await runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, {
        managed: ROUTER_IDLE + router * 10n ** 18n,
        balance: venus * 10n ** 8n,
        rate: 10n ** 28n,
      }));
      expect((result.warnings ?? []).filter((warning) => warning.code === "router-nav-divergence"))
        .toEqual(warned ? [expect.objectContaining({ effect: "degraded" })] : []);
    }
  });

  it("distinguishes STUSD and sUSDC coverage shortfalls", async () => {
    for (const [stusdSupply, susdcSupply, code] of [
      [2n * STUSD_SUPPLY, SUSDC_SUPPLY, "reserve-undercollateralized"],
      [STUSD_SUPPLY, 2n * SUSDC_SUPPLY, "susdc-supply-shortfall"],
    ] as const) {
      const result = await runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { stusdSupply, susdcSupply }));
      expect(result.warnings).toEqual([expect.objectContaining({ code, effect: "degraded" })]);
    }
  });

  it("reports unavailable sUSDC coverage without losing STUSD backing", async () => {
    const result = await runTracked(stoneyieldNetwork(USDC, VENUS_VAULT, { susdcSupply: 0n }));
    expect(result.metadata?.collateralizationRatio).toBe(1);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "susdc-supply-unavailable", effect: "degraded" })]);
  });
});
