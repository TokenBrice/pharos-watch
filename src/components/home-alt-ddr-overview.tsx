"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ShieldCheck, SquareArrowRight } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useLogos } from "@/hooks/use-logos";
import { buildStablecoinUrl } from "@/lib/urls";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { cn } from "@/lib/utils";
import { formatPercentFromRatio } from "@shared/lib/format";
import { DDR_RESOLUTION_TIER_VALUES, type DdrResolutionTier } from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  getDuration,
  getLiveCurrentDeviationBps,
  getPeakDeviationBps,
  getResolution,
  NOW_DOT_TONE,
  TIER_META,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";

// Accuracy reads as strong only once enough calls are scored and the rate clears
// this bar; otherwise the big number stays neutral while the model calibrates.
const STRONG_ACCURACY_RATIO = 0.7;
const CALIBRATION_THRESHOLD = 5;

// Above this many open depegs the board splits into two balanced columns so all
// forecasts stay visible without an over-tall single list.
const TWO_COLUMN_THRESHOLD = 6;

const ACCURACY_TONE: Record<"strong" | "muted", string> = {
  strong: "text-emerald-600 dark:text-emerald-400",
  muted: "text-frost-blue",
};

// Short tier labels for the distribution legend + per-row terminality.
const TIER_SHORT: Record<DdrResolutionTier, string> = {
  recovery_likely: "Likely",
  at_risk: "At Risk",
  recovery_unlikely: "Unlikely",
  insufficient_signal: "No Signal",
};

// Tier-colored ring around each coin logo — keeps terminality readable at the
// identity slot. Complete static strings for the Tailwind scanner.
const RING_TONE: Record<DdrResolutionTier, string> = {
  recovery_likely: "ring-emerald-500/70",
  at_risk: "ring-amber-500/70",
  recovery_unlikely: "ring-red-500/70",
  insufficient_signal: "ring-muted-foreground/40",
};

interface ForecastItem {
  id: string;
  symbol: string;
  name: string;
  tier: DdrResolutionTier;
  nowBps: number | null;
  /** Benchmarked median time-to-repeg, seconds; null when no duration band. */
  medianSec: number | null;
  severity: number;
}

/** Worst gap first: live deviation if present, else this event's peak. */
function rowSeverity(row: DdrDisplayRow): number {
  const now = getLiveCurrentDeviationBps(row);
  if (now != null) return Math.abs(now);
  return Math.abs(getPeakDeviationBps(row));
}

function toForecastItem(row: DdrDisplayRow): ForecastItem {
  const duration = getDuration(row);
  const nowBps = getLiveCurrentDeviationBps(row);
  const benchmarked = !duration.suppressed && duration.medianSec != null;
  return {
    id: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    tier: getResolution(row).tier,
    nowBps,
    medianSec: benchmarked ? duration.medianSec : null,
    severity: rowSeverity(row),
  };
}

function signedBps(bps: number | null): string {
  if (bps == null) return "—";
  return `${bps > 0 ? "+" : ""}${bps} bps`;
}

/** Expected outcome: a recovery duration band, terminal "no return", or awaiting. */
function DurationCell({ item }: { item: ForecastItem }) {
  if (item.tier === "recovery_unlikely") {
    return <span className="font-mono text-[11px] font-semibold text-red-700 dark:text-red-400">no return</span>;
  }
  if (item.medianSec != null) {
    return (
      <span className="font-mono text-[11px] font-semibold tabular-nums text-sky-700 dark:text-sky-400">
        ~{formatDurationSec(item.medianSec)}
      </span>
    );
  }
  if (item.tier === "insufficient_signal") {
    return <span className="font-mono text-[11px] text-muted-foreground/70">awaiting</span>;
  }
  return <span className="font-mono text-[11px] text-muted-foreground/50">—</span>;
}

/** Coin logo with a tier-colored ring; falls back to the symbol initial. */
function CoinLogo({ item, logoSrc }: { item: ForecastItem; logoSrc: string | undefined }) {
  const src = resolveCompactLogoSrc(logoSrc, 20);
  const fallback = (item.symbol || item.name).trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background ring-2",
        RING_TONE[item.tier],
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={20}
          height={20}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full rounded-full object-contain"
        />
      ) : (
        <span className="font-mono text-[8px] font-bold text-muted-foreground">{fallback}</span>
      )}
    </span>
  );
}

/** One ongoing depeg: identity + deviation, then terminality verdict + duration. */
function ForecastRow({ item, logoSrc }: { item: ForecastItem; logoSrc: string | undefined }) {
  return (
    <Link
      href={buildStablecoinUrl(item.id)}
      prefetch={false}
      title={item.name}
      className="pharos-focus-ring group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-1.5 py-1.5 hover:bg-muted/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <CoinLogo item={item} logoSrc={logoSrc} />
        <span className="truncate font-mono text-[13px] font-semibold text-foreground group-hover:underline">
          {item.symbol}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{signedBps(item.nowBps)}</span>
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2.5">
        <span className={cn("hidden w-16 text-right text-[10px] font-semibold uppercase tracking-wide sm:inline", TIER_META[item.tier].accent)}>
          {TIER_SHORT[item.tier]}
        </span>
        <span className="w-16 text-right">
          <DurationCell item={item} />
        </span>
      </span>
    </Link>
  );
}

// --- header --------------------------------------------------------------

function SectionHeader({ stat }: { stat: { value: number; label: string } }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex shrink-0 items-center rounded-md bg-frost-blue/15 px-2 py-1 font-display text-sm font-black tracking-tight text-frost-blue ring-1 ring-inset ring-frost-blue/30 sm:text-base">
            DDR
          </span>
          <p className="font-display text-2xl font-bold leading-tight text-foreground sm:text-3xl">
            Depeg Duration Resolver
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            <span className="pharos-numeric font-semibold text-foreground">{stat.value}</span> {stat.label}
          </span>
          <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" />
          <Link
            href="/depeg/"
            prefetch={false}
            aria-label="Open the depeg resolver tracker"
            className="pharos-focus-ring group inline-flex min-h-7 items-center gap-1.5 rounded-[4px] border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60 sm:min-h-8 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-[13px]"
          >
            Tracker
            <SquareArrowRight
              aria-hidden="true"
              className="h-3 w-3 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground sm:h-3.5 sm:w-3.5"
              strokeWidth={2}
            />
          </Link>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground sm:text-sm">
        Forecasts how long a depeg lasts &mdash; and whether it returns to peg.
      </p>
    </div>
  );
}

// --- forecast board (left) -----------------------------------------------

function VerdictDistribution({ items }: { items: ForecastItem[] }) {
  const total = items.length;
  const groups = DDR_RESOLUTION_TIER_VALUES.map((tier) => ({
    tier,
    count: items.filter((i) => i.tier === tier).length,
  })).filter((g) => g.count > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex h-10 w-full gap-0.5 overflow-hidden rounded-md bg-background/70">
        {groups.map(({ tier, count }, index) => (
          <span
            key={tier}
            className={cn(
              NOW_DOT_TONE[tier],
              index === 0 && "rounded-l-md",
              index === groups.length - 1 && "rounded-r-md",
            )}
            style={{ flexGrow: count }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {groups.map(({ tier, count }) => (
          <span key={tier} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("h-2 w-2 rounded-[3px]", NOW_DOT_TONE[tier])} />
            <span className={cn("font-mono text-sm font-bold tabular-nums", TIER_META[tier].accent)}>{count}</span>
            <span className={cn("text-[10px] font-semibold uppercase tracking-wide", TIER_META[tier].accent)}>
              {TIER_SHORT[tier]}
            </span>
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{total} live</span>
      </div>
    </div>
  );
}

function ForecastZone({
  items,
  logoMap,
}: {
  items: ForecastItem[];
  logoMap: Record<string, string | undefined>;
}) {
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
          <ShieldCheck aria-hidden="true" className="h-6 w-6" strokeWidth={2} />
        </span>
        <div className="space-y-0.5">
          <p className="font-display text-lg font-bold text-foreground">All clear</p>
          <p className="text-sm text-muted-foreground">No active depeg forecasts — every monitored coin is on peg.</p>
        </div>
      </div>
    );
  }

  const twoCol = items.length > TWO_COLUMN_THRESHOLD;
  const mid = Math.ceil(items.length / 2);
  const columns = twoCol ? [items.slice(0, mid), items.slice(mid)] : [items];

  return (
    <div className="space-y-3.5">
      <VerdictDistribution items={items} />
      <div className={cn("grid gap-x-6", twoCol ? "sm:grid-cols-2" : "grid-cols-1")}>
        {columns.map((column, index) => (
          <div key={index} className="-mx-1.5 divide-y divide-border/30">
            {column.map((item) => (
              <ForecastRow key={item.id} item={item} logoSrc={logoMap[item.id]} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- track record (right) ------------------------------------------------

function HorizonBars({ rates }: { rates: { horizon: string; hitRate: number }[] }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Accuracy by horizon</p>
      <div className="flex items-end gap-2">
        {rates.map((r) => {
          const pct = Math.round(r.hitRate * 100);
          return (
            <div key={r.horizon} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="pharos-numeric text-[11px] font-bold text-foreground">{pct}%</span>
              <div className="flex h-16 w-full items-end overflow-hidden rounded-md bg-muted/50">
                <div
                  className="w-full rounded-md bg-[var(--chart-primary)]/80"
                  style={{ height: `${Math.max(8, pct)}%` }}
                />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{r.horizon}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackRecordZone({
  accuracyValue,
  accuracyTone,
  scored,
  lockedCount,
  durationScored,
  rates,
}: {
  accuracyValue: string;
  accuracyTone: string;
  scored: number;
  lockedCount: number;
  durationScored: number;
  rates: { horizon: string; hitRate: number }[];
}) {
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="pharos-kicker">Track record</h3>
          <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">DDRR</span>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <span className={cn("font-display text-4xl font-black leading-none tracking-tight sm:text-5xl", accuracyTone)}>
            {accuracyValue}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          recovery-call accuracy
          {scored > 0 ? (
            <>
              {" · "}
              <span className="font-mono tabular-nums text-foreground">{scored}</span> scored
            </>
          ) : null}
        </p>
      </div>

      {rates.length > 0 ? <HorizonBars rates={rates} /> : null}

      <p className="mt-auto border-t border-border/40 pt-2.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums text-foreground">{lockedCount}</span> locked forecasts ·{" "}
        <span className="font-mono tabular-nums text-foreground">{durationScored}</span> duration-scored
      </p>
    </div>
  );
}

// --- public component ----------------------------------------------------

export function HomeAltDdrOverview(): React.JSX.Element | null {
  const {
    resolverEnabled,
    resolverReviewerEnabled,
    resolverData,
    resolverError,
    resolverReviewData,
    resolverReviewError,
  } = useDepegResolverSurfaces();

  // Every ongoing depeg, worst gap first.
  const items = useMemo(
    () => [...(resolverData?.rows ?? [])].map(toForecastItem).sort((a, b) => b.severity - a.severity),
    [resolverData],
  );

  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  if (!resolverEnabled && !resolverReviewerEnabled) return null;

  const ddrDegraded = resolverData?._meta.degraded === true;
  const ddrUsable =
    resolverEnabled && !!resolverData && (!ddrDegraded || resolverData?._meta.degradedReason === "stale-cache");
  const ddrrDegraded = resolverReviewData?._meta.degraded === true;
  const ddrrUsable =
    resolverReviewerEnabled &&
    !!resolverReviewData &&
    (!ddrrDegraded || resolverReviewData?._meta.degradedReason === "stale-cache");

  const loading =
    (resolverEnabled && !resolverData && !resolverError) ||
    (resolverReviewerEnabled && !resolverReviewData && !resolverReviewError);
  if (!ddrUsable && !ddrrUsable && loading) return <HomeAltDdrOverviewFallback />;
  if (!ddrUsable && !ddrrUsable) return null;

  const headline = resolverReviewData?.summary.headline;
  const scored = headline?.recoveryLikelihoodScoredCount ?? 0;
  const accuracyPct = headline?.recoveryLikelihoodAccuracyPct ?? null;
  const accuracyValue = scored === 0 || accuracyPct == null ? "—" : formatPercentFromRatio(accuracyPct, 1);
  const accuracyStrong = accuracyPct != null && scored >= CALIBRATION_THRESHOLD && accuracyPct >= STRONG_ACCURACY_RATIO;
  const accuracyTone = ACCURACY_TONE[accuracyStrong ? "strong" : "muted"];
  const rates = (headline?.horizonHitRates ?? [])
    .filter((h) => h.scored > 0 && h.hitRate != null)
    .map((h) => ({ horizon: h.horizon, hitRate: h.hitRate as number }));

  const stat = ddrUsable
    ? { value: items.length, label: "live" }
    : { value: headline?.lockedPredictionCount ?? 0, label: "graded" };

  const forecastSpan = ddrrUsable && headline ? "lg:col-span-3" : "lg:col-span-5";
  const trackSpan = ddrUsable ? "lg:col-span-2" : "lg:col-span-5";

  return (
    <section aria-labelledby="ddr-overview-title" className="space-y-3 sm:space-y-4">
      <h2 id="ddr-overview-title" className="sr-only">
        Depeg Duration Resolver overview
      </h2>

      <SectionHeader stat={stat} />

      <div className="pharos-card-shell overflow-hidden">
        <div className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-5 lg:divide-x lg:divide-y-0">
          {ddrUsable ? (
            <div className={cn("p-4 sm:p-5", forecastSpan)}>
              <ForecastZone items={items} logoMap={logoMap} />
            </div>
          ) : null}
          {ddrrUsable && headline ? (
            <div className={cn("bg-muted/20 p-4 sm:p-5", trackSpan)}>
              <TrackRecordZone
                accuracyValue={accuracyValue}
                accuracyTone={accuracyTone}
                scored={scored}
                lockedCount={headline.lockedPredictionCount}
                durationScored={headline.durationScoredCount}
                rates={rates}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function HomeAltDdrOverviewFallback(): React.JSX.Element {
  return (
    <section aria-hidden="true" className="space-y-3 sm:space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-8 w-12 rounded-md" />
            <Skeleton className="h-7 w-56 sm:h-9" />
          </div>
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="pharos-card-shell overflow-hidden">
        <div className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-5 lg:divide-x lg:divide-y-0">
          <div className="space-y-3 p-4 sm:p-5 lg:col-span-3">
            <Skeleton className="h-10 w-full rounded-md" />
            <div className="grid gap-x-6 sm:grid-cols-2">
              {[0, 1].map((col) => (
                <div key={col} className="space-y-2.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4 bg-muted/20 p-4 sm:p-5 lg:col-span-2">
            <Skeleton className="h-12 w-32" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
    </section>
  );
}
