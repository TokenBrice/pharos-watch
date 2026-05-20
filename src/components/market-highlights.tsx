"use client";

import { type CSSProperties, type ReactNode, useMemo } from "react";
import Link from "next/link";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { MethodologyHint } from "@/components/methodology-hint";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPegDeviation, getNetColor } from "@shared/lib/format";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { CLIENT_ACTIVE_IDS as ACTIVE_IDS, CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";

/* ─── Constants ─────────────────────────────────────────────────── */

const SKELETON_DEPEG_INDICES = Array.from({ length: 9 }, (_, i) => i);
const SKELETON_MOVER_INDICES = Array.from({ length: 3 }, (_, i) => i);

const SUPPLY_FLOOR = 1_000_000;
const ENTRY_LINK_CLASS =
  "pharos-focus-ring group min-w-0 items-center gap-2 rounded-lg px-2 py-2 transition-[background-color,color] duration-150 hover:bg-muted/40 sm:gap-1.5 sm:rounded-md sm:px-1.5 sm:py-1";

/**
 * Responsive visibility classes per item index.
 * Depegs: 4 on mobile (2×2), 9 on lg+ (3×3).
 * Movers: 2 per group on mobile, 3 per group on lg+.
 */
const DEPEG_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "flex",
  3: "flex",
  4: "hidden lg:flex",
  5: "hidden lg:flex",
  6: "hidden lg:flex",
  7: "hidden lg:flex",
  8: "hidden lg:flex",
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
  pegScores?: Map<string, PegSummaryCoin>;
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

function useDepegs(data: StablecoinData[] | undefined, pegScores: Map<string, PegSummaryCoin> | undefined) {
  return useMemo(() => {
    if (!data || !pegScores) return [];

    const entries: DepegItem[] = [];

    for (const coin of data) {
      const meta = ACTIVE_META_BY_ID.get(coin.id);
      if (!meta) continue;
      if (meta.flags.navToken) continue;
      const supply = getCirculatingRaw(coin);
      if (supply < SUPPLY_FLOOR) continue;
      const peg = pegScores.get(coin.id);
      if (!peg?.activeDepeg || peg.currentDeviationBps == null) continue;
      const bps = peg.currentDeviationBps;

      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, bps });
    }

    entries.sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
    return entries.slice(0, 9);
  }, [data, pegScores]);
}

function useMovers(data: StablecoinData[] | undefined) {
  return useMemo(() => {
    if (!data) return { growers: [] as MoverItem[], shrinkers: [] as MoverItem[] };

    const entries: MoverItem[] = [];

    for (const coin of data) {
      if (!ACTIVE_IDS.has(coin.id)) continue;
      const current = getCirculatingRaw(coin);
      const prev = getPrevWeekRaw(coin);
      if (current < SUPPLY_FLOOR || prev < SUPPLY_FLOOR) continue;

      const pctChange = ((current - prev) / prev) * 100;
      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, pctChange });
    }

    const sorted = [...entries].sort((a, b) => b.pctChange - a.pctChange);
    return {
      growers: sorted.slice(0, 3),
      shrinkers: sorted
        .slice(-3)
        .reverse()
        .filter((e) => e.pctChange < 0),
    };
  }, [data]);
}

/* ─── Color helpers ─────────────────────────────────────────────── */

/**
 * Sign-aware depeg color and icon:
 * - Below peg (negative bps): red + TrendingDown — insolvency/redemption concern
 * - Above peg (positive bps): amber + TrendingUp — liquidity premium
 * - Near peg (<10 bps absolute): muted
 */
function depegColorClass(bps: number): string {
  const abs = Math.abs(bps);
  if (abs < 10) return "text-muted-foreground";
  if (bps < 0) return "text-red-700 dark:text-red-400";
  return "text-amber-700 dark:text-amber-400";
}

function DepegIcon({ bps }: { bps: number }) {
  const abs = Math.abs(bps);
  if (abs < 10) return null;
  const Icon = bps < 0 ? TrendingDown : TrendingUp;
  return <Icon className="h-3 w-3" aria-hidden="true" />;
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
  const deviation = formatPegDeviation(entry.bps / 10000 + 1, 1);

  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      aria-label={`${entry.name} (${entry.symbol}) price deviation: ${deviation} from peg`}
      style={staggerIndex != null ? ({ "--stagger-index": staggerIndex } as CSSProperties) : undefined}
      className={`${visClass} ${ENTRY_LINK_CLASS} min-h-11 sm:min-h-8`}
    >
      <StablecoinLogo src={logos?.[entry.id]} name={entry.name} size={18} />
      <span className="min-w-0 truncate text-[13px] font-medium group-hover:underline group-focus-visible:underline sm:text-xs">
        {entry.symbol}
      </span>
      <span
        className={`ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-xs font-semibold ${depegColorClass(entry.bps)}`}
      >
        <DepegIcon bps={entry.bps} />
        {deviation}
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
  const change = `${isGrower ? "+" : ""}${entry.pctChange.toFixed(1)}%`;

  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      aria-label={`${entry.name} (${entry.symbol}) 7-day supply change: ${change}`}
      style={staggerIndex != null ? ({ "--stagger-index": staggerIndex } as CSSProperties) : undefined}
      className={`${visClass} ${ENTRY_LINK_CLASS} min-h-11 sm:min-h-8`}
    >
      <StablecoinLogo src={logos?.[entry.id]} name={entry.name} size={18} />
      <span className="min-w-0 truncate text-[13px] font-medium group-hover:underline group-focus-visible:underline sm:text-xs">
        {entry.symbol}
      </span>
      <span
        className={`ml-auto shrink-0 font-mono text-xs font-semibold ${getNetColor(entry.pctChange, { positiveInclusiveZero: true })}`}
      >
        {change}
      </span>
    </Link>
  );
}

function SectionHeader({
  id,
  title,
  detail,
  badge,
  hint,
}: {
  id: string;
  title: string;
  detail: string;
  badge: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex min-h-16 items-start justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 id={id} className="pharos-kicker truncate text-foreground">
            {title}
          </h3>
          {hint}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{detail}</p>
      </div>
      <span className="shrink-0 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {badge}
      </span>
    </div>
  );
}

function MarketHighlightSection({
  titleId,
  title,
  detail,
  badge,
  hint,
  children,
}: {
  titleId: string;
  title: string;
  detail: string;
  badge: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <SectionHeader id={titleId} title={title} detail={detail} badge={badge} hint={hint} />
      <div className="px-3 py-3 sm:px-4">{children}</div>
    </section>
  );
}

function MoversGroup({
  label,
  tone,
  entries,
  logos,
}: {
  label: string;
  tone: "up" | "down";
  entries: MoverItem[];
  logos?: Record<string, string>;
}) {
  if (entries.length === 0) return null;

  const Icon = tone === "up" ? TrendingUp : TrendingDown;
  const toneClass = getNetColor(tone === "up" ? 1 : -1);

  return (
    <div className="space-y-1.5">
      <p className={`flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${toneClass}`}>
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </p>
      <div className="pharos-stagger-entrance grid grid-cols-1 gap-x-3 gap-y-1 min-[360px]:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry, i) => (
          <MoverEntry key={entry.id} entry={entry} logos={logos} visClass={MOVER_VIS[i] ?? "hidden"} staggerIndex={i} />
        ))}
      </div>
    </div>
  );
}

/* ─── Skeleton ──────────────────────────────────────────────────── */

function MarketSignalsSkeleton() {
  return (
    <div className="pharos-card-shell overflow-hidden p-0">
      <div className="grid grid-cols-1 divide-y divide-border/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* Depegs skeleton */}
        <section>
          <div className="flex min-h-16 items-start justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
            <div className="space-y-2">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-2 w-32" />
            </div>
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <div className="px-3 py-3 sm:px-4">
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 lg:grid-cols-3">
              {SKELETON_DEPEG_INDICES.map((i) => (
                <Skeleton key={i} className={`h-10 w-full sm:h-7 ${i >= 4 ? "hidden lg:block" : ""}`} />
              ))}
            </div>
          </div>
        </section>
        {/* Movers skeleton */}
        <section>
          <div className="flex min-h-16 items-start justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
            <div className="space-y-2">
              <Skeleton className="h-2.5 w-36" />
              <Skeleton className="h-2 w-40" />
            </div>
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
          <div className="space-y-3 px-3 py-3 sm:px-4">
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 lg:grid-cols-3">
              {SKELETON_MOVER_INDICES.map((i) => (
                <Skeleton key={i} className="h-10 w-full sm:h-7" />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 lg:grid-cols-3">
              {SKELETON_MOVER_INDICES.map((i) => (
                <Skeleton key={i} className="h-10 w-full sm:h-7" />
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ─── Main export ───────────────────────────────────────────────── */

export function MarketHighlights({ data, logos, pegScores }: MarketHighlightsProps) {
  const depegs = useDepegs(data, pegScores);
  const { growers, shrinkers } = useMovers(data);

  if (!data || !pegScores) return <MarketSignalsSkeleton />;

  return (
    <div
      aria-label="Market highlights"
      className="pharos-card-shell overflow-hidden p-0 animate-in fade-in duration-300"
    >
      <h2 className="sr-only">Market Highlights</h2>

      {/* ── Content ── */}
      <div className="grid grid-cols-1 divide-y divide-border/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* ── Depegs zone ── */}
        <MarketHighlightSection
          titleId="market-highlights-depegs-title"
          title="Biggest Depegs"
          detail="Live price move away from peg"
          badge="Live"
          hint={<MethodologyHint topic="depegBps" />}
        >
          {depegs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground sm:text-xs">
              All on-peg
            </p>
          ) : (
            <div className="pharos-stagger-entrance grid grid-cols-1 gap-x-3 gap-y-1 min-[360px]:grid-cols-2 lg:grid-cols-3">
              {depegs.map((d, i) => (
                <DepegEntry key={d.id} entry={d} logos={logos} visClass={DEPEG_VIS[i] ?? "hidden"} staggerIndex={i} />
              ))}
            </div>
          )}
        </MarketHighlightSection>

        {/* ── Movers zone ── */}
        <MarketHighlightSection
          titleId="market-highlights-movers-title"
          title="Biggest 7-Day Supply Moves"
          detail="Largest supply increases and decreases"
          badge="7D"
        >
          {growers.length === 0 && shrinkers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground sm:text-xs">
              No significant moves
            </p>
          ) : (
            <div className="space-y-3">
              <MoversGroup label="Supply up" tone="up" entries={growers} logos={logos} />
              <MoversGroup label="Supply down" tone="down" entries={shrinkers} logos={logos} />
            </div>
          )}
        </MarketHighlightSection>
      </div>
    </div>
  );
}
