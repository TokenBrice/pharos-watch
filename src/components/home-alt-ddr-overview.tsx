"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ListFilter } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { HomeAltTrackerLink } from "@/components/home-alt-tracker-link";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { cn } from "@/lib/utils";
import { formatPercentFromRatio } from "@shared/lib/format";
import {
  type DdrResolutionTier,
  type DdrPublicPredictionState,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  formatUtcTimestamp,
  getLiveCurrentDeviationBps,
  getPeakDeviationBps,
  getResolution,
  getTierMeta,
  getTierVocabulary,
  isCurrentForecast,
  NOW_DOT_TONE,
} from "@/components/depeg-resolver-row-card-model";
import { groupTiersByVocabulary } from "@/components/depeg-resolver-book-summary";
import { DDR_VERDICT_CLASSES, type DdrTierVocabulary } from "@shared/lib/classification";

// Above this many open depegs the board splits into two balanced columns so all
// forecasts stay visible without an over-tall single list.
const TWO_COLUMN_THRESHOLD = 6;

// Tier-colored ring around each coin logo — keeps terminality readable at the
// identity slot.
const RING_TONE: Record<DdrResolutionTier, string> = {
  recovery_likely: DDR_VERDICT_CLASSES.recovery_likely.ring,
  at_risk: DDR_VERDICT_CLASSES.at_risk.ring,
  recovery_unlikely: DDR_VERDICT_CLASSES.recovery_unlikely.ring,
  insufficient_signal: "ring-muted-foreground/40",
};

interface ForecastItem {
  id: string;
  symbol: string;
  name: string;
  state: DdrPublicPredictionState;
  tier: DdrResolutionTier | null;
  /** Label vocabulary the forecast was locked under (DDRv5 evidence classes or legacy). */
  vocabulary: DdrTierVocabulary;
  nowBps: number | null;
  /** Benchmarked median time-to-repeg, seconds; null when no duration band. */
  medianSec: number | null;
  remainingAsOf: number | null;
  medianResolveAt: number | null;
  degradedReason: string | null;
  severity: number;
}

/** Worst gap first: live deviation if present, else this event's peak. */
function rowSeverity(row: DdrV2ResponseRow): number {
  const now = getLiveCurrentDeviationBps(row);
  if (now != null) return Math.abs(now);
  const peak = getPeakDeviationBps(row);
  return peak == null ? -1 : Math.abs(peak);
}

function toForecastItem(row: DdrV2ResponseRow): ForecastItem {
  const currentForecast = isCurrentForecast(row);
  const duration = isCurrentForecast(row) ? row.frozen.duration : null;
  const nowBps = getLiveCurrentDeviationBps(row);
  const benchmarked = duration != null && !duration.suppressed && duration.medianSec != null;
  return {
    id: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    state: row.prediction.state,
    tier: currentForecast ? getResolution(row).tier : null,
    vocabulary: getTierVocabulary(row),
    nowBps,
    medianSec: benchmarked ? duration.medianSec : null,
    remainingAsOf: benchmarked ? duration.remainingAsOf : null,
    medianResolveAt: benchmarked ? duration.medianResolveAt : null,
    degradedReason: row.live.degradedReason,
    severity: rowSeverity(row),
  };
}

function signedBps(bps: number | null): string {
  if (bps == null) return "—";
  return `${bps > 0 ? "+" : ""}${bps} bps`;
}

/** Expected outcome: a recovery duration band, terminal "no return", or awaiting. */
function DurationCell({ item }: { item: ForecastItem }) {
  if (item.tier == null) {
    return <span className="font-mono text-2xs text-muted-foreground">—</span>;
  }
  if (item.tier === "recovery_unlikely") {
    return (
      <span className="font-mono text-2xs font-semibold text-state-danger">
        {item.vocabulary === "evidence_class" ? "may not recover" : "no return"}
      </span>
    );
  }
  if (item.medianSec != null) {
    return (
      <span
        className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground"
        title={`Locked estimate as of ${formatUtcTimestamp(item.remainingAsOf) ?? "unknown"}; median deadline ${formatUtcTimestamp(item.medianResolveAt) ?? "unknown"}${item.degradedReason === "duration-exceeded" ? "; median deadline passed" : ""}`}
      >
        {item.degradedReason === "duration-exceeded" ? "overdue" : "locked"} ~{formatDurationSec(item.medianSec)}
      </span>
    );
  }
  if (item.tier === "insufficient_signal") {
    return <span className="font-mono text-2xs text-muted-foreground/70">awaiting</span>;
  }
  return <span className="font-mono text-2xs text-muted-foreground/50">—</span>;
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
        item.tier == null ? RING_TONE.insufficient_signal : RING_TONE[item.tier],
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
        <span className="font-mono text-3xs font-bold text-muted-foreground">{fallback}</span>
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
        <span className="truncate font-mono text-xs font-semibold text-foreground group-hover:underline">
          {item.symbol}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">{signedBps(item.nowBps)}</span>
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2.5">
        <span className={cn("w-auto text-right sm:w-24 text-2xs font-semibold", item.tier == null ? "text-muted-foreground" : getTierMeta(item.tier, item.vocabulary).accent)}>
          {item.tier == null ? item.state.replaceAll("_", " ") : getTierMeta(item.tier, item.vocabulary).short}
        </span>
        <span className="w-auto text-right sm:w-28">
          <DurationCell item={item} />
        </span>
      </span>
    </Link>
  );
}

// --- header --------------------------------------------------------------

function SectionHeader({ stat }: { stat: { value: number | null; label: string } }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="font-display text-2xl font-bold leading-tight text-foreground sm:text-3xl">
          Depeg Duration Resolver
        </p>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            <span className="pharos-numeric font-semibold text-foreground">{stat.value ?? "—"}</span> {stat.label}
          </span>
          <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" />
          <HomeAltTrackerLink
            href="/depeg/"
            prefetch={false}
            ariaLabel="Open the depeg resolver tracker"
          />
        </div>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground sm:text-sm">
        Forecasts how long a depeg lasts &mdash; and whether it returns to peg.
      </p>
    </div>
  );
}

// --- forecast board (left) -----------------------------------------------

function VerdictDistribution({ items }: { items: ForecastItem[] }) {
  const tiered = items.flatMap((item) => (item.tier == null ? [] : [{ tier: item.tier, vocabulary: item.vocabulary }]));
  const total = tiered.length;
  // Pre-v5 locks keep their own labels, so a mixed book shows each vocabulary's count separately.
  const groups = groupTiersByVocabulary(tiered);

  return (
    <div className="space-y-1.5">
      <div className="flex h-10 w-full gap-0.5 overflow-hidden rounded-md bg-background/70">
        {groups.map(({ tier, vocabulary, count }, index) => (
          <span
            key={`${tier}:${vocabulary}`}
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
        {groups.map(({ tier, vocabulary, count }) => {
          const meta = getTierMeta(tier, vocabulary);
          return (
            <span key={`${tier}:${vocabulary}`} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("h-2 w-2 rounded-xs", NOW_DOT_TONE[tier])} />
              <span className={cn("font-mono text-sm font-bold tabular-nums", meta.accent)}>{count}</span>
              <span className={cn("text-2xs font-semibold", meta.accent)}>{meta.short}</span>
            </span>
          );
        })}
        <span className="pharos-meta pharos-numeric ml-auto">{total} forecasts</span>
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
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ListFilter aria-hidden="true" className="h-6 w-6" strokeWidth={2} />
        </span>
        <div className="space-y-0.5">
          <p className="font-display text-lg font-bold text-foreground">No published active forecasts</p>
          <p className="text-sm text-muted-foreground">No active forecasts in the available snapshot; this is not a market-wide peg assessment.</p>
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
              <ForecastRow key={item.id} item={item} logoSrc={getLogoSrc(logoMap, item.id)} />
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
    <div className="flex flex-1 flex-col gap-2">
      <p className="pharos-label">Accuracy by horizon</p>
      <div className="flex flex-1 items-stretch gap-2">
        {rates.map((r) => {
          const pct = Math.round(r.hitRate * 100);
          return (
            <div key={r.horizon} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="pharos-numeric text-2xs font-bold text-foreground">{pct}%</span>
              <div className="flex min-h-16 w-full flex-1 items-end overflow-hidden rounded-md bg-muted/50">
                <div
                  className="w-full rounded-md bg-[var(--chart-primary)]/80"
                  style={{ height: `${Math.max(8, pct)}%` }}
                />
              </div>
              <span className="font-mono text-3xs text-muted-foreground">{r.horizon}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackRecordZone({
  accuracyValue,
  scored,
  lockedCount,
  durationScored,
  rates,
}: {
  accuracyValue: string;
  scored: number;
  lockedCount: number;
  durationScored: number;
  rates: { horizon: string; hitRate: number }[];
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="pharos-label">Track record</h3>
          <span className="font-mono text-3xs text-muted-foreground">DDRR</span>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <span className="pharos-numeric text-4xl font-bold leading-none tracking-tight text-foreground">
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

// Neutral source stamp: the homepage never renders data-health UI
// (docs/homepage.md), so retained/degraded snapshots read like live ones.
function SourceStatus({ label, computedAt, usable, loading }: {
  label: string;
  computedAt: number | undefined;
  usable: boolean;
  loading: boolean;
}) {
  const asOf = usable ? formatUtcTimestamp(computedAt) : null;
  return (
    <p className="mb-3 text-xs text-muted-foreground">
      {label} · {loading || !asOf ? "Updating" : `as of ${asOf}`}
    </p>
  );
}

// --- public component ----------------------------------------------------

export function HomeAltDdrOverview(): React.JSX.Element | null {
  const { resolverEnabled, resolverReviewerEnabled, resolver, resolverReview } = useDepegResolverSurfaces();
  const { data: resolverData, error: resolverError } = resolver;
  const { data: resolverReviewData, error: resolverReviewError } = resolverReview;

  // Every ongoing depeg, worst gap first.
  const items = useMemo(
    () => [...(resolverData?.rows ?? [])].map(toForecastItem).sort((a, b) => b.severity - a.severity),
    [resolverData],
  );

  const logos = logosById;
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
  if (!ddrUsable && !ddrrUsable && loading && !resolverData && !resolverReviewData && !resolverError && !resolverReviewError) return <HomeAltDdrOverviewFallback />;
  // Failed sources stay visible independently, even when neither has a usable snapshot.

  const headline = ddrrUsable ? resolverReviewData?.summary.headline : undefined;
  const scored = headline?.recoveryLikelihoodScoredCount ?? 0;
  const accuracyPct = headline?.recoveryLikelihoodAccuracyPct ?? null;
  const accuracyValue = scored === 0 || accuracyPct == null ? "—" : formatPercentFromRatio(accuracyPct, 1);
  const rates = (headline?.horizonHitRates ?? [])
    .filter((h) => h.scored > 0 && h.hitRate != null)
    .map((h) => ({ horizon: h.horizon, hitRate: h.hitRate as number }));

  const stat = ddrUsable
    ? { value: items.filter((item) => item.tier != null).length, label: "published forecasts" }
    // R1: no usable reviewer headline is an unavailable count, never zero graded.
    : { value: headline?.lockedPredictionCount ?? null, label: "graded" };

  const forecastSpan = resolverReviewerEnabled ? "lg:col-span-3" : "lg:col-span-5";
  const trackSpan = resolverEnabled ? "lg:col-span-2" : "lg:col-span-5";

  return (
    <section aria-labelledby="ddr-overview-title" className="space-y-3 sm:space-y-4">
      <h2 id="ddr-overview-title" className="sr-only">
        Depeg Duration Resolver overview
      </h2>

      <SectionHeader stat={stat} />

      <div className="pharos-card-shell overflow-hidden">
        <div className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-5 lg:divide-x lg:divide-y-0">
          {resolverEnabled ? (
            <div className={cn("p-4 sm:p-5", forecastSpan)}>
              <SourceStatus label="Resolver" computedAt={resolverData?._meta.computedAt}
                usable={ddrUsable} loading={!resolverData && !resolverError} />
              {ddrUsable ? <ForecastZone items={items} logoMap={logoMap} /> : null}
            </div>
          ) : null}
          {resolverReviewerEnabled ? (
            <div className={cn("flex flex-col bg-muted/20 p-4 sm:p-5", trackSpan)}>
              <SourceStatus label="Reviewer" computedAt={resolverReviewData?._meta.computedAt}
                usable={ddrrUsable} loading={!resolverReviewData && !resolverReviewError} />
              {ddrrUsable && headline ? <TrackRecordZone
                accuracyValue={accuracyValue}
                scored={scored}
                lockedCount={headline.lockedPredictionCount}
                durationScored={headline.durationScoredCount}
                rates={rates}
              /> : null}
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
