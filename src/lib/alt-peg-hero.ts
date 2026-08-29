import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import type { PegCurrency, StablecoinData } from "@shared/types";
import { PEG_ANCHORS } from "@/lib/alt-peg-emblems";
import { arrangeClusterCoins, resolvePackedCoinOverlaps, type PackingInput } from "@/lib/alt-peg-packing";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SKY_COHORT_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { compareFiniteDesc } from "@shared/lib/sort";

export interface HeroCoin {
  id: string;
  symbol: string;
  name: string;
  href: string;
  logoSrc: string;
  pegCurrency: PegCurrency;
  marketCap: number;
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

export type SkyCohortKind = "sun" | "moon" | "constellation";

export interface SkyCohort {
  kind: SkyCohortKind;
  label: string;
  href: string;
  rank?: number;
  coins: readonly PlacedCoin[];
}

export interface PegDiversityHero {
  pegClusters: readonly PegCluster[];
  skyCohorts: readonly SkyCohort[];
}

const EMPTY_SKY: readonly SkyCohort[] = [
  { kind: "sun", label: "Gold", href: "/alt-pegs/gold", coins: [] },
  { kind: "moon", label: "Silver", href: "/alt-pegs/silver", coins: [] },
  { kind: "constellation", label: "CPI", href: "/stablecoins/cpi", coins: [] },
];

// Sky cohort centers & spread (percentages of the sky layer). The sun sits
// left, moon center, constellation right; secondary coins ring outward.
const SKY_LAYOUT: Record<SkyCohortKind, { cx: number; cy: number; spreadX: number; spreadY: number }> = {
  sun: { cx: 19, cy: 48, spreadX: 18, spreadY: 28 },
  moon: { cx: 50, cy: 42, spreadX: 9, spreadY: 26 },
  constellation: { cx: 82, cy: 52, spreadX: 13, spreadY: 30 },
};

function resolveLogo(coin: StablecoinData): string | undefined {
  return logosById[coin.id];
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
    marketCap: getCirculatingRaw(coin),
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

function placeSkyCohort(kind: SkyCohortKind, coins: HeroCoin[], rank?: number): SkyCohort {
  const template = EMPTY_SKY.find((c) => c.kind === kind)!;
  if (coins.length === 0) return template;

  const sorted = [...coins].sort(compareFiniteDesc<HeroCoin>((coin) => coin.marketCap));
  const layout = SKY_LAYOUT[kind];
  const placed: PlacedCoin[] = sorted.map((coin, index) => {
    const sizePx = coinEmblemSize(coin.marketCap, { ceil: SKY_COHORT_SIZE_CEIL });
    if (index === 0) return { ...coin, x: layout.cx, y: layout.cy, sizePx };
    const angle = ((index - 1) / Math.max(1, sorted.length - 1)) * Math.PI * 2;
    const orbitRx = layout.spreadX * (0.35 + (index % 3) * 0.25);
    const orbitRy = layout.spreadY * (0.25 + (index % 3) * 0.22);
    return {
      ...coin,
      x: layout.cx + Math.cos(angle) * orbitRx,
      y: layout.cy + Math.sin(angle) * orbitRy,
      sizePx,
    };
  });

  return {
    ...template,
    rank,
    coins: resolvePackedCoinOverlaps(placed, {
      frameWidthPx: 1000,
      frameHeightPx: 180,
      paddingPx: 7,
      getMobility: (coin) => (coin.id === placed[0]?.id ? 0.18 : 1),
    }),
  };
}

function separateFiatClusterLogos(clusters: readonly PegCluster[]): PegCluster[] {
  if (clusters.length < 2) return [...clusters];

  const flat = clusters.flatMap((cluster) => cluster.coins);
  const leaderIds = new Set(clusters.map((cluster) => cluster.coins[0]?.id).filter(Boolean));
  const separated = resolvePackedCoinOverlaps(flat, {
    paddingPx: 6,
    getMobility: (coin) => (leaderIds.has(coin.id) ? 0.24 : 1),
  });
  const byId = new Map(separated.map((coin) => [coin.id, coin]));

  return clusters.map((cluster) => ({
    ...cluster,
    coins: cluster.coins.map((coin) => byId.get(coin.id) ?? coin),
  }));
}

export function buildPegDiversityHero(peggedAssets: readonly StablecoinData[] | undefined): PegDiversityHero {
  if (!peggedAssets || peggedAssets.length === 0) {
    return { pegClusters: [], skyCohorts: EMPTY_SKY };
  }

  const byPeg = new Map<PegCurrency, HeroCoin[]>();
  for (const raw of peggedAssets) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(raw.id)) continue;
    const meta = ACTIVE_META_BY_ID.get(raw.id);
    if (!meta) continue;
    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;
    const hero = toHeroCoin(raw, peg);
    if (!hero) continue;
    const list = byPeg.get(peg) ?? [];
    list.push(hero);
    byPeg.set(peg, list);
  }

  const cohortRankByPeg = new Map<PegCurrency, number>(
    [...byPeg.entries()]
      .map(([peg, coins]) => [peg, coins.reduce((sum, coin) => sum + coin.marketCap, 0)] as const)
      .sort((left, right) => right[1] - left[1])
      .map(([peg], index) => [peg, index + 1]),
  );

  const pegClusters: PegCluster[] = [];
  const goldCoins: HeroCoin[] = [];
  const silverCoins: HeroCoin[] = [];
  const varCoins: HeroCoin[] = [];

  for (const [peg, coins] of byPeg) {
    if (peg === "GOLD") {
      goldCoins.push(...coins);
      continue;
    }
    if (peg === "SILVER") {
      silverCoins.push(...coins);
      continue;
    }
    if (peg === "VAR") {
      varCoins.push(...coins);
      continue;
    }
    const cluster = placeFiatCluster(peg, coins, cohortRankByPeg.get(peg));
    if (cluster) pegClusters.push(cluster);
  }

  pegClusters.sort((a, b) => {
    const aMax = a.coins[0]?.marketCap ?? 0;
    const bMax = b.coins[0]?.marketCap ?? 0;
    return aMax - bMax;
  });
  const separatedPegClusters = separateFiatClusterLogos(pegClusters);

  const skyCohorts: readonly SkyCohort[] = [
    placeSkyCohort("sun", goldCoins, cohortRankByPeg.get("GOLD")),
    placeSkyCohort("moon", silverCoins, cohortRankByPeg.get("SILVER")),
    placeSkyCohort("constellation", varCoins, cohortRankByPeg.get("VAR")),
  ];

  return { pegClusters: separatedPegClusters, skyCohorts };
}
