import { describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";
import { buildPegDiversityHero, PEG_HOME_RADIUS_PX } from "@/lib/alt-peg-hero";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SHELF_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { CLIENT_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { buildAltPegSnapshot } from "@/lib/alt-peg-market";
import * as logos from "@/lib/logos";

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

function completeUniverse(overrides: StablecoinData[] = []): StablecoinData[] {
  const byId = new Map(overrides.map((row) => [row.id, row]));
  return [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS]
    .filter((id) => (CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD") !== "USD")
    .map((id) => byId.get(id) ?? coin({ id, circulating: 0 }));
}

describe("buildPegDiversityHero", () => {
  it("groups EUR coins around their home anchor with the largest first", () => {
    const hero = buildPegDiversityHero(completeUniverse([
      coin({ id: "eurc-circle", circulating: 430_000_000, pegType: "peggedEUR" }),
      coin({ id: "eurs-stasis", circulating: 8_000_000, pegType: "peggedEUR" }),
    ]));
    const eur = hero.pegClusters.find((c) => c.peg === "EUR");
    expect(eur).toBeDefined();
    expect(eur!.rank).toBe(1);
    expect(eur!.coins).toHaveLength(completeUniverse().filter((row) => CLIENT_ACTIVE_META_BY_ID.get(row.id)?.flags.pegCurrency === "EUR").length);
    expect(eur!.coins[0].id).toBe("eurc-circle");
    expect(Math.hypot((eur!.coins[0].x - eur!.anchor.x) * 9, (eur!.coins[0].y - eur!.anchor.y) * 4.6))
      .toBeLessThanOrEqual(PEG_HOME_RADIUS_PX + 1e-6);
  });

  it("puts commodity coins on a shelf ranked by market cap, not on orbits", () => {
    const hero = buildPegDiversityHero(completeUniverse([
      coin({ id: "kag-kinesis", pegType: "peggedSILVER", circulating: 284_000_000 }),
      coin({ id: "xaut-tether", pegType: "peggedGOLD", circulating: 2_600_000_000 }),
      coin({ id: "paxg-paxos", pegType: "peggedGOLD", circulating: 300_000_000 }),
    ]));
    expect(hero.shelfGroups.slice(0, 2).map((group) => [group.peg, group.label, group.rank])).toEqual([
      ["GOLD", "Gold", 1],
      ["SILVER", "Silver", 2],
    ]);
    expect(hero.shelfGroups[0]!.coins.slice(0, 2).map((c) => c.id)).toEqual(["xaut-tether", "paxg-paxos"]);
    expect(hero.shelfGroups[0]!.coins[0]!.sizePx).toBeGreaterThan(hero.shelfGroups[0]!.coins[1]!.sizePx);
    expect(hero.pegClusters.every((cluster) => cluster.cohort.marketCap === 0)).toBe(true);
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
    const placed = [...hero.pegClusters, ...hero.shelfGroups].flatMap((group) => group.coins);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.some((row) => row.id === "usdc-circle" || row.pegCurrency === "USD")).toBe(false);
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

  it.each(["eurc-circle", "xaut-tether"])("keeps omitted %s equivalent to an unavailable supply bucket", (id) => {
    const complete = completeUniverse().map((row) => ({ ...row, circulating: { usd: 10 } }));
    const omitted = complete.filter((row) => row.id !== id);
    const explicit = complete.map((row) => row.id === id ? { ...row, circulating: {} } : row);
    const hero = buildPegDiversityHero(omitted);
    expect(hero).toEqual(buildPegDiversityHero(explicit));
    const snapshot = buildAltPegSnapshot(omitted);
    const groups = [...hero.pegClusters, ...hero.shelfGroups];
    const marker = groups.flatMap((group) => group.coins).find((row) => row.id === id)!;
    const meta = CLIENT_ACTIVE_META_BY_ID.get(id)!;
    expect(marker).toMatchObject({ name: meta.name, symbol: meta.symbol, marketCap: null });
    expect(marker.sizePx).toBe(coinEmblemSize(null, { ceil: marker.pegCurrency === "EUR" ? FIAT_MAP_SIZE_CEIL : SHELF_SIZE_CEIL }));
    expect(groups.reduce((count, group) => count + group.cohort.coinCount, 0)).toBe(snapshot.altCoinCount);
    for (const group of groups) {
      const expected = snapshot.distributionRows.find((row) => row.peg === group.peg)!;
      expect(group.cohort).toMatchObject({
        coinCount: expected.coinCount,
        marketCap: expected.marketCap,
        supplyUnavailableCount: expected.supplyUnavailableCount,
        sharePct: null,
      });
      expect(group.rank).toBeUndefined();
    }
    const affected = groups.find((group) => group.peg === marker.pegCurrency)!;
    expect(affected.cohort.supplyUnavailableCount).toBe(1);
    expect(affected.cohort.marketCap).toBe((affected.cohort.coinCount - 1) * 10);
  });

  it("keeps no-logo members in cohort totals and rank admission", () => {
    const getLogo = logos.getLogoSrc;
    const spy = vi.spyOn(logos, "getLogoSrc").mockImplementation((mapping, id) =>
      id === "eurs-stasis" ? undefined : getLogo(mapping, id));
    try {
      const assets = completeUniverse([coin({ id: "eurc-circle", circulating: 100 }), coin({ id: "eurs-stasis", circulating: 200 })]);
      const complete = buildPegDiversityHero(assets).pegClusters.find((group) => group.peg === "EUR")!;
      expect(complete.coins.some((row) => row.id === "eurs-stasis")).toBe(false);
      expect(complete.cohort.marketCap).toBe(300);
      expect(complete.rank).toBe(1);
      const partial = buildPegDiversityHero(assets.filter((row) => row.id !== "eurs-stasis"));
      const eur = partial.pegClusters.find((group) => group.peg === "EUR")!;
      expect(eur.cohort).toMatchObject({ marketCap: 100, supplyUnavailableCount: 1, coinCount: complete.cohort.coinCount });
      expect([...partial.pegClusters, ...partial.shelfGroups].every((group) => group.rank === undefined)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([undefined, []])("keeps absent or empty list responses empty: %j", (assets) => {
    expect(buildPegDiversityHero(assets)).toEqual({ pegClusters: [], shelfGroups: [] });
  });
});
