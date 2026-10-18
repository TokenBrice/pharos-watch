import { PEG_CHART_COLORS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { getCoreNonUsdPeg } from "@shared/lib/alt-peg-snapshot";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { PegCurrency, StablecoinData } from "@shared/types";
import { PEG_ANCHORS } from "@/lib/alt-peg-emblems";
import { arrangeClusterCoins, resolvePackedCoinOverlaps, type PackingInput } from "@/lib/alt-peg-packing";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SHELF_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { compareFiniteDesc } from "@shared/lib/sort";

export interface HeroCoin {
  id: string;
  symbol: string;
  name: string;
  href: string;
  logoSrc: string;
  pegCurrency: PegCurrency;
  marketCap: number | null;
}

export interface PlacedCoin extends HeroCoin {
  x: number;
  y: number;
  sizePx: number;
}

export interface PegCluster {
  peg: PegCurrency;
  rank?: number;
  anchor: { x: number; y: number };
  colorHex: string;
  coins: readonly PlacedCoin[];
}

/**
 * A non-geographic peg (commodity, index, unmapped) on the shelf above the map.
 * Groups and their coins are in market-cap order; the shelf lays them out, so
 * position is rank, never a decorative orbit.
 */
export interface ShelfGroup {
  peg: PegCurrency;
  label: string;
  rank?: number;
  colorHex: string;
  coins: readonly PlacedCoin[];
}

export interface PegDiversityHero {
  pegClusters: readonly PegCluster[];
  shelfGroups: readonly ShelfGroup[];
}

function resolveLogo(coin: StablecoinData): string | undefined {
  return getLogoSrc(logosById, coin.id);
}

function toHeroCoin(coin: StablecoinData, peg: PegCurrency): HeroCoin | null {
  const logoSrc = resolveLogo(coin);
  if (!logoSrc) return null;
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    href: buildStablecoinUrl(coin.id),
    logoSrc,
    pegCurrency: peg,
    marketCap: getCirculatingRawOrNull(coin),
  };
}

function placeFiatCluster(peg: PegCurrency, coins: HeroCoin[], rank?: number): PegCluster | null {
  const anchor = PEG_ANCHORS[peg];
  if (!anchor) return null;
  if (coins.length === 0) return null;

  const inputs: PackingInput[] = coins.map((c) => ({
    id: c.id,
    sizePx: coinEmblemSize(c.marketCap, { ceil: FIAT_MAP_SIZE_CEIL }),
    marketCap: c.marketCap,
  }));
  const packed = arrangeClusterCoins(anchor, inputs);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const placed: PlacedCoin[] = packed.map((p) => {
    const base = byId.get(p.id)!;
    return { ...base, x: p.x, y: p.y, sizePx: p.sizePx };
  });

  return {
    peg,
    rank,
    anchor,
    colorHex: PEG_CHART_COLORS[peg]?.hex ?? "#64748b",
    coins: placed,
  };
}

function placeShelfGroup(peg: PegCurrency, coins: HeroCoin[], rank?: number): ShelfGroup {
  const byCap = compareFiniteDesc<HeroCoin>((coin) => coin.marketCap ?? Number.NaN);
  return {
    peg,
    label: PEG_LABELS_SHORT[peg] ?? peg,
    rank,
    colorHex: PEG_CHART_COLORS[peg]?.hex ?? "#64748b",
    // Shelf emblems sit centred in their own slot, so the slot owns position.
    coins: [...coins].sort(byCap).map((coin) => ({
      ...coin,
      x: 50,
      y: 50,
      sizePx: coinEmblemSize(coin.marketCap, { ceil: SHELF_SIZE_CEIL }),
    })),
  };
}

function knownCap(coins: readonly HeroCoin[]): number | null {
  const observed = coins.filter((coin) => coin.marketCap !== null);
  return observed.length > 0 ? observed.reduce((sum, coin) => sum + coin.marketCap!, 0) : null;
}

/**
 * Furthest a coin may sit from its peg's anchor, in the 900×460 map plane. The
 * overlap pass may not push a dense cluster (the euro) onto another continent:
 * past this radius emblems stack (smaller ones on top) instead of spreading.
 */
export const PEG_HOME_RADIUS_PX = 34;
const PLANE_PX_PER_PCT = { x: 9, y: 4.6 };

function keepNearHome(coin: PlacedCoin, anchor: { x: number; y: number }): PlacedCoin {
  const dxPx = (coin.x - anchor.x) * PLANE_PX_PER_PCT.x;
  const dyPx = (coin.y - anchor.y) * PLANE_PX_PER_PCT.y;
  const distPx = Math.hypot(dxPx, dyPx);
  if (distPx <= PEG_HOME_RADIUS_PX) return coin;
  const k = PEG_HOME_RADIUS_PX / distPx;
  return { ...coin, x: anchor.x + (coin.x - anchor.x) * k, y: anchor.y + (coin.y - anchor.y) * k };
}

function separateFiatClusterLogos(clusters: readonly PegCluster[]): PegCluster[] {
  if (clusters.length < 2) {
    return clusters.map((cluster) => ({ ...cluster, coins: cluster.coins.map((coin) => keepNearHome(coin, cluster.anchor)) }));
  }

  const flat = clusters.flatMap((cluster) => cluster.coins);
  const leaderIds = new Set(clusters.map((cluster) => cluster.coins[0]?.id).filter(Boolean));
  const separated = resolvePackedCoinOverlaps(flat, {
    paddingPx: 6,
    getMobility: (coin) => (leaderIds.has(coin.id) ? 0.24 : 1),
  });
  const byId = new Map(separated.map((coin) => [coin.id, coin]));

  return clusters.map((cluster) => ({
    ...cluster,
    coins: cluster.coins.map((coin) => keepNearHome(byId.get(coin.id) ?? coin, cluster.anchor)),
  }));
}

export function buildPegDiversityHero(peggedAssets: readonly StablecoinData[] | undefined): PegDiversityHero {
  if (!peggedAssets || peggedAssets.length === 0) {
    return { pegClusters: [], shelfGroups: [] };
  }

  const byPeg = new Map<PegCurrency, HeroCoin[]>();
  for (const raw of peggedAssets) {
    const peg = getCoreNonUsdPeg(raw.id);
    if (peg === null) continue;
    const hero = toHeroCoin(raw, peg);
    if (!hero) continue;
    const list = byPeg.get(peg) ?? [];
    if (list.some((coin) => coin.id === hero.id)) continue;
    list.push(hero);
    byPeg.set(peg, list);
  }

  const cohortRankByPeg = new Map<PegCurrency, number>();
  // No complete-cohort rank can be supported while any plotted supply is unknown.
  if ([...byPeg.values()].every((coins) => coins.every((coin) => coin.marketCap !== null))) {
    [...byPeg.entries()]
      .map(([peg, coins]) => [peg, coins.reduce((sum, coin) => sum + coin.marketCap!, 0)] as const)
      .sort((left, right) => right[1] - left[1])
      .forEach(([peg], index) => cohortRankByPeg.set(peg, index + 1));
  }

  const pegClusters: PegCluster[] = [];
  const shelfGroups: ShelfGroup[] = [];

  for (const [peg, coins] of byPeg) {
    // A peg with no home territory (commodities, indexes, unmapped currencies) goes on the shelf, never off the atlas.
    const cluster = placeFiatCluster(peg, coins, cohortRankByPeg.get(peg));
    if (cluster) pegClusters.push(cluster);
    else shelfGroups.push(placeShelfGroup(peg, coins, cohortRankByPeg.get(peg)));
  }

  pegClusters.sort((a, b) => {
    const aMax = a.coins[0]?.marketCap ?? null;
    const bMax = b.coins[0]?.marketCap ?? null;
    if (aMax === null) return bMax === null ? 0 : -1;
    if (bMax === null) return 1;
    return aMax - bMax;
  });
  shelfGroups.sort(compareFiniteDesc<ShelfGroup>((group) => knownCap(group.coins) ?? Number.NaN));

  return { pegClusters: separateFiatClusterLogos(pegClusters), shelfGroups };
}
