import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type * as Onchain from "../onchain";
import type { AdapterResult } from "../types";
import { resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";

vi.mock("../onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof Onchain>();
  return {
    ...actual,
    fetchOnchainMulticall3: vi.fn(),
  };
});

import { fetchStoneyieldRouterPoolReserves } from "../stoneyield-router-pool";
import { fetchOnchainMulticall3 } from "../onchain";

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

function mockStoneyieldRpc(routerAsset = USDC, strategyAddress = VENUS_VAULT): void {
  vi.mocked(fetchOnchainMulticall3).mockResolvedValue([
    { label: "stusd-total-supply", success: true, returnData: uint256Result(STUSD_SUPPLY) },
    { label: "susdc-total-supply", success: true, returnData: uint256Result(SUSDC_SUPPLY) },
    { label: "susdc-idle-usdc", success: true, returnData: uint256Result(SUSDC_IDLE) },
    { label: "usdc-decimals", success: true, returnData: uint256Result(18n) },
    { label: "router-idle-usdc", success: true, returnData: uint256Result(ROUTER_IDLE) },
    { label: "router-total-managed-assets", success: true, returnData: uint256Result(ROUTER_MANAGED) },
    { label: "router-asset", success: true, returnData: addressResult(routerAsset) },
    { label: "router-strategy-0", success: true, returnData: strategyResult(strategyAddress) },
    { label: "router-strategy-count", success: true, returnData: uint256Result(1n) },
    { label: "venus-vault-asset", success: true, returnData: addressResult(VUSDC) },
    { label: "venus-vtoken-balance", success: true, returnData: uint256Result(VUSDC_BALANCE) },
    { label: "venus-exchange-rate", success: true, returnData: uint256Result(VUSDC_RATE) },
    { label: "venus-vtoken-decimals", success: true, returnData: uint256Result(8n) },
  ]);
}

async function runTracked(
  configTransform?: (config: LiveReservesConfig) => LiveReservesConfig,
): Promise<AdapterResult> {
  const coin = TRACKED_META_BY_ID.get("stusd-stoneyield");
  if (!coin) throw new Error("Missing stUSD metadata");
  const config = configTransform ? configTransform(TEST_CONFIG) : TEST_CONFIG;
  return fetchStoneyieldRouterPoolReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: testChainRpcs },
  );
}

describe("fetchStoneyieldRouterPoolReserves", () => {
  beforeEach(() => {
    resetRpcMocks();
    testChainRpcs.set("bsc", {
      chainId: "bsc",
      chainName: "BNB Smart Chain",
      type: "evm",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://bscscan.com",
    });
  });

  it("reads the split pool and emits one USDC look-through slice", async () => {
    mockStoneyieldRpc();

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
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchOnchainMulticall3).mock.calls[0]?.[0].calls).toHaveLength(13);
  });

  it("fails closed when the router's pinned asset identity changes", async () => {
    mockStoneyieldRpc("0x1111111111111111111111111111111111111111");

    await expect(runTracked()).rejects.toThrow(/router\.asset\(\).*expected/);
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(1);
  });
});
