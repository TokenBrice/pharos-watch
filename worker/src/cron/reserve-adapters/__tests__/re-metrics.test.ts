import { describe, expect, it } from "vitest";
import { adaptReMetrics } from "../re-metrics";

const SAMPLE_HTML = `
<html>
  <body>
    <script>
      self.__next_f.push([1,"...\\\"series\\\":[
        {\\\"seriesKey\\\":\\\"onchain_capital\\\",\\\"stats\\\":{\\\"current\\\":196774098.53541508}},
        {\\\"seriesKey\\\":\\\"offchain_capital\\\",\\\"stats\\\":{\\\"current\\\":73740021.94399603},\\\"points\\\":[{\\\"date\\\":\\\"2026-03-24T00:00:00.000Z\\\",\\\"value\\\":73740021.94399603}]}
      ],\\\"initialChainBreakdowns\\\":{
        \\\"1\\\":{\\\"asOf\\\":\\\"2026-03-24T20:58:49.097Z\\\",\\\"rows\\\":[
          {\\\"tokenSymbol\\\":\\\"sUSDe\\\",\\\"valueWei\\\":\\\"41917634941411512501575501\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDe\\\",\\\"valueWei\\\":\\\"573788025310890800000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDC\\\",\\\"valueWei\\\":\\\"68244636644367639420000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDT\\\",\\\"valueWei\\\":\\\"13455641816862621677240000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"reUSD/sUSDe\\\",\\\"valueWei\\\":\\\"1403639729413091693911484\\\",\\\"valueKnown\\\":true}
        ]},
        \\\"8453\\\":{\\\"asOf\\\":\\\"2026-03-24T20:58:48.611Z\\\",\\\"rows\\\":[
          {\\\"tokenSymbol\\\":\\\"sUSDe\\\",\\\"valueWei\\\":\\\"502502319142590750000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDC\\\",\\\"valueWei\\\":\\\"99102317929486495000000\\\",\\\"valueKnown\\\":true}
        ]}
      }..."]);
    </script>
  </body>
</html>
`;

const SAMPLE_HTML_INITIAL_TVL_DATA = `
<html>
  <body>
    <script>
      self.__next_f.push([1,"...\\\"initialTvlData\\\":[
        {\\\"date\\\":\\\"2026-03-23T00:00:00.000Z\\\",\\\"offchain_capital\\\":73740020.46412033,\\\"total_tvl\\\":488348352.1356877},
        {\\\"date\\\":\\\"2026-03-24T00:00:00.000Z\\\",\\\"offchain_capital\\\":73740021.94399603,\\\"total_tvl\\\":485795807.4290642}
      ],\\\"initialChainBreakdowns\\\":{
        \\\"1\\\":{\\\"asOf\\\":\\\"2026-03-24T20:58:49.097Z\\\",\\\"rows\\\":[
          {\\\"tokenSymbol\\\":\\\"sUSDe\\\",\\\"valueWei\\\":\\\"41917634941411512501575501\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDe\\\",\\\"valueWei\\\":\\\"573788025310890800000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDC\\\",\\\"valueWei\\\":\\\"68244636644367639420000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDT\\\",\\\"valueWei\\\":\\\"13455641816862621677240000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"reUSD/sUSDe\\\",\\\"valueWei\\\":\\\"1403639729413091693911484\\\",\\\"valueKnown\\\":true}
        ]},
        \\\"8453\\\":{\\\"asOf\\\":\\\"2026-03-24T20:58:48.611Z\\\",\\\"rows\\\":[
          {\\\"tokenSymbol\\\":\\\"sUSDe\\\",\\\"valueWei\\\":\\\"502502319142590750000000\\\",\\\"valueKnown\\\":true},
          {\\\"tokenSymbol\\\":\\\"USDC\\\",\\\"valueWei\\\":\\\"99102317929486495000000\\\",\\\"valueKnown\\\":true}
        ]}
      }..."]);
    </script>
  </body>
</html>
`;

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
