import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
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

  it("builds taxonomy-backed non-USD link hub groups", () => {
    const groups = buildAltPegLinkHubGroups();

    const fiatGroup = groups.find((group) => group.label === "Fiat");
    const commodityGroup = groups.find((group) => group.label === "Commodity");

    expect(fiatGroup?.items.some((item) => item.href === "/stablecoins/eur/")).toBe(true);
    expect(commodityGroup?.items.some((item) => item.href === "/stablecoins/gold/")).toBe(true);
    expect(groups.some((group) => group.items.some((item) => item.href === "/stablecoins/usd/"))).toBe(false);
  });
});
