import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { NonUsdShareResponseSchema } from "@shared/types/market";
import { buildAltPegLinkHubGroups, buildAltPegSnapshot, buildAltPegTrendStats } from "@/lib/alt-peg-market";

function makeCoin(id: string, marketCap: number) {
  return makeStablecoin({
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegMechanism: "",
    supplySource: "test",
    circulating: { usd: marketCap },
  });
}

describe("alt-peg-market", () => {
  it("joins live rows to tracked metadata and filters out USD assets", () => {
    const snapshot = buildAltPegSnapshot([
      makeCoin("usdc-circle", 120_000_000),
      makeCoin("eurc-circle", 55_000_000),
      makeCoin("brz-transfero", 12_000_000),
      makeCoin("paxg-paxos", 18_000_000),
    ]);

    expect(snapshot.altCoinCount).toBe(3);
    expect(snapshot.altPegCount).toBe(3);
    expect(snapshot.totalMarketCap).toBe(205_000_000);
    expect(snapshot.altMarketCap).toBe(85_000_000);
    expect(snapshot.altSharePct).toBeCloseTo(41.46, 1);
    expect(snapshot.fiatNonUsdMarketCap).toBe(67_000_000);
    expect(snapshot.commodityMarketCap).toBe(18_000_000);
  });

  it("ranks peg distribution rows by market cap and exposes leader links", () => {
    const snapshot = buildAltPegSnapshot([
      makeCoin("eurc-circle", 60_000_000),
      makeCoin("brz-transfero", 15_000_000),
      makeCoin("paxg-paxos", 25_000_000),
    ]);

    expect(snapshot.distributionRows.map((row) => row.peg)).toEqual(["EUR", "GOLD", "BRL"]);
    expect(snapshot.distributionRows[0]?.leaderHref).toBe("/stablecoin/eurc-circle/");
    expect(snapshot.distributionRows[0]?.href).toBe("/stablecoins/eur/");
    expect(snapshot.distributionRows[1]?.group).toBe("Commodity");
  });

  it("keeps an unavailable EUR cohort visible without publishing a zero cap or share", () => {
    const missing = { ...makeCoin("eurs-stasis", 0), circulating: {} };
    const snapshot = buildAltPegSnapshot([makeCoin("usdc-circle", 100), missing]);
    expect(snapshot.altCoinCount).toBe(1);
    expect(snapshot.altMarketCap).toBeNull();
    expect(snapshot.altSharePct).toBeNull();
    expect(snapshot.supplyUnavailableCount).toBe(1);
    expect(snapshot.distributionRows[0]).toMatchObject({
      peg: "EUR", marketCap: null, sharePct: null, supplyObservedCount: 0, supplyUnavailableCount: 1,
    });
    expect(snapshot.topRows).toEqual([]);
  });

  it("publishes mixed coverage as a known subtotal and withholds complete shares", () => {
    const snapshot = buildAltPegSnapshot([
      makeCoin("eurc-circle", 100), { ...makeCoin("eurs-stasis", 0), circulating: {} },
      makeCoin("usdc-circle", 100),
    ]);
    expect(snapshot.altMarketCap).toBe(100);
    expect(snapshot.altSharePct).toBeNull();
    expect(snapshot.distributionRows[0]).toMatchObject({
      marketCap: 100, sharePct: null, supplyObservedCount: 1, supplyUnavailableCount: 1,
      leaderHref: "/stablecoin/eurc-circle/",
    });
  });

  it("distinguishes explicit zero from empty and invalid supply buckets", () => {
    const zero = buildAltPegSnapshot([makeCoin("usdc-circle", 100), makeCoin("eurs-stasis", 0)]);
    expect(zero.altMarketCap).toBe(0);
    expect(zero.altSharePct).toBe(0);
    expect(zero.distributionRows[0].marketCap).toBe(0);
    expect(zero.supplyUnavailableCount).toBe(0);
    const unavailableBuckets: Record<string, number>[] = [{}, { usd: Number.NaN }, { usd: -1 }];
    for (const circulating of unavailableBuckets) {
      const missing = buildAltPegSnapshot([{ ...makeCoin("eurs-stasis", 0), circulating }]);
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
      latestSharePct: 5, latestAltMarketCap: 50,
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
      latestSharePct: 2, latestAltMarketCap: 20,
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

  it("builds taxonomy-backed non-USD link hub groups", () => {
    const groups = buildAltPegLinkHubGroups();

    const fiatGroup = groups.find((group) => group.label === "Fiat");
    const commodityGroup = groups.find((group) => group.label === "Commodity");

    expect(fiatGroup?.items.some((item) => item.href === "/stablecoins/eur/")).toBe(true);
    expect(commodityGroup?.items.some((item) => item.href === "/stablecoins/gold/")).toBe(true);
    expect(groups.some((group) => group.items.some((item) => item.href === "/stablecoins/usd/"))).toBe(false);
  });
});
