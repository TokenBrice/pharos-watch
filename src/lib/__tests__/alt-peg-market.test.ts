import { describe, expect, it } from "vitest";
import { makeAltPegCoin } from "@shared/test-utils/stablecoin";
import { CORE_NON_USD_IDS, coreNonUsdRows } from "@shared/test-utils/alt-peg-fixtures";
import { getCoreNonUsdPeg } from "@shared/lib/alt-peg-snapshot";
import { NonUsdShareResponseSchema } from "@shared/types/market";
import { buildAltPegSnapshot, buildAltPegTrendStats, parseAltPegParam } from "@/lib/alt-peg-market";


describe("alt-peg-market", () => {
  const coin = (id: string, cap: number | null) => cap === null ? { ...makeAltPegCoin(id, 0), circulating: {} } : makeAltPegCoin(id, cap);
  const complete = (caps: Record<string, number | null | "omit">, extra: ReturnType<typeof makeAltPegCoin>[] = []) =>
    [...extra, ...coreNonUsdRows(coin, caps)];

  it("joins live rows to tracked metadata and filters out USD assets", () => {
    const snapshot = buildAltPegSnapshot(complete(
      { "eurc-circle": 55_000_000, "brz-transfero": 12_000_000, "paxg-paxos": 18_000_000 },
      [makeAltPegCoin("usdc-circle", 120_000_000)],
    ));

    expect(snapshot.altCoinCount).toBe(CORE_NON_USD_IDS.length);
    expect(snapshot.altSupplyUnavailableCount).toBe(0);
    expect(snapshot.totalMarketCap).toBe(205_000_000);
    expect(snapshot.altMarketCap).toBe(85_000_000);
    expect(snapshot.altSharePct).toBeNull(); // core USD members are absent from this fixture
    expect(snapshot.nonCommodityMarketCap).toBe(67_000_000);
    expect(snapshot.commoditySharePct).toBeCloseTo(21.18, 1);
  });

  it("ranks peg distribution rows by market cap and exposes leader links", () => {
    const snapshot = buildAltPegSnapshot(complete({ "eurc-circle": 60_000_000, "brz-transfero": 15_000_000, "paxg-paxos": 25_000_000 }));

    expect(snapshot.distributionRows.slice(0, 3).map((row) => row.peg)).toEqual(["EUR", "GOLD", "BRL"]);
    expect(snapshot.distributionRows[0]?.leaderHref).toBe("/stablecoin/eurc-circle/");
    expect(snapshot.distributionRows[0]?.href).toBe("/stablecoins/eur/");
    expect(snapshot.distributionRows[1]?.group).toBe("Commodity");
  });

  it("keeps an unavailable EUR coin visible without publishing a zero cap or share", () => {
    const eurIds = CORE_NON_USD_IDS.filter((id) => getCoreNonUsdPeg(id) === "EUR");
    const snapshot = buildAltPegSnapshot(complete(Object.fromEntries(eurIds.map((id) => [id, null]))));
    expect(snapshot.altSupplyUnavailableCount).toBe(eurIds.length);
    expect(snapshot.commoditySharePct).toBeNull();
    expect(snapshot.distributionRows.find((row) => row.peg === "EUR")).toMatchObject({
      marketCap: null, sharePct: null, supplyObservedCount: 0, supplyUnavailableCount: eurIds.length,
    });
  });

  it("publishes mixed coverage as a known subtotal and withholds complete shares", () => {
    const snapshot = buildAltPegSnapshot(complete({ "eurc-circle": 100, "eurs-stasis": null }));
    expect(snapshot.altMarketCap).toBe(100);
    expect(snapshot.distributionRows[0]).toMatchObject({
      peg: "EUR", marketCap: 100, sharePct: null, supplyObservedCount: expect.any(Number), supplyUnavailableCount: 1,
      leaderHref: "/stablecoin/eurc-circle/",
    });
  });

  it("counts a core coin missing from the list as unavailable, never as complete", () => {
    const snapshot = buildAltPegSnapshot(complete({ "eurc-circle": 100, "eurs-stasis": "omit" }));
    expect(snapshot.altCoinCount).toBe(CORE_NON_USD_IDS.length);
    expect(snapshot.altSupplyUnavailableCount).toBe(1);
    expect(snapshot.commoditySharePct).toBeNull();
    expect(snapshot.distributionRows.find((row) => row.peg === "EUR")?.supplyUnavailableCount).toBe(1);
  });

  it("distinguishes explicit zero from empty and invalid supply buckets", () => {
    const zero = buildAltPegSnapshot(complete({}));
    expect(zero.altMarketCap).toBe(0);
    expect(zero.altSupplyUnavailableCount).toBe(0);
    const unavailableBuckets: Record<string, number>[] = [{}, { usd: Number.NaN }, { usd: -1 }];
    for (const circulating of unavailableBuckets) {
      const missing = buildAltPegSnapshot([{ ...makeAltPegCoin("eurs-stasis", 0), circulating }]);
      expect(missing.totalMarketCap).toBeNull();
      expect(missing.altMarketCap).toBeNull();
    }
    expect(buildAltPegSnapshot([]).totalMarketCap).toBeNull();
  });

  it("builds one-year trend deltas from historical share points", () => {
    const stats = buildAltPegTrendStats([
      {
        date: 1_700_000_000,
        commodityShare: 1,
        fiatNonUsdShare: 1,
        commodity: 10,
        fiatNonUsd: 10,
        total: 1_000,
      },
      {
        date: 1_700_000_000 + 366 * 86400,
        commodityShare: 1.5,
        fiatNonUsdShare: 1.1,
        commodity: 20,
        fiatNonUsd: 18,
        total: 1_200,
      },
    ]);

    expect(stats?.latestSharePct).toBeCloseTo(2.6, 5);
    expect(stats?.latestAltMarketCap).toBe(38);
    expect(stats?.yearlyShareDeltaPctPoints).toBeCloseTo(0.6, 5);
    expect(stats?.yearlyMarketCapChangePct).toBeCloseTo(90, 5);
  });

  it("selects the newest reference at or before the exact yearly cutoff", () => {
    const cutoff = 1_700_000_000;
    const point = (date: number, value: number) => ({
      date, commodityShare: value, fiatNonUsdShare: 0, commodity: value * 10, fiatNonUsd: 0, total: 1_000,
    });
    expect(buildAltPegTrendStats([
      point(cutoff - 100, 1), point(cutoff, 2), point(cutoff + 1, 3),
      point(cutoff + 365 * 86400, 5),
    ])).toEqual({
      latestDate: cutoff + 365 * 86400, latestSharePct: 5, latestCoverageIncomplete: true, latestAltMarketCap: 50,
      yearlyShareDeltaPctPoints: 3, yearlyMarketCapChangePct: 150,
      valueCoverageIncomplete: true,
    });
  });

  it("leaves yearly deltas unknown with less than a year of history", () => {
    expect(buildAltPegTrendStats([
      { date: 1, commodityShare: 1, fiatNonUsdShare: 0, commodity: 10, fiatNonUsd: 0, total: 100 },
      { date: 365 * 86400, commodityShare: 2, fiatNonUsdShare: 0, commodity: 20, fiatNonUsd: 0, total: 100 },
    ])).toMatchObject({ yearlyShareDeltaPctPoints: null, yearlyMarketCapChangePct: null });
  });

  it("preserves measured zero without dividing by zero reference capital", () => {
    expect(buildAltPegTrendStats([
      { date: 1, commodityShare: 0, fiatNonUsdShare: 0, commodity: 0, fiatNonUsd: 0, total: 100 },
      { date: 1 + 365 * 86400, commodityShare: 2, fiatNonUsdShare: 0, commodity: 0, fiatNonUsd: 20, total: 100 },
    ])).toEqual({
      latestDate: 1 + 365 * 86400, latestSharePct: 2, latestCoverageIncomplete: true, latestAltMarketCap: 20,
      yearlyShareDeltaPctPoints: 2, yearlyMarketCapChangePct: null,
      valueCoverageIncomplete: true,
    });
  });

  it.each([undefined, null, { basis: "interior-gap-prior-value" as const, total: 0.99, commodity: 1, fiatNonUsd: 1 },
    { basis: "interior-gap-prior-value" as const, total: 1, commodity: 0.8, fiatNonUsd: 1 }])(
    "qualifies annual comparisons when either snapshot has partial or unknown coverage (%j)", (coverage) => {
      const complete = { basis: "interior-gap-prior-value" as const, total: 1, commodity: 1, fiatNonUsd: 1 };
      const old = { date: 1, commodityShare: 1, fiatNonUsdShare: 0, commodity: 10, fiatNonUsd: 0, total: 100 };
      const latest = { ...old, date: 1 + 365 * 86400, commodity: 20, coverage: complete };
      expect(buildAltPegTrendStats([{ ...old, coverage }, latest])?.valueCoverageIncomplete).toBe(true);
      expect(buildAltPegTrendStats([{ ...old, coverage: complete }, { ...latest, coverage }])?.valueCoverageIncomplete).toBe(true);
      expect(buildAltPegTrendStats([{ ...old, coverage: complete }, latest])?.valueCoverageIncomplete).toBe(false);
    },
  );

  it("returns no trend for absent or empty history", () => {
    expect(buildAltPegTrendStats()).toBeNull();
    expect(buildAltPegTrendStats([])).toBeNull();
  });

  it.each(["commodityShare", "fiatNonUsdShare", "commodity", "fiatNonUsd"])(
    "rejects unavailable %s rather than accepting it as a zero cohort",
    (field) => {
      const point = { date: 1, commodityShare: 0, fiatNonUsdShare: 0, commodity: 0, fiatNonUsd: 0, total: 100 };
      expect(NonUsdShareResponseSchema.parse([point])).toEqual([point]);
      for (const missing of [null, undefined, Number.NaN, Infinity]) {
        expect(NonUsdShareResponseSchema.safeParse([{ ...point, [field]: missing }]).success).toBe(false);
      }
    },
  );


  it("parses ?peg= case-insensitively and rejects USD and unknown values", () => {
    expect(parseAltPegParam("eur")).toBe("EUR");
    expect(parseAltPegParam("GOLD")).toBe("GOLD");
    expect(parseAltPegParam("usd")).toBeNull();
    expect(parseAltPegParam("nope")).toBeNull();
    expect(parseAltPegParam(null)).toBeNull();
  });
});
