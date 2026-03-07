"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPegDeviation } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData } from "@shared/types";

/* ─── Constants ─────────────────────────────────────────────────── */

const SKELETON_DEPEG_INDICES = Array.from({ length: 4 }, (_, i) => i);
const SKELETON_MOVER_INDICES = Array.from({ length: 3 }, (_, i) => i);

const SUPPLY_FLOOR = 1_000_000;

/**
 * Responsive visibility classes per item index.
 * Index 0-1: always visible.
 * Index 2: visible from sm+.
 * Index 3: visible from lg+ (depegs only — movers cap at 3).
 */
const DEPEG_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "hidden sm:flex",
  3: "hidden lg:flex",
};

const MOVER_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "hidden sm:flex",
};

/* ─── Types ─────────────────────────────────────────────────────── */

interface MarketHighlightsProps {
  data: StablecoinData[] | undefined;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
}

interface DepegItem {
  id: string;
  symbol: string;
  name: string;
  bps: number;
}

interface MoverEntry {
  id: string;
  symbol: string;
  name: string;
  pctChange: number;
}

/* ─── Data hooks ────────────────────────────────────────────────── */

function useDepegs(data: StablecoinData[] | undefined, pegRates: Record<string, number>) {
  return useMemo(() => {
    if (!data) return [];

    const entries: DepegItem[] = [];

    for (const coin of data) {
      const meta = TRACKED_META_BY_ID.get(coin.id);
      if (!meta) continue;
      if (meta.flags.navToken) continue;
      if (coin.price == null || typeof coin.price !== "number" || isNaN(coin.price)) continue;
      const supply = getCirculatingRaw(coin);
      if (supply < SUPPLY_FLOOR) continue;

      const pegRef = getPegReference(coin.pegType, pegRates, meta.commodityOunces);
      if (pegRef === 0) continue;
      const bps = Math.round(((coin.price / pegRef) - 1) * 10000);

      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, bps });
    }

    entries.sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
    return entries.slice(0, 4);
  }, [data, pegRates]);
}

function useMovers(data: StablecoinData[] | undefined) {
  return useMemo(() => {
    if (!data) return { growers: [] as MoverEntry[], shrinkers: [] as MoverEntry[] };

    const entries: MoverEntry[] = [];

    for (const coin of data) {
      if (!TRACKED_IDS.has(coin.id)) continue;
      const current = getCirculatingRaw(coin);
      const prev = getPrevWeekRaw(coin);
      if (current < SUPPLY_FLOOR || prev < SUPPLY_FLOOR) continue;

      const pctChange = ((current - prev) / prev) * 100;
      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, pctChange });
    }

    const sorted = [...entries].sort((a, b) => b.pctChange - a.pctChange);
    return {
      growers: sorted.slice(0, 3),
      shrinkers: sorted.slice(-3).reverse().filter((e) => e.pctChange < 0),
    };
  }, [data]);
}

/* ─── Color helpers ─────────────────────────────────────────────── */

/**
 * Sign-aware depeg color:
 * - Below peg (negative bps): red — insolvency/redemption concern
 * - Above peg (positive bps): amber — liquidity premium
 * - Near peg (<10 bps absolute): muted
 */
function depegColorClass(bps: number): string {
  const abs = Math.abs(bps);
  if (abs < 10) return "text-muted-foreground";
  if (bps < 0) return "text-red-700 dark:text-red-400";
  return "text-amber-700 dark:text-amber-400";
}

/* ─── Sub-components ────────────────────────────────────────────── */

function DepegEntry({
  entry,
  logos,
  visClass,
}: {
  entry: DepegItem;
  logos?: Record<string, string>;
  visClass: string;
}) {
  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      className={`${visClass} pharos-focus-ring group items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40`}
    >
      <StablecoinLogo src={logos?.[entry.id]} name={entry.name} size={16} />
      <span className="text-xs font-medium group-hover:underline group-focus-visible:underline">
        {entry.symbol}
      </span>
      <span className={`text-xs font-mono font-semibold ${depegColorClass(entry.bps)}`}>
        {formatPegDeviation(entry.bps / 10000 + 1, 1)}
      </span>
    </Link>
  );
}

function MoverPairRow({
  grower,
  shrinker,
  logos,
  visClass,
}: {
  grower: MoverEntry | undefined;
  shrinker: MoverEntry | undefined;
  logos?: Record<string, string>;
  visClass: string;
}) {
  return (
    <div className={`${visClass} grid grid-cols-2 gap-x-3`}>
      {grower ? (
        <Link
          href={buildStablecoinUrl(grower.id)}
          className="pharos-focus-ring group flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40"
        >
          <StablecoinLogo src={logos?.[grower.id]} name={grower.name} size={16} />
          <span className="truncate text-xs font-medium group-hover:underline group-focus-visible:underline">
            {grower.symbol}
          </span>
          <span className="text-xs font-mono font-semibold text-emerald-700 dark:text-emerald-400 ml-auto flex-shrink-0">
            +{grower.pctChange.toFixed(1)}%
          </span>
        </Link>
      ) : (
        <div />
      )}
      {shrinker ? (
        <Link
          href={buildStablecoinUrl(shrinker.id)}
          className="pharos-focus-ring group flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40"
        >
          <StablecoinLogo src={logos?.[shrinker.id]} name={shrinker.name} size={16} />
          <span className="truncate text-xs font-medium group-hover:underline group-focus-visible:underline">
            {shrinker.symbol}
          </span>
          <span className="text-xs font-mono font-semibold text-red-700 dark:text-red-400 ml-auto flex-shrink-0">
            {shrinker.pctChange.toFixed(1)}%
          </span>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}

/* ─── Skeleton ──────────────────────────────────────────────────── */

function MarketSignalsSkeleton() {
  return (
    <div className="pharos-card-shell flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40">
      {/* Depegs skeleton */}
      <div className="flex-1 p-4 space-y-2.5">
        <Skeleton className="h-2.5 w-24" />
        <div className="grid grid-cols-2 gap-2">
          {SKELETON_DEPEG_INDICES.map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
      {/* Movers skeleton */}
      <div className="flex-1 p-4 space-y-2.5">
        <Skeleton className="h-2.5 w-20" />
        <div className="space-y-2">
          {SKELETON_MOVER_INDICES.map((i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Main export ───────────────────────────────────────────────── */

export function MarketHighlights({ data, logos, pegRates }: MarketHighlightsProps) {
  const depegs = useDepegs(data, pegRates ?? {});
  const { growers, shrinkers } = useMovers(data);

  if (!data) return <MarketSignalsSkeleton />;

  const moverPairCount = Math.max(growers.length, shrinkers.length);

  return (
    <div className="pharos-card-shell flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40 animate-in fade-in duration-300">
      {/* ── Depegs zone ── */}
      <div className="flex-1 p-4">
        <h2 className="pharos-kicker mb-2.5">Biggest Depegs</h2>
        {depegs.length === 0 ? (
          <p className="text-xs text-muted-foreground">All on-peg</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {depegs.map((d, i) => (
              <DepegEntry
                key={d.id}
                entry={d}
                logos={logos}
                visClass={DEPEG_VIS[i] ?? "hidden"}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Movers zone ── */}
      <div className="flex-1 p-4">
        <h2 className="pharos-kicker mb-2.5">Movers <span className="normal-case font-normal text-muted-foreground">(7d)</span></h2>
        {moverPairCount === 0 ? (
          <p className="text-xs text-muted-foreground">No significant moves</p>
        ) : (
          <div className="space-y-1">
            {Array.from({ length: moverPairCount }).map((_, i) => (
              <MoverPairRow
                key={i}
                grower={growers[i]}
                shrinker={shrinkers[i]}
                logos={logos}
                visClass={MOVER_VIS[i] ?? "hidden"}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
