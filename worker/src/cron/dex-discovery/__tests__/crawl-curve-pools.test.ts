import { afterEach, describe, expect, it, vi } from "vitest";
import { CURVE_NATIVE_DISCOVERY_CHAINS } from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { crawlCurvePoolsStage } from "../crawl-curve-pools";
import { createCrawlStageContext } from "../staged-pool";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "../../dex-liquidity/constants";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

function target(chain: string, index: number): ContractDeployment {
  return { chain, address: `0x${index.toString(16).padStart(40, "0")}`, decimals: 18 };
}

describe("Curve discovery pool fetching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes larger census responses while preserving chain order", async () => {
    const chains = [...CURVE_NATIVE_DISCOVERY_CHAINS].slice(0, 5);
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const requestOrder: string[] = [];

    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
      const chain = String(url).split("/").pop()!;
      requestOrder.push(chain);
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, chain === chains[0] ? 5 : 1));
      activeRequests--;
      return {
        response: new Response(null, { status: 200 }),
        body: { data: { poolData: [] } },
      } as never;
    });

    const result = await crawlCurvePoolsStage({
      coinTargets: chains.map((chain, index) => target(chain, index + 1)),
      context: createCrawlStageContext({
        stablecoinId: "test-coin",
        knownPoolIds: new Set(),
        nowSec: 1_800_000_000,
        pools: [],
        priceObs: [],
      }),
    });

    expect(maxActiveRequests).toBe(1);
    expect(requestOrder.slice(0, 2)).toEqual(chains.slice(0, 2));
    expect(result.providerChecks.map((check) => check.chain)).toEqual(chains);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[0]?.[3]).toEqual({
      timeoutMs: 8_000,
      maxResponseBytes: 8 * 1024 * 1024,
    });
  });

  it("maps Gnosis to xdai and counts eligible pools independently for same-chain targets", async () => {
    const first = target("gnosis", 10);
    const second = target("gnosis", 11);
    const floor = DEX_LIQUIDITY_POOL_MIN_TVL_USD;
    vi.mocked(fetchJsonWithRetry).mockClear();
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      body: { data: { poolData: [
        { usdTotal: floor, coins: [{ address: first.address.toUpperCase().replace("0X", "0x") }] },
        { usdTotal: floor + 1, coins: [{ address: first.address }, { address: second.address }] },
        { usdTotal: floor + 1, coins: [{ address: target("gnosis", 12).address }] },
        { usdTotal: floor + 1, isBroken: true, coins: [{ address: first.address }] },
        { usdTotal: floor - 1, coins: [{ address: second.address }] },
      ] } },
    } as never);
    const result = await crawlCurvePoolsStage({
      coinTargets: [first, second],
      context: createCrawlStageContext({
        stablecoinId: "test", knownPoolIds: new Set(), nowSec: 1_800_000_000, pools: [], priceObs: [],
      }),
    });
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchJsonWithRetry).mock.calls[0]?.[0])).toMatch(/\/xdai$/);
    expect(result.providerChecks).toEqual([
      { chain: "gnosis", address: first.address, provider: "curve", status: "success", observedPoolCount: 2 },
      { chain: "gnosis", address: second.address, provider: "curve", status: "success", observedPoolCount: 1 },
    ]);
  });
});
