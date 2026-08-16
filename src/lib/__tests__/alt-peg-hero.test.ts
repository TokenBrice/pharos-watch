import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";

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
  it("returns empty clusters and 3 empty sky cohorts for undefined input", () => {
    const hero = buildPegDiversityHero(undefined);
    expect(hero.pegClusters).toEqual([]);
    expect(hero.skyCohorts).toHaveLength(3);
    for (const sc of hero.skyCohorts) expect(sc.coins).toEqual([]);
  });

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

  it("keeps lower-cap fiat clusters earlier in render order for hit testing", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "eurc-circle", circulating: 430_000_000, pegType: "peggedEUR" }),
      coin({ id: "jpyc-jpyc", circulating: 2_000_000, pegType: "peggedJPY" }),
    ]);

    expect(hero.pegClusters.map((cluster) => cluster.peg)).toEqual(["JPY", "EUR"]);
    expect(hero.pegClusters.find((cluster) => cluster.peg === "EUR")?.rank).toBe(1);
    expect(hero.pegClusters.find((cluster) => cluster.peg === "JPY")?.rank).toBe(2);
  });

  it("routes commodity coins into sun/moon cohorts", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "xaut-tether", pegType: "peggedGOLD", circulating: 2_600_000_000 }),
      coin({ id: "kag-kinesis", pegType: "peggedSILVER", circulating: 284_000_000 }),
    ]);
    const sun = hero.skyCohorts.find((c) => c.kind === "sun");
    const moon = hero.skyCohorts.find((c) => c.kind === "moon");
    expect(sun!.rank).toBe(1);
    expect(moon!.rank).toBe(2);
    expect(sun!.coins.some((c) => c.id === "xaut-tether")).toBe(true);
    expect(moon!.coins.some((c) => c.id === "kag-kinesis")).toBe(true);
  });

  it("routes VAR coins into the constellation cohort", () => {
    const hero = buildPegDiversityHero([coin({ id: "fpi-frax", pegType: "peggedVAR", circulating: 96_000_000 })]);
    const con = hero.skyCohorts.find((c) => c.kind === "constellation");
    expect(con!.coins.map((c) => c.id)).toContain("fpi-frax");
  });

  it("skips USD-pegged coins entirely", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "usdc-circle", pegType: "peggedUSD", circulating: 60_000_000_000 }),
    ]);
    expect(hero.pegClusters).toHaveLength(0);
    for (const sc of hero.skyCohorts) expect(sc.coins).toHaveLength(0);
  });
});
