import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createCrawlStageContext } from "../staged-pool";
import { discoveryContext } from "./discovery.test-support";
import { crawlKavaSwapPoolsStage, isKavaSwapDiscoveryDeployment } from "../crawl-kava-swap-pools";

const KAVA_USDX_ADDRESS = "usdx";
const KAVA_SWAP_PARAMS_URL = "https://api.data.kava.io/kava/swap/v1beta1/params";
const KAVA_SWAP_POOLS_URL = "https://api.data.kava.io/kava/swap/v1beta1/pools";

function target(chain = "kava", address = KAVA_USDX_ADDRESS): ContractDeployment {
  return { chain, address, decimals: 6 };
}

function context() {
  return discoveryContext("usdx-kava");
}

function params(allowedPools: Array<{ token_a: string; token_b: string }> = [{ token_a: "ukava", token_b: "usdx" }]) {
  return {
    params: {
      allowed_pools: allowedPools,
      swap_fee: "0.001500000000000000",
    },
  };
}

function pool(name: string, firstDenom: string, firstAmount: string, secondDenom: string, secondAmount: string) {
  return {
    name,
    coins: [
      { denom: firstDenom, amount: firstAmount },
      { denom: secondDenom, amount: secondAmount },
    ],
    total_shares: "101354363984",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kava swap pool discovery", () => {
  it("queries active module params and stages USDX pool reserves", async () => {
    const ukavaUsdx = pool("ukava:usdx", "ukava", "532718097661", "usdx", "33684838465");
    const unrelatedPool = pool("uabc:ukava", "uabc", "1000", "ukava", "2000");
    const fetchMock = mockFetch([
      { match: KAVA_SWAP_PARAMS_URL, body: params([{ token_a: "ukava", token_b: "usdx" }, { token_a: "uabc", token_b: "ukava" }]) },
      { match: KAVA_SWAP_POOLS_URL, body: { pools: [ukavaUsdx, unrelatedPool], pagination: { next_key: null, total: "2" } } },
    ], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlKavaSwapPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.getHistory().map(({ url }) => url)).toEqual([KAVA_SWAP_PARAMS_URL, KAVA_SWAP_POOLS_URL]);
    expect(result).toEqual({
      providerChecks: [
        {
          chain: "kava",
          address: KAVA_USDX_ADDRESS,
          provider: "kava-swap",
          status: "success",
          observedPoolCount: 1,
        },
      ],
    });
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: "kava:ukava:usdx",
      stablecoinId: "usdx-kava",
      source: "kava-swap",
      chain: "kava",
      protocol: "kava-swap",
      dexId: "kava-swap",
      symbol: "ukava / usdx",
      tvlUsd: null,
      volume24h: null,
      poolType: "kava-constant-product",
      feeTier: 15,
      baseToken: "ukava",
      quoteToken: "usdx",
      quoteSymbol: "usdx",
      priceUsd: null,
      balanceRatio: null,
    });
    expect(stageContext.pools[0]?.rawJson).toBe(JSON.stringify(ukavaUsdx));
  });

  it("records a completed empty census when params and pool records are valid but no USDX pool exists", async () => {
    mockFetch([
      { match: KAVA_SWAP_PARAMS_URL, body: params() },
      { match: KAVA_SWAP_POOLS_URL, body: { pools: [], pagination: { next_key: null, total: "0" } } },
    ], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlKavaSwapPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "kava",
        address: KAVA_USDX_ADDRESS,
        provider: "kava-swap",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("does not certify an empty census when the pools response is malformed", async () => {
    mockFetch([
      { match: KAVA_SWAP_PARAMS_URL, body: params() },
      { match: KAVA_SWAP_POOLS_URL, body: { pools: null } },
    ], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlKavaSwapPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "kava",
        address: KAVA_USDX_ADDRESS,
        provider: "kava-swap",
        status: "degraded",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("treats a retired or unavailable params endpoint as provider failure", async () => {
    mockFetch([
      { match: KAVA_SWAP_PARAMS_URL, body: { error: "not found" }, status: 404 },
    ], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlKavaSwapPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "kava",
        address: KAVA_USDX_ADDRESS,
        provider: "kava-swap",
        status: "failure",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("degrades partial pages and inconsistent totals instead of certifying empty", async () => {
    for (const pagination of [{ next_key: "more", total: "0" }, { next_key: null, total: "1" }]) {
      mockFetch([
        { match: KAVA_SWAP_PARAMS_URL, body: params() },
        { match: KAVA_SWAP_POOLS_URL, body: { pools: [], pagination } },
      ], { requireMatch: true, strictUrl: true });
      const stage = context();
      const result = await crawlKavaSwapPoolsStage({ coinTargets: [target()], context: stage.value });
      expect(result.providerChecks).toEqual([{ chain: "kava", address: "usdx", provider: "kava-swap", status: "degraded" }]);
      expect(stage.pools).toEqual([]);
    }
  });

  it("does not stage or count a disabled USDX pair", async () => {
    mockFetch([
      { match: KAVA_SWAP_PARAMS_URL, body: params([]) },
      { match: KAVA_SWAP_POOLS_URL, body: { pools: [pool("ukava:usdx", "ukava", "100", "usdx", "200")] } },
    ], { requireMatch: true, strictUrl: true });
    const stage = context();
    const result = await crawlKavaSwapPoolsStage({ coinTargets: [target()], context: stage.value });
    expect(result.providerChecks).toEqual([{ chain: "kava", address: "usdx", provider: "kava-swap", status: "success", observedPoolCount: 0 }]);
    expect(stage.pools).toEqual([]);
  });

  it("accepts reversed coin order but rejects a mismatched pool name", async () => {
    for (const [name, status] of [["ukava:usdx", "success"], ["uatom:usdx", "degraded"]] as const) {
      mockFetch([
        { match: KAVA_SWAP_PARAMS_URL, body: params() },
        { match: KAVA_SWAP_POOLS_URL, body: { pools: [pool(name, "usdx", "200", "ukava", "100")] } },
      ], { requireMatch: true, strictUrl: true });
      const stage = context();
      const result = await crawlKavaSwapPoolsStage({ coinTargets: [target()], context: stage.value });
      expect(result.providerChecks).toEqual([{
        chain: "kava", address: "usdx", provider: "kava-swap", status,
        ...(status === "success" ? { observedPoolCount: 1 } : {}),
      }]);
      expect(stage.pools.map((entry) => entry.poolId)).toEqual(status === "success" ? ["kava:ukava:usdx"] : []);
    }
  });

  it("stops before requesting pools when the params request exhausts the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetch = vi.fn(async () => {
      now.mockReturnValue(2000);
      return new Response(JSON.stringify(params()));
    });
    vi.stubGlobal("fetch", fetch);
    const stage = createCrawlStageContext({
      stablecoinId: "usdx-kava", knownPoolIds: new Set(), nowSec: 1, pools: [], priceObs: [], deadlineMs: 1500,
    });
    expect(await crawlKavaSwapPoolsStage({ coinTargets: [target()], context: stage })).toEqual({
      providerChecks: [], stoppedEarly: true,
    });
    expect(fetch.mock.calls).toHaveLength(1);
    expect(stage.pools).toEqual([]);
  });

  it("propagates parent cancellation during params without requesting pools", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel-kava");
    const fetch = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    vi.stubGlobal("fetch", fetch);
    const stage = createCrawlStageContext({
      stablecoinId: "usdx-kava", knownPoolIds: new Set(), nowSec: 1, pools: [], priceObs: [], signal: controller.signal,
    });
    await expect(crawlKavaSwapPoolsStage({ coinTargets: [target()], context: stage })).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stage.pools).toEqual([]);
  });

  it("only serves the native Kava USDX identity, not the tracked Osmosis IBC identity", () => {
    expect(isKavaSwapDiscoveryDeployment("kava", "usdx")).toBe(true);
    expect(isKavaSwapDiscoveryDeployment("kava")).toBe(false);
    expect(isKavaSwapDiscoveryDeployment("kava", "uusdx")).toBe(false);
    expect(isKavaSwapDiscoveryDeployment("osmosis", "ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE")).toBe(false);
  });
});
