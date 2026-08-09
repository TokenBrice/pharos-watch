import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptReMetrics } from "../re-metrics";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "re-metrics-series.html"), "utf8");
const SAMPLE_HTML_INITIAL_TVL_DATA = SAMPLE_HTML;

describe("adaptReMetrics", () => {
  it("maps the Re metrics payload into live reserve slices", () => {
    const result = adaptReMetrics(SAMPLE_HTML);

    expect(result.slices).toEqual([
      { name: "Off-chain insurance / reinsurance capital", pct: 81.6, risk: "medium" },
      {
        name: "sUSDe (delta-neutral ETH basis)",
        pct: 15,
        risk: "high",
        coinId: "susde-ethena",
        depType: "collateral",
      },
      { name: "USDC reserves", pct: 2.5, risk: "low", coinId: "usdc-circle" },
      { name: "reUSD / sUSDe LP position", pct: 0.7, risk: "high" },
      { name: "USDT reserves", pct: 0.1, risk: "low", coinId: "usdt-tether" },
      { name: "USDe (delta-neutral ETH basis)", pct: 0.1, risk: "high", coinId: "usde-ethena" },
    ]);
    expect(result.metadata).toMatchObject({
      chainBreakdownCount: 4,
      trackedTokenCount: 6,
      offchainCapitalUsd: 179595196.93262026,
      sourceTimestamp: Date.UTC(2026, 7, 9) / 1000,
      freshnessMode: "verified",
      stableAssetUsd: expect.any(Number),
      immediateRedeemableUsd: 45535373.18748523,
      redemptionRowsCount: 4,
      redemption: {
        capacityUsd: 45535373.18748523,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-api",
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
        holderEligibility: "any-holder",
      },
    });
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("re-metrics") ?? undefined }).valid).toBe(true);
  });

  it("accepts the renamed initialTvlData payload used by the current site", () => {
    const result = adaptReMetrics(SAMPLE_HTML_INITIAL_TVL_DATA);

    expect(result.slices[0]).toEqual({
      name: "Off-chain insurance / reinsurance capital",
      pct: 81.6,
      risk: "medium",
    });
    expect(result.metadata).toMatchObject({
      offchainCapitalUsd: 179595196.93262026,
      sourceTimestamp: Date.UTC(2026, 7, 9) / 1000,
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

  it("maps sUSDS explicitly instead of degrading as an unmapped token", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-06-03T10:27:10.907Z\\",\\"rows\\":[{\\"tokenSymbol\\":\\"sUSDS\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"series\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-06-03\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.slices).toEqual([
      { name: "sUSDS (Sky savings USDS)", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Off-chain insurance / reinsurance capital", pct: 50, risk: "medium" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it("extracts instant redemption vault capacity from redemptionRows", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-06-15T10:00:00.000Z\\",\\"rows\\":[{\\"tokenSymbol\\":\\"usdc\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"redemptionRows\\":[{\\"chainName\\":\\"Ethereum\\",\\"vaultAddress\\":\\"0x5C454f5526e41fBE917b63475CD8CA7E4631B147\\",\\"custodialWalletAddress\\":\\"0x9eA38e09F41A9DE53972a68268BA0Dcc6d2fAdf8\\",\\"totalReserveValueWei\\":\\"25000000000000000000000000\\"},{\\"chainName\\":\\"Base\\",\\"vaultAddress\\":\\"0x9AB62AebAbE738AB233C447eEdCE88D1D0a61FE3\\",\\"custodialWalletAddress\\":\\"0x81d3C071d9c6d3d1f2f307004e9E5bB6db089f64\\",\\"totalReserveValueWei\\":\\"500000000000000000000000\\"}],\\"series\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-06-15\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 25_500_000,
      redemptionRowsCount: 2,
      redemption: {
        capacityUsd: 25_500_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-api",
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
        holderEligibility: "any-holder",
      },
      details: {
        redemptionRows: [
          expect.objectContaining({ chainName: "Ethereum", capacityUsd: 25_000_000 }),
          expect.objectContaining({ chainName: "Base", capacityUsd: 500_000 }),
        ],
      },
    });
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("re-metrics") ?? undefined }).valid).toBe(true);
  });

  it("parses large wei-denominated token values without raw Number conversion", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-04-14\\",\\"rows\\":[{\\"tokenSymbol\\":\\"usdc\\",\\"valueWei\\":\\"100000000000000000000000123456\\",\\"valueKnown\\":true}]}},\\"series\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-04-14\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.metadata?.stableAssetUsd).toBe(100_000_000_000);
    expect(result.slices[0]).toMatchObject({
      name: "USDC reserves",
      risk: "low",
      coinId: "usdc-circle",
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
