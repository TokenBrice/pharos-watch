import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import type { PegCurrency, StablecoinData } from "@shared/types";
import { PEG_ANCHORS } from "@/lib/alt-peg-emblems";
import { arrangeClusterCoins, type PackingInput } from "@/lib/alt-peg-packing";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@/lib/urls";

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
  anchor: { x: number; y: number };
  colorHex: string;
  coins: readonly PlacedCoin[];
}

export type SkyCohortKind = "sun" | "moon" | "constellation";

export interface SkyCohort {
  kind: SkyCohortKind;
  label: string;
  href: string;
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
  sun: { cx: 20, cy: 48, spreadX: 20, spreadY: 34 },
  moon: { cx: 50, cy: 42, spreadX: 10, spreadY: 30 },
  constellation: { cx: 82, cy: 55, spreadX: 15, spreadY: 35 },
};

interface LlamaCoin {
  llamaId?: string;
}

function resolveLogo(coin: StablecoinData): string | undefined {
  const byId = logosById[coin.id];
  if (byId) return byId;
  const llamaId = (coin as unknown as LlamaCoin).llamaId;
  return llamaId ? logosById[llamaId] : undefined;
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

function placeFiatCluster(peg: PegCurrency, coins: HeroCoin[]): PegCluster | null {
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
    anchor,
    colorHex: PEG_CHART_COLORS[peg]?.hex ?? "#64748b",
    coins: placed,
  };
}

function placeSkyCohort(kind: SkyCohortKind, coins: HeroCoin[]): SkyCohort {
  const template = EMPTY_SKY.find((c) => c.kind === kind)!;
  if (coins.length === 0) return template;

  const sorted = [...coins].sort((a, b) => b.marketCap - a.marketCap);
  const layout = SKY_LAYOUT[kind];
  const placed: PlacedCoin[] = sorted.map((coin, index) => {
    const sizePx = coinEmblemSize(coin.marketCap);
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

  return { ...template, coins: placed };
}

export function buildPegDiversityHero(peggedAssets: readonly StablecoinData[] | undefined): PegDiversityHero {
  if (!peggedAssets || peggedAssets.length === 0) {
    return { pegClusters: [], skyCohorts: EMPTY_SKY };
  }

  const byPeg = new Map<PegCurrency, HeroCoin[]>();
  for (const raw of peggedAssets) {
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
    const cluster = placeFiatCluster(peg, coins);
    if (cluster) pegClusters.push(cluster);
  }

  pegClusters.sort((a, b) => {
    const aMax = a.coins[0]?.marketCap ?? 0;
    const bMax = b.coins[0]?.marketCap ?? 0;
    return bMax - aMax;
  });

  const skyCohorts: readonly SkyCohort[] = [
    placeSkyCohort("sun", goldCoins),
    placeSkyCohort("moon", silverCoins),
    placeSkyCohort("constellation", varCoins),
  ];

  return { pegClusters, skyCohorts };
}
