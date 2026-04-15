import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptReMetrics } from "../re-metrics";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "re-metrics-series.html"), "utf8");
const SAMPLE_HTML_INITIAL_TVL_DATA = readFileSync(join(FIXTURES_DIR, "re-metrics-initial-tvl.html"), "utf8");

describe("adaptReMetrics", () => {
  it("maps the Re metrics payload into live reserve slices", () => {
    const result = adaptReMetrics(SAMPLE_HTML);

    expect(result.slices).toEqual([
      { name: "Off-chain insurance / reinsurance capital", pct: 36.9, risk: "medium" },
      { name: "USDC reserves", pct: 34.2, risk: "low", coinId: "usdc-circle" },
      { name: "sUSDe (delta-neutral ETH basis)", pct: 21.2, risk: "high", coinId: "usde-ethena", depType: "wrapper" },
      { name: "USDT reserves", pct: 6.7, risk: "low", coinId: "usdt-tether" },
      { name: "reUSD / sUSDe LP position", pct: 0.7, risk: "high" },
      { name: "USDe (delta-neutral ETH basis)", pct: 0.3, risk: "high", coinId: "usde-ethena" },
    ]);
    expect(result.metadata).toMatchObject({
      chainBreakdownCount: 2,
      trackedTokenCount: 5,
      offchainCapitalUsd: 73740021.94399603,
      sourceTimestamp: Date.UTC(2026, 2, 24) / 1000,
      freshnessMode: "verified",
      immediateRedeemableUsd: expect.any(Number),
      redemption: {
        capacityUsd: expect.any(Number),
        capacityKind: "live-queue",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 2, 24) / 1000,
        routeStatus: "open",
      },
    });
  });

  it("accepts the renamed initialTvlData payload used by the current site", () => {
    const result = adaptReMetrics(SAMPLE_HTML_INITIAL_TVL_DATA);

    expect(result.slices[0]).toEqual({
      name: "Off-chain insurance / reinsurance capital",
      pct: 36.9,
      risk: "medium",
    });
    expect(result.metadata).toMatchObject({
      offchainCapitalUsd: 73740021.94399603,
      sourceTimestamp: Date.UTC(2026, 2, 24) / 1000,
      freshnessMode: "verified",
    });
  });

  it("maps liUSD 4w explicitly instead of degrading as an unmapped token", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-04-14\\",\\"rows\\":[{\\"tokenSymbol\\":\\"liusd-4w\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"series\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-04-14\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.slices).toEqual([
      { name: "liUSD 4w vault", pct: 50, risk: "medium" },
      { name: "Off-chain insurance / reinsurance capital", pct: 50, risk: "medium" },
    ]);
    expect(result.warnings).toBeUndefined();
  });


  it("throws when the page no longer exposes the expected metrics payload", () => {
    expect(() => adaptReMetrics("<html></html>")).toThrow("layout-changed");
  });

  it("keeps parser failures distinguishable from layout drift", () => {
    const malformedHtml = `
<html>
  <body>
    <script>
      self.__next_f.push([1,"...\\\"series\\\":[bad-json],\\\"initialChainBreakdowns\\\":{}..."]);
    </script>
  </body>
</html>
`;
    expect(() => adaptReMetrics(malformedHtml)).toThrow("parse-failed");
  });
});
