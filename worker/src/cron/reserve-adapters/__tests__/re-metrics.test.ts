import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptReMetrics } from "../re-metrics";
import { validateAdapterOutput } from "../validate";
import { extractEscapedJsonValueAfterKey } from "../html";
import { expectValidAdapterOutput, expectWarnings, installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "re-metrics-series.html"), "utf8");
const CURRENT_HTML = readFileSync(join(FIXTURES_DIR, "re-metrics-2026-09-30.html"), "utf8");

function mutateFixtureField<T>(key: string, mutate: (value: T) => void): string {
  const anchor = `\\"${key}\\":`;
  const original = extractEscapedJsonValueAfterKey(SAMPLE_HTML, anchor, "re-metrics");
  const value = JSON.parse(original) as T;
  mutate(value);
  // Next's embedded JSON leaves Unicode escapes single-escaped.
  const fragment = anchor + original.replaceAll('"', '\\"');
  if (!SAMPLE_HTML.includes(fragment)) throw new Error(`Missing encoded fixture field: ${key}`);
  return SAMPLE_HTML.replace(fragment, anchor + JSON.stringify(JSON.stringify(value)).slice(1, -1));
}

type FixtureReserveRow = { tokenSymbol?: unknown; valueWei?: unknown; valueKnown?: unknown };
type FixtureBreakdowns = Record<string, { rows: FixtureReserveRow[] }>;

describe("adaptReMetrics", () => {
  it("withholds token-specific dependencies when the issuer only supplies byAsset numerators", () => {
    const result = adaptReMetrics(CURRENT_HTML);
    expect(result.slices.every((slice) => slice.coinId == null && slice.depType == null)).toBe(true);
    expect(result.slices.find((slice) => slice.sourceKey === "re-metrics:token:susde")?.pct).toBeGreaterThan(0);
    expect(result.slices.find((slice) => slice.sourceKey === "re-metrics:token:susds")?.pct).toBeGreaterThan(0);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.metadata).toMatchObject({
      compositionScope: "protocol-pooled",
      tokenAttribution: "withheld-offchain-denominator-and-tranche-waterfall",
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-token-attribution-withheld",
      effect: "info",
    }));
  });
  it("maps the Re metrics payload into live reserve slices", () => {
    const result = adaptReMetrics(SAMPLE_HTML);

    expect(result.slices.every((slice) => slice.coinId == null && slice.depType == null)).toBe(true);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    const breakdowns = JSON.parse(extractEscapedJsonValueAfterKey(
      SAMPLE_HTML, '\\"initialChainBreakdowns\\":', "re-metrics",
    )) as Record<string, { rows: Array<{ tokenSymbol: string; valueWei: string }> }>;
    const rows = Object.values(breakdowns).flatMap(({ rows }) => rows);
    const total = rows.reduce((sum, row) => sum + Number(BigInt(row.valueWei)) / 1e18, 179595196.93262026);
    const susde = rows.filter((row) => row.tokenSymbol.toLowerCase() === "susde")
      .reduce((sum, row) => sum + Number(BigInt(row.valueWei)) / 1e18, 0);
    expect(result.slices.find((slice) => slice.sourceKey === "re-metrics:token:susde")?.pct)
      .toBeCloseTo(susde / total * 100, 10);
    expect(result.metadata).toMatchObject({
      chainBreakdownCount: 4,
      trackedTokenCount: 6,
      offchainCapitalUsd: 179595196.93262026,
      offchainAsOf: Date.parse("2026-08-09T00:00:00.000Z") / 1000,
      sourceTimestamp: Math.floor(Date.parse("2026-08-09T00:00:00.000Z") / 1000),
      freshnessMode: "verified",
      stableAssetUsd: expect.any(Number),
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
    expectWarnings(result, ["re-metrics-offchain-capital-branch", "re-metrics-token-attribution-withheld"]);
  });

  it.each(["initialCards", "initialTvlData", "both"] as const)("parses %s with initialCards taking precedence and warns which branch fired", (format) => {
    const payload = {
      initialChainBreakdowns: {
        ethereum: { asOf: "2026-04-14", rows: [{ tokenSymbol: "usdc", valueWei: "100000000000000000000", valueKnown: true }] },
      },
      ...(format !== "initialTvlData" ? {
        initialCards: [{ seriesKey: "offchain_capital", stats: { current: 300 }, points: [{ date: "2026-04-14", value: 300 }] }],
      } : {}),
      ...(format !== "initialCards" ? { initialTvlData: [{ date: "2026-04-14", offchain_capital: 100 }] } : {}),
    };
    const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(payload))}]);</script>`;
    const result = adaptReMetrics(html);
    expect(result.metadata?.offchainCapitalUsd).toBe(format === "initialTvlData" ? 100 : 300);
    expect(result.slices.find(({ sourceKey }) => sourceKey === "re-metrics:token:usdc")?.pct).toBe(format === "initialTvlData" ? 50 : 25);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-offchain-capital-branch",
      effect: "info",
      message: expect.stringContaining(format === "initialTvlData" ? "initialTvlData fallback" : "initialCards series"),
    }));
  });

  it("maps liUSD 4w explicitly instead of degrading as an unmapped token", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-04-14\\",\\"rows\\":[{\\"tokenSymbol\\":\\"liusd-4w\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"initialCards\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-04-14\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.slices).toEqual([
      { sourceKey: "re-metrics:token:liusd-4w", name: "liUSD 4w vault", pct: 50, risk: "medium" },
      { sourceKey: "re-metrics:offchain-capital", name: "Off-chain insurance / reinsurance capital", pct: 50, risk: "medium" },
    ]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-offchain-capital-branch",
      effect: "info",
      message: expect.stringContaining("initialCards series"),
    }));
  });

  it("maps sUSDS explicitly instead of degrading as an unmapped token", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-06-03T10:27:10.907Z\\",\\"rows\\":[{\\"tokenSymbol\\":\\"sUSDS\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"initialCards\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-06-03\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.slices).toEqual([
      { sourceKey: "re-metrics:token:susds", name: "sUSDS (Sky savings USDS)", pct: 50, risk: "low" },
      { sourceKey: "re-metrics:offchain-capital", name: "Off-chain insurance / reinsurance capital", pct: 50, risk: "medium" },
    ]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-offchain-capital-branch",
      effect: "info",
      message: expect.stringContaining("initialCards series"),
    }));
  });

  it("extracts instant redemption vault capacity from redemptionRows", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-06-15T10:00:00.000Z\\",\\"rows\\":[{\\"tokenSymbol\\":\\"usdc\\",\\"valueWei\\":\\"100000000000000000000\\",\\"valueKnown\\":true}]}},\\"redemptionRows\\":[{\\"chainName\\":\\"Ethereum\\",\\"vaultAddress\\":\\"0x5C454f5526e41fBE917b63475CD8CA7E4631B147\\",\\"custodialWalletAddress\\":\\"0x9eA38e09F41A9DE53972a68268BA0Dcc6d2fAdf8\\",\\"totalReserveValueWei\\":\\"25000000000000000000000000\\"},{\\"chainName\\":\\"Base\\",\\"vaultAddress\\":\\"0x9AB62AebAbE738AB233C447eEdCE88D1D0a61FE3\\",\\"custodialWalletAddress\\":\\"0x81d3C071d9c6d3d1f2f307004e9E5bB6db089f64\\",\\"totalReserveValueWei\\":\\"500000000000000000000000\\"}],\\"initialCards\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-06-15\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.metadata).toMatchObject({
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
    expectValidAdapterOutput("re-metrics", result);
  });

  it("normalizes large wei-denominated token values", () => {
    const html = `
<html><body><script>
self.__next_f.push([1,"...\\"initialChainBreakdowns\\":{\\"ethereum\\":{\\"asOf\\":\\"2026-04-14\\",\\"rows\\":[{\\"tokenSymbol\\":\\"usdc\\",\\"valueWei\\":\\"100000000000000000000000123456\\",\\"valueKnown\\":true}]}},\\"initialCards\\":[{\\"seriesKey\\":\\"offchain_capital\\",\\"stats\\":{\\"current\\":100},\\"points\\":[{\\"date\\":\\"2026-04-14\\",\\"value\\":100}]}]..."]);
</script></body></html>
`;
    const result = adaptReMetrics(html);

    expect(result.metadata?.stableAssetUsd).toBe(100_000_000_000);
    expect(result.slices[0]).toMatchObject({
      sourceKey: "re-metrics:token:usdc",
      risk: "low",
    });
    expect(result.slices[0].coinId).toBeUndefined();
    expect(result.slices[0].depType).toBeUndefined();
  });

  it("throws when the page no longer exposes the expected metrics payload", () => {
    expect(() => adaptReMetrics("<html></html>")).toThrow("layout-changed");
  });

  it("keeps parser failures distinguishable from layout drift", () => {
    const malformedHtml = `
<html>
  <body>
    <script>
      self.__next_f.push([1,"...\\\"initialCards\\\":[bad-json],\\\"initialChainBreakdowns\\\":{}..."]);
    </script>
  </body>
</html>
`;
    expect(() => adaptReMetrics(malformedHtml)).toThrow("parse-failed");
  });
});

describe("fetchReMetricsReserves", () => {
  const url = "https://app.re.xyz/metrics";
  const nowSec = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

  it("fetches the embedded metrics page through the shared network harness", async () => {
    const { result, network } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: SAMPLE_HTML } }),
      nowSec,
    });
    expect(result.metadata).toMatchObject({ chainBreakdownCount: 4, trackedTokenCount: 6 });
    expect(network.requests).toEqual([{ url, method: "GET" }]);
  });

  it.each([
    ["missing amount", { valueWei: undefined }, "amount-unavailable"],
    ["malformed amount", { valueWei: "broken" }, "amount-unavailable"],
    ["negative amount", { valueWei: "-1" }, "amount-unavailable"],
    ["numeric amount", { valueWei: 100 }, "amount-unavailable"],
    ["unknown valuation", { valueKnown: false }, "valuation-unavailable"],
    ["missing valuation", { valueKnown: undefined }, "valuation-unavailable"],
    ["missing symbol", { tokenSymbol: undefined }, "identity-unavailable"],
    ["blank symbol", { tokenSymbol: " " }, "identity-unavailable"],
  ] as const)("withholds composition for a risky row with %s", async (_label, patch, reason) => {
    const html = mutateFixtureField<FixtureBreakdowns>("initialChainBreakdowns", (breakdowns) => {
      const row = Object.values(breakdowns).flatMap(({ rows }) => rows)
        .find(({ tokenSymbol }) => typeof tokenSymbol === "string" && tokenSymbol.toLowerCase() === "susde");
      if (!row) throw new Error("Missing sUSDe fixture position");
      Object.assign(row, patch);
    });
    const { result } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: html } }),
      nowSec,
      validate: false,
    });
    expect(result.slices).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: `re-metrics-reserve-${reason}`, effect: "fatal",
    }));
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.stableAssetUsd).toBeUndefined();
    expect(result.metadata?.redemption?.capacityUsd).toBe(45535373.18748523);
    expect(validateAdapterOutput(result, { now: nowSec }).valid).toBe(false);
  });

  it("withholds composition when off-chain capital has no usable valuation", async () => {
    const html = mutateFixtureField<Array<{ seriesKey: string; stats?: { current?: unknown }; points?: unknown[] }>>("initialCards", (cards) => {
      const card = cards.find(({ seriesKey }) => seriesKey === "offchain_capital");
      if (!card) throw new Error("Missing off-chain fixture capital");
      card.stats = {};
      card.points = [];
    });
    const { result } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: html } }), nowSec, validate: false,
    });
    expect(result.slices).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-offchain-value-unavailable", effect: "fatal",
    }));
    expect(validateAdapterOutput(result, { now: nowSec }).valid).toBe(false);
  });

  it("admits a positively identified explicit zero position without requiring its clock", async () => {
    const html = mutateFixtureField<FixtureBreakdowns>("initialChainBreakdowns", (breakdowns) => {
      breakdowns.zero = { rows: [{ tokenSymbol: "susde", valueWei: "0", valueKnown: true }] };
    });
    const { result } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: html } }), nowSec,
    });
    expect(result.slices).toEqual(adaptReMetrics(SAMPLE_HTML).slices);
    expect(result.metadata?.freshnessMode).toBe("verified");
  });

  it.each([undefined, null, "broken", "-1", 100])("withholds partial redemption capacity for %s", async (amount) => {
    const html = mutateFixtureField<Array<{ totalReserveValueWei?: unknown }>>("redemptionRows", (rows) => {
      rows[0].totalReserveValueWei = amount;
    });
    const { result } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: html } }), nowSec,
    });
    expect(result.slices).toEqual(adaptReMetrics(SAMPLE_HTML).slices);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.redemptionRowsCount).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "re-metrics-redemption-incomplete", effect: "degraded",
    }));
  });

  it("publishes observed zero redemption capacity rather than unavailable capacity", async () => {
    const html = mutateFixtureField<Array<{ totalReserveValueWei: string }>>("redemptionRows", (rows) => {
      for (const row of rows) row.totalReserveValueWei = "0";
    });
    const { result } = await runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: html } }), nowSec,
    });
    expect(result.metadata?.redemption?.capacityUsd).toBe(0);
    expect(result.metadata?.redemptionRowsCount).toBe(4);
    expect(result.slices).toEqual(adaptReMetrics(SAMPLE_HTML).slices);
  });

  it("rejects a renamed chain-breakdown field instead of publishing stale composition", async () => {
    const drifted = SAMPLE_HTML.replace("\\\"initialChainBreakdowns\\\":", "\\\"chainBreakdowns\\\":");
    await expect(runAdapter("re-metrics", "reusd-re-protocol", {
      network: installAdapterNetwork({ html: { [url]: drifted } }),
      nowSec,
      validate: false,
    })).rejects.toThrow("layout-changed");
  });
});


it.each(["2025-01-01", "2099-01-01", undefined])("does not lend chain freshness to offchain capital dated %s", (date) => {
  const payload = {
    initialChainBreakdowns: {
      ethereum: { asOf: "2026-09-12", rows: [{ tokenSymbol: "usdc", valueWei: "100000000000000000000", valueKnown: true }] },
    },
    initialCards: [{ seriesKey: "offchain_capital", stats: { current: 300 }, points: [{ date, value: 300 }] }],
  };
  const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(payload))}]);</script>`;
  const result = adaptReMetrics(html);
  const validated = validateAdapterOutput(result, { now: Date.parse("2026-09-12") / 1000, maxSourceAgeSec: 3 * 86400 });
  expect([...(result.warnings ?? []), ...validated.warnings]).toContainEqual(expect.objectContaining({ effect: date === "2099-01-01" ? "fatal" : "degraded" }));
  if (date === "2099-01-01") expect(validated.valid).toBe(false);
  else expect(result.metadata?.sourceTimestamp).not.toBe(Date.parse("2026-09-12") / 1000);
});
