import { afterEach, describe, expect, it, vi } from "vitest";
import { CURVE_NATIVE_DISCOVERY_CHAINS } from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { crawlCurvePoolsStage } from "../crawl-curve-pools";
import { createCrawlStageContext } from "../staged-pool";

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

  it("caps parallel requests at two while preserving chain order", async () => {
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

    expect(maxActiveRequests).toBe(2);
    expect(requestOrder.slice(0, 2)).toEqual(chains.slice(0, 2));
    expect(result.providerChecks.map((check) => check.chain)).toEqual(chains);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[0]?.[3]).toEqual({
      timeoutMs: 8_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
  });
});
