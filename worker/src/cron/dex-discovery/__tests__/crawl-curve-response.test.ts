import { afterEach, expect, it, vi } from "vitest";
import { crawlCurvePoolsStage } from "../crawl-curve-pools";
import { createCrawlStageContext } from "../staged-pool";

afterEach(() => vi.unstubAllGlobals());

it("reads an Ethereum census larger than the former 4 MiB ceiling", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const payload = JSON.stringify({
    data: { poolData: [{ usdTotal: 100_000, coins: [{ address }] }] },
    padding: "x".repeat(4 * 1024 * 1024),
  });
  const fetchMock = vi.fn(async () => new Response(payload));
  vi.stubGlobal("fetch", fetchMock);

  const result = await crawlCurvePoolsStage({
    coinTargets: [{ chain: "ethereum", address, decimals: 18 }],
    context: createCrawlStageContext({
      stablecoinId: "test", knownPoolIds: new Set(), nowSec: 1_800_000_000, pools: [], priceObs: [],
    }),
  });

  expect(result.providerChecks).toEqual([
    { chain: "ethereum", address, provider: "curve", status: "success", observedPoolCount: 1 },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
