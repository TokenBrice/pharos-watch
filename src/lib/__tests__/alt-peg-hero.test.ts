import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";
import { buildPegDiversityHero, PEG_HOME_RADIUS_PX } from "@/lib/alt-peg-hero";
import { coinEmblemSize } from "@/lib/alt-peg-sizing";
import { CLIENT_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";

function coin(overrides: {
  id: string;
  pegType?: string;
  circulating?: number;
  symbol?: string;
  name?: string;
}): StablecoinData {
  const { id, circulating = 1_000_000, pegType = "peggedEUR", symbol, name } = overrides;
  return makeStablecoin({
    id,
    name: name ?? id.toUpperCase(),
    symbol: symbol ?? id.slice(0, 4).toUpperCase(),
    pegType,
    priceSource: "defillama",
    circulating: { [pegType]: circulating },
  });
}

describe("buildPegDiversityHero", () => {
  it("groups EUR coins into a single cluster with largest at anchor", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "eurc-circle", circulating: 430_000_000, pegType: "peggedEUR" }),
      coin({ id: "eurs-stasis", circulating: 8_000_000, pegType: "peggedEUR" }),
    ]);
    const eur = hero.pegClusters.find((c) => c.peg === "EUR");
    expect(eur).toBeDefined();
    expect(eur!.rank).toBe(1);
    expect(eur!.coins).toHaveLength(2);
    expect(eur!.coins[0].id).toBe("eurc-circle");
    expect(eur!.coins[0].x).toBe(eur!.anchor.x);
    expect(eur!.coins[0].y).toBe(eur!.anchor.y);
  });

  it("puts commodity coins on a shelf ranked by market cap, not on orbits", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "kag-kinesis", pegType: "peggedSILVER", circulating: 284_000_000 }),
      coin({ id: "xaut-tether", pegType: "peggedGOLD", circulating: 2_600_000_000 }),
      coin({ id: "paxg-paxos", pegType: "peggedGOLD", circulating: 300_000_000 }),
    ]);
    expect(hero.shelfGroups.map((group) => [group.peg, group.label, group.rank])).toEqual([
      ["GOLD", "Gold", 1],
      ["SILVER", "Silver", 2],
    ]);
    expect(hero.shelfGroups[0]!.coins.map((c) => c.id)).toEqual(["xaut-tether", "paxg-paxos"]);
    expect(hero.shelfGroups[0]!.coins[0]!.sizePx).toBeGreaterThan(hero.shelfGroups[0]!.coins[1]!.sizePx);
    expect(hero.pegClusters).toHaveLength(0);
  });

  it("places every core non-USD coin exactly once, on the map or the shelf", () => {
    const assets = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS]
      .filter((id) => (CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD") !== "USD")
      .map((id) => coin({ id, circulating: 5_000_000 }));
    const hero = buildPegDiversityHero(assets);
    const placed = [...hero.pegClusters.flatMap((c) => c.coins), ...hero.shelfGroups.flatMap((g) => g.coins)].map((c) => c.id);
    expect(placed.sort()).toEqual(assets.map((a) => a.id).sort());
  });

  it("keeps every map emblem within its peg's home radius, even for the crowded euro cluster", () => {
    const assets = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS]
      .filter((id) => (CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD") !== "USD")
      .map((id) => coin({ id, circulating: 500_000_000 }));
    for (const cluster of buildPegDiversityHero(assets).pegClusters) {
      for (const placed of cluster.coins) {
        const distPx = Math.hypot((placed.x - cluster.anchor.x) * 9, (placed.y - cluster.anchor.y) * 4.6);
        expect(distPx).toBeLessThanOrEqual(PEG_HOME_RADIUS_PX + 1e-6);
      }
    }
  });

  it("skips USD-pegged coins entirely", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "usdc-circle", pegType: "peggedUSD", circulating: 60_000_000_000 }),
    ]);
    expect(hero.pegClusters).toHaveLength(0);
    expect(hero.shelfGroups).toHaveLength(0);
  });

  it("keeps unknown supply visible at neutral size and withholds unsupported ranks", () => {
    const hero = buildPegDiversityHero([
      { ...coin({ id: "eurc-circle" }), circulating: {} },
      coin({ id: "eurs-stasis", circulating: 0 }),
    ]);
    const eur = hero.pegClusters.find((cluster) => cluster.peg === "EUR")!;
    expect(eur.rank).toBeUndefined();
    const missing = eur.coins.find((row) => row.id === "eurc-circle")!;
    const zero = eur.coins.find((row) => row.id === "eurs-stasis")!;
    expect(missing.marketCap).toBeNull();
    expect(zero.marketCap).toBe(0);
    expect(missing.sizePx).toBe(coinEmblemSize(null, { ceil: 40 }));
    expect(missing.sizePx).toBeGreaterThan(zero.sizePx);
  });
});
