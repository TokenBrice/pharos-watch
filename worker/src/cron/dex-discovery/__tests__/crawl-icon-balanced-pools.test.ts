import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createCrawlStageContext } from "../staged-pool";
import { crawlIconBalancedPoolsStage, isIconBalancedDiscoveryDeployment } from "../crawl-icon-balanced-pools";
import type { StagedPool } from "../types";

const ICON_RPC_URL = "https://ctz.solidwallet.io/api/v3";
const DEX_ADDRESS = "cxa0af3165c08318e988cb30993b3048335b94af6c";
const BNUSD_ADDRESS = "cx88fd7df7ddff82f7cc735c871dc519838cb235bb";
const BLOCK_HEIGHT = 117_440_512;

function target(chain = "icon", address = BNUSD_ADDRESS): ContractDeployment {
  return { chain, address, decimals: 18 };
}

function context() {
  const pools: StagedPool[] = [];
  return {
    pools,
    value: createCrawlStageContext({
      stablecoinId: "bnusd-balanced",
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
    }),
  };
}

function rpcResult(id: number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcBatchResponder(options: {
  nonce: number;
  stats: Record<number, unknown>;
}) {
  return async (request: Request) => {
    const body = JSON.parse(await request.text()) as Array<{
      id: number;
      method: string;
      params?: { height?: string; data?: { method?: string; params?: { _id?: string } } };
    }>;
    if (!Array.isArray(body)) throw new Error("expected JSON-RPC batch");
    return {
      body: body.map((entry) => {
        if (entry.method === "icx_getLastBlock") return rpcResult(entry.id, { height: BLOCK_HEIGHT });
        if (entry.params?.data?.method === "getNonce") return rpcResult(entry.id, `0x${options.nonce.toString(16)}`);
        if (entry.params?.data?.method === "getPoolStats") {
          const poolId = Number.parseInt(entry.params.data.params?._id ?? "", 16);
          return rpcResult(entry.id, options.stats[poolId] ?? {
            base: null,
            base_decimals: null,
            base_token: null,
            name: null,
            quote: null,
            quote_decimals: null,
            quote_token: null,
          });
        }
        throw new Error(`unexpected method ${entry.method}`);
      }),
    };
  };
}

const sicxBnusdStats = {
  base: "0x23b9eb6072c3c83bcdaaa",
  base_decimals: "0x12",
  base_token: "cx2609b924e33ef00b648a409245c7ea394c467824",
  quote: "0xc4c3340ab2393bb36d8",
  quote_decimals: "0x12",
  quote_token: BNUSD_ADDRESS,
  name: "sICX/bnUSD",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ICON Balanced pool discovery", () => {
  it("pins the SCORE census to one block and stages bnUSD reserves as TVL", async () => {
    const fetchMock = mockFetch([{
      match: ICON_RPC_URL,
      respond: rpcBatchResponder({ nonce: 3, stats: { 2: sicxBnusdStats } }),
    }], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlIconBalancedPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result).toEqual({
      providerChecks: [{
        chain: "icon",
        address: BNUSD_ADDRESS,
        provider: "icon-balanced",
        status: "success",
        observedPoolCount: 1,
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.getHistory().map((entry) => JSON.parse(entry.body ?? "null"));
    expect(requests[0]).toEqual([{ jsonrpc: "2.0", method: "icx_getLastBlock", id: 1 }]);
    expect(requests[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "icx_call",
        params: expect.objectContaining({
          to: DEX_ADDRESS,
          height: `0x${BLOCK_HEIGHT.toString(16)}`,
          dataType: "call",
          data: { method: "getNonce" },
        }),
      }),
      expect.objectContaining({
        method: "icx_call",
        params: expect.objectContaining({
          to: DEX_ADDRESS,
          height: `0x${BLOCK_HEIGHT.toString(16)}`,
          data: { method: "getPoolStats", params: { _id: "0x2" } },
        }),
      }),
    ]));
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: "icon:balanced:2",
      stablecoinId: "bnusd-balanced",
      source: "icon-balanced",
      chain: "icon",
      protocol: "balanced-dex",
      dexId: "balanced-dex",
      symbol: "sICX / bnUSD",
      tvlUsd: 116148.0869678028,
      poolType: "balanced-constant-product",
      baseToken: sicxBnusdStats.base_token,
      quoteToken: BNUSD_ADDRESS,
      quoteSymbol: "bnUSD",
      priceUsd: null,
      feeTier: null,
      rawJson: JSON.stringify({ poolId: 2, blockHeight: BLOCK_HEIGHT, stats: sicxBnusdStats }),
    });
  });

  it("certifies a completed empty census only when all pool ids were queried", async () => {
    const fetchMock = mockFetch([{
      match: ICON_RPC_URL,
      respond: rpcBatchResponder({ nonce: 3, stats: {} }),
    }], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlIconBalancedPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([{
      chain: "icon",
      address: BNUSD_ADDRESS,
      provider: "icon-balanced",
      status: "success",
      observedPoolCount: 0,
    }]);
    expect(stageContext.pools).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queries every nonce pool id serially before certifying an empty census", async () => {
    const fetchMock = mockFetch([{
      match: ICON_RPC_URL,
      respond: rpcBatchResponder({ nonce: 85, stats: {} }),
    }], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlIconBalancedPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([{
      chain: "icon",
      address: BNUSD_ADDRESS,
      provider: "icon-balanced",
      status: "success",
      observedPoolCount: 0,
    }]);
    expect(stageContext.pools).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const requests = fetchMock.getHistory().slice(1).map((entry) => JSON.parse(entry.body ?? "null")) as Array<Array<{
      params?: { height?: string; data?: { method?: string; params?: { _id?: string } } };
    }>>;
    const poolIds = requests
      .flatMap((batch) => batch)
      .filter((request) => request.params?.data?.method === "getPoolStats")
      .map((request) => request.params?.data?.params?._id);
    expect(poolIds).toEqual(Array.from({ length: 83 }, (_, index) => `0x${(index + 2).toString(16)}`));
    expect(requests.flatMap((batch) => batch).every((request) => request.params?.height === `0x${BLOCK_HEIGHT.toString(16)}`)).toBe(true);
  });

  it("does not certify an empty census when a pool result is malformed", async () => {
    const fetchMock = mockFetch([{
      match: ICON_RPC_URL,
      respond: rpcBatchResponder({
        nonce: 3,
        stats: {
          2: {
            base: "0x1",
            base_decimals: "0x12",
            base_token: "cx2609b924e33ef00b648a409245c7ea394c467824",
            quote: "0x1",
            quote_decimals: "0x12",
            quote_token: null,
            name: "broken",
          },
        },
      }),
    }], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlIconBalancedPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([{
      chain: "icon",
      address: BNUSD_ADDRESS,
      provider: "icon-balanced",
      status: "degraded",
    }]);
    expect(stageContext.pools).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only serves the canonical ICON bnUSD deployment", () => {
    expect(isIconBalancedDiscoveryDeployment("icon", BNUSD_ADDRESS)).toBe(true);
    expect(isIconBalancedDiscoveryDeployment("icon", BNUSD_ADDRESS.toUpperCase())).toBe(true);
    expect(isIconBalancedDiscoveryDeployment("icon", "cx1234567890123456789012345678901234567890")).toBe(false);
    expect(isIconBalancedDiscoveryDeployment("archway", BNUSD_ADDRESS)).toBe(false);
  });
});
