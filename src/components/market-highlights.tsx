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

const SKELETON_DEPEG_INDICES = Array.from({ length: 6 }, (_, i) => i);
const SKELETON_MOVER_INDICES = Array.from({ length: 3 }, (_, i) => i);

const SUPPLY_FLOOR = 1_000_000;

/**
 * Responsive visibility classes per item index.
 * Depegs: 4 on mobile (2×2), 6 on lg+ (2×3).
 * Movers: 2 per group on mobile, 3 per group on lg+.
 */
const DEPEG_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "flex",
  3: "flex",
  4: "hidden lg:flex",
  5: "hidden lg:flex",
};

const MOVER_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "hidden lg:flex",
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

interface MoverItem {
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
    return entries.slice(0, 6);
  }, [data, pegRates]);
}

function useMovers(data: StablecoinData[] | undefined) {
  return useMemo(() => {
    if (!data) return { growers: [] as MoverItem[], shrinkers: [] as MoverItem[] };

    const entries: MoverItem[] = [];

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
  staggerIndex,
}: {
  entry: DepegItem;
  logos?: Record<string, string>;
  visClass: string;
  staggerIndex?: number;
}) {
  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      style={staggerIndex != null ? { '--stagger-index': staggerIndex } as React.CSSProperties : undefined}
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

function MoverEntry({
  entry,
  logos,
  visClass,
  staggerIndex,
}: {
  entry: MoverItem;
  logos?: Record<string, string>;
  visClass: string;
  staggerIndex?: number;
}) {
  const isGrower = entry.pctChange >= 0;
  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      style={staggerIndex != null ? { '--stagger-index': staggerIndex } as React.CSSProperties : undefined}
      className={`${visClass} pharos-focus-ring group items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40`}
    >
      <StablecoinLogo src={logos?.[entry.id]} name={entry.name} size={16} />
      <span className="truncate text-xs font-medium group-hover:underline group-focus-visible:underline">
        {entry.symbol}
      </span>
      <span className={`text-xs font-mono font-semibold ml-auto flex-shrink-0 ${isGrower ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
        {isGrower ? "+" : ""}{entry.pctChange.toFixed(1)}%
      </span>
    </Link>
  );
}

/* ─── Skeleton ──────────────────────────────────────────────────── */

function MarketSignalsSkeleton() {
  return (
    <div className="pharos-card-shell overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40">
        {/* Depegs skeleton */}
        <div className="flex-1 px-4 py-3">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {SKELETON_DEPEG_INDICES.map((i) => (
              <Skeleton key={i} className={`h-5 w-full ${i >= 4 ? "hidden lg:block" : ""}`} />
            ))}
          </div>
        </div>
        {/* Movers skeleton */}
        <div className="flex-1 px-4 py-3 space-y-2">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {SKELETON_MOVER_INDICES.map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {SKELETON_MOVER_INDICES.map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
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

  return (
    <div className="pharos-card-shell overflow-hidden p-0 animate-in fade-in duration-300">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
        <h2 className="pharos-kicker">Biggest Depegs</h2>
        <h2 className="pharos-kicker">Movers <span className="normal-case font-normal text-muted-foreground">(7d)</span></h2>
      </div>

      {/* ── Content ── */}
      <div className="flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40">
        {/* ── Depegs zone ── */}
        <div className="flex-1 px-4 py-3">
          {depegs.length === 0 ? (
            <p className="text-xs text-muted-foreground">All on-peg</p>
          ) : (
            <div className="pharos-stagger-entrance grid grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-1">
              {depegs.map((d, i) => (
                <DepegEntry
                  key={d.id}
                  entry={d}
                  logos={logos}
                  visClass={DEPEG_VIS[i] ?? "hidden"}
                  staggerIndex={i}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Movers zone ── */}
        <div className="flex-1 px-4 py-3">
          {growers.length === 0 && shrinkers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No significant moves</p>
          ) : (
            <div className="space-y-1">
              {growers.length > 0 && (
                <div className="pharos-stagger-entrance grid grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-1">
                  {growers.map((g, i) => (
                    <MoverEntry
                      key={g.id}
                      entry={g}
                      logos={logos}
                      visClass={MOVER_VIS[i] ?? "hidden"}
                      staggerIndex={i}
                    />
                  ))}
                </div>
              )}
              {shrinkers.length > 0 && (
                <div className="pharos-stagger-entrance grid grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-1">
                  {shrinkers.map((s, i) => (
                    <MoverEntry
                      key={s.id}
                      entry={s}
                      logos={logos}
                      visClass={MOVER_VIS[i] ?? "hidden"}
                      staggerIndex={i}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
