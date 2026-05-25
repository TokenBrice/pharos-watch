"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatBps, formatElapsedSeconds } from "@shared/lib/format";
import { DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-resolver-version";
import {
  DDR_PUBLIC_WARNING,
  type DdrCellState,
  type DdrFactor,
  type DdrFactorSeverity,
  type DdrHorizonCell,
  type DdrResolutionTier,
  type DdrResponse,
  type DdrRow,
} from "@shared/types/depeg-resolver";

interface DepegResolverModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
}

// --- tier + factor copy ----------------------------------------------------

/**
 * The verdict is the card's headline. Each tier owns a tinted band, a plain-language
 * read, and a semantic hue. Color is reinforced with the label text — never color alone.
 */
const TIER_META: Record<
  DdrResolutionTier,
  { label: string; blurb: string; band: string }
> = {
  recovery_likely: {
    label: "Recovery Likely",
    blurb: "Structure and live signals favor a return to peg.",
    band: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  at_risk: {
    label: "At Risk",
    blurb: "Recovery is plausible but not assured — the kill signals are live.",
    band: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  recovery_unlikely: {
    label: "Recovery Unlikely",
    blurb: "Comparable structural failures did not return to peg.",
    band: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  insufficient_signal: {
    label: "Insufficient Signal",
    blurb: "Not enough live signal for a verdict yet.",
    band: "border-border/70 bg-muted/50 text-foreground",
  },
};

const SEVERITY_LABEL: Record<DdrFactorSeverity, string> = {
  severe: "Severe",
  elevated: "Elevated",
  strong: "Strong",
  weak: "Weak",
};

/** Severity weight drives the diverging "signal pull" bar and the leading pips. */
const SEVERITY_WEIGHT: Record<DdrFactorSeverity, number> = {
  severe: 2,
  elevated: 1,
  strong: 2,
  weak: 1,
};

const CELL_STATE_LABELS: Record<DdrCellState, string> = {
  benchmarked: "Benchmarked",
  thin_support: "Thin support",
  no_comparable_closures: "No closures",
  chronic_tail: "Chronic tail",
  unsupported: "Low support",
  data_issue: "Data issue",
};

const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  insufficient_support: "Insufficient comparable recoveries for a duration band.",
  insufficient_signal: "Duration suppressed until the resolver has enough live signal.",
  verdict_terminal: "DDR does not expect recovery on current signals, so no duration estimate is shown.",
  stale_cache: "Duration suppressed because the resolver snapshot is stale.",
};

// --- formatting helpers ----------------------------------------------------

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;

/** Human-readable duration for the band copy: "6h", "2.5d", "45m". */
function formatDurationSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < HOUR_SECONDS) return `${Math.round(seconds / 60)}m`;
  if (seconds < DAY_SECONDS) {
    const hours = seconds / HOUR_SECONDS;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = seconds / DAY_SECONDS;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

// --- primitives ------------------------------------------------------------

function StageLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

function CoinLockup({
  row,
  logos,
}: {
  row: Pick<DdrRow, "stablecoinId" | "symbol" | "name">;
  logos?: Record<string, string>;
}) {
  return (
    <Link
      href={buildStablecoinUrl(row.stablecoinId)}
      className="pharos-focus-ring group/lockup flex min-w-0 items-center gap-2 rounded-sm"
    >
      <StablecoinLogo src={logos?.[row.stablecoinId]} name={row.symbol} size={26} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-foreground group-hover/lockup:underline">
          {row.symbol}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{row.name}</span>
      </span>
    </Link>
  );
}

/** Two pips that fill by severity weight, colored by the factor's side of the tension. */
function SeverityPips({ kind, weight }: { kind: "kill" | "anchor"; weight: number }) {
  const filled = kind === "kill" ? "bg-red-500" : "bg-emerald-500";
  const empty = kind === "kill" ? "bg-red-500/25" : "bg-emerald-500/25";
  return (
    <span className="mt-[3px] inline-flex shrink-0 gap-0.5" aria-hidden="true">
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 1 ? filled : empty)} />
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 2 ? filled : empty)} />
    </span>
  );
}

function FactorList({
  kind,
  factors,
}: {
  kind: "kill" | "anchor";
  factors: DdrFactor[];
}) {
  const heading = kind === "kill" ? "Toward terminal" : "Toward repeg";
  const headTone = kind === "kill" ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400";

  return (
    <div className="min-w-0 space-y-1.5">
      <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", headTone)}>
        {heading}
      </p>
      {factors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">none fired</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-2 text-xs">
              <SeverityPips kind={kind} weight={SEVERITY_WEIGHT[factor.severity]} />
              <span className="min-w-0 break-words leading-snug text-foreground/90">
                {factor.label}
              </span>
              <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {SEVERITY_LABEL[factor.severity]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Diverging tug-of-war: red pull (kills) left of a fixed axis, emerald pull (anchors) right. */
function SignalPull({ killWeight, anchorWeight }: { killWeight: number; anchorWeight: number }) {
  const max = Math.max(killWeight, anchorWeight, 1);
  const leftPct = (killWeight / max) * 100;
  const rightPct = (anchorWeight / max) * 100;
  const label =
    `Signal pull: kill signals weight ${killWeight}, recovery anchors weight ${anchorWeight}.`;

  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={label}>
      <div className="flex flex-1 justify-end">
        <div
          className="h-2 rounded-full bg-red-500/70"
          style={{ width: `${leftPct}%`, minWidth: killWeight > 0 ? "0.5rem" : 0 }}
        />
      </div>
      <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
      <div className="flex flex-1 justify-start">
        <div
          className="h-2 rounded-full bg-emerald-500/70"
          style={{ width: `${rightPct}%`, minWidth: anchorWeight > 0 ? "0.5rem" : 0 }}
        />
      </div>
    </div>
  );
}

/** One rung of the resolution ladder: a horizon, its midpoint fill, and the interval text. */
function HorizonRung({ cell }: { cell: DdrHorizonCell }) {
  const hasProbability = cell.probabilityDisplay != null && cell.probability != null;
  const fill = hasProbability ? Math.round((cell.probability ?? 0) * 100) : 0;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {cell.horizon}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        {hasProbability ? (
          <div className="h-full rounded-full bg-sky-500/80" style={{ width: `${fill}%` }} />
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1.5 text-xs leading-tight tabular-nums",
          hasProbability ? "font-mono font-semibold text-foreground" : "text-muted-foreground/80",
        )}
      >
        {cell.probabilityDisplay ?? CELL_STATE_LABELS[cell.state]}
      </div>
    </div>
  );
}

function DurationReadout({ row }: { row: DdrRow }) {
  const { duration } = row;
  const chronic = duration.ageStatus === "chronic_tail";

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <StageLabel>Expected duration</StageLabel>
        {duration.stratum ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground" title={duration.stratum}>
            {duration.stratum}
          </span>
        ) : null}
      </div>

      {duration.medianSec != null ? (
        <p className="text-sm text-foreground">
          Typically resolves within{" "}
          <span className="font-mono text-base font-semibold tabular-nums">
            ~{formatDurationSec(duration.medianSec)}
          </span>
          {duration.iqrSec ? (
            <span className="font-mono text-xs text-muted-foreground">
              {" "}
              ({formatDurationSec(duration.iqrSec[0])}–{formatDurationSec(duration.iqrSec[1])})
            </span>
          ) : null}
        </p>
      ) : null}

      {chronic ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          Unusually prolonged — already past comparable incidents&apos; P99.
        </p>
      ) : null}

      {duration.horizons.length > 0 ? (
        <div className="grid grid-cols-4 gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
          {duration.horizons.map((cell) => (
            <HorizonRung key={cell.horizon} cell={cell} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ResolverRowCard({ row, logos }: { row: DdrRow; logos?: Record<string, string> }) {
  const tier = row.resolution.tier;
  const meta = TIER_META[tier];
  const factors = row.resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const showTension = factors.length > 0 && tier !== "insufficient_signal";
  const showBand = tier !== "recovery_unlikely" && !row.duration.suppressed;
  const dirGlyph = row.direction === "below" ? "▼" : "▲";

  return (
    <Card className="gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        {/* Identity + direction */}
        <div className="flex items-start justify-between gap-3">
          <CoinLockup row={row} logos={logos} />
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        {/* Verdict band — the headline */}
        <div className={cn("rounded-lg border px-3 py-2.5", meta.band)}>
          <p className="text-[0.95rem] font-bold uppercase tracking-wide leading-none">
            {meta.label}
          </p>
          <p className="mt-1.5 text-xs leading-snug opacity-80">{meta.blurb}</p>
        </div>

        {/* Deviation metrics */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>
            peak <span className="text-foreground">{formatBps(row.peakDeviationBps)}</span>
          </span>
          {row.currentDeviationBps != null ? (
            <span>
              now <span className="text-foreground">{formatBps(row.currentDeviationBps)}</span>
            </span>
          ) : null}
          <span>
            age <span className="text-foreground">{formatElapsedSeconds(row.ageSec)}</span>
          </span>
        </div>

        {/* Stage 1 — the tension */}
        {showTension ? (
          <div className="space-y-2.5 border-t border-border/50 pt-3">
            <div className="flex items-center justify-between gap-2">
              <StageLabel>Will it recover?</StageLabel>
              <span className="font-mono text-[10px] text-muted-foreground">
                {kills.length} kill · {anchors.length} anchor
              </span>
            </div>
            <SignalPull killWeight={killWeight} anchorWeight={anchorWeight} />
            <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
              <FactorList kind="kill" factors={kills} />
              <FactorList kind="anchor" factors={anchors} />
            </div>
          </div>
        ) : null}

        {/* Stage 2 — duration, terminal, or suppressed */}
        <div className="border-t border-border/50 pt-3">
          {tier === "recovery_unlikely" ? (
            <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5">
              <p className="text-sm font-medium text-foreground">
                DDR does not expect this depeg to recover.
              </p>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">
                Comparable structural failures did not return to peg, so no duration estimate is shown.
              </p>
              <Link
                href="/cemetery"
                className="pharos-focus-ring mt-1.5 inline-block rounded-sm text-xs font-medium text-red-700 hover:underline dark:text-red-400"
              >
                See the Stablecoin Cemetery →
              </Link>
            </div>
          ) : tier === "insufficient_signal" ? (
            <div className="space-y-1.5">
              <StageLabel>Why no verdict</StageLabel>
              {row.resolution.insufficientReasons?.length ? (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {row.resolution.insufficientReasons.map((reason) => (
                    <li key={reason} className="flex gap-2">
                      <span aria-hidden="true" className="text-muted-foreground/50">
                        —
                      </span>
                      <span className="min-w-0">{reason}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Key inputs are missing for this event.
                </p>
              )}
            </div>
          ) : showBand ? (
            <DurationReadout row={row} />
          ) : row.duration.suppressedReason ? (
            <div className="space-y-1.5">
              <StageLabel>Expected duration</StageLabel>
              <p className="text-xs leading-snug text-muted-foreground">
                {SUPPRESSED_REASON_LABELS[row.duration.suppressedReason] ??
                  "Duration estimate is not available."}
              </p>
            </div>
          ) : null}
        </div>

        <RelatedContextDetails row={row} />
      </div>
    </Card>
  );
}

function RelatedContextDetails({ row }: { row: DdrRow }) {
  const c = row.relatedContext;
  const items: Array<{ label: string; value: string }> = [];
  if (c.dewsBand) {
    items.push({
      label: "DEWS",
      value: c.dewsScore != null ? `${c.dewsBand} · ${Math.round(c.dewsScore)}` : c.dewsBand,
    });
  }
  if (c.liquidityScore != null) {
    items.push({ label: "Liquidity", value: `${Math.round(c.liquidityScore)}` });
  }
  if (c.safetyGrade) {
    items.push({
      label: "Safety",
      value: c.safetyScore != null ? `${c.safetyGrade} · ${Math.round(c.safetyScore)}` : c.safetyGrade,
    });
  }
  if (c.supplyChange7dPct != null) {
    items.push({
      label: "Supply 7d",
      value: `${c.supplyChange7dPct > 0 ? "+" : ""}${c.supplyChange7dPct.toFixed(1)}%`,
    });
  }
  if (c.mintSurge != null) {
    items.push({ label: "Mint surge", value: c.mintSurge ? "yes" : "no" });
  }

  if (items.length === 0) return null;

  return (
    <details className="group border-t border-border/50 pt-2.5">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center rounded-md text-xs text-muted-foreground hover:text-foreground sm:min-h-0">
        Related context
        <span aria-hidden="true" className="ml-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-mono tabular-nums text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// --- module header ---------------------------------------------------------

function ResolverHeader({ data }: { data: DdrResponse | undefined }) {
  const lineage = data?._meta.lineage ?? null;
  const versionLabel = data?.methodology.currentVersionLabel ?? DDR_METHODOLOGY_VERSION_LABEL;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
      <div className="flex items-center gap-2">
        <h2 className="pharos-kicker">Depeg Duration Resolver</h2>
        {versionLabel ? (
          <Badge
            variant="outline"
            className="border-violet-500/30 bg-violet-500/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wide text-violet-700 dark:text-violet-400"
          >
            {versionLabel}
          </Badge>
        ) : null}
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
        >
          Beta
        </Badge>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              aria-label="About the Depeg Duration Resolver"
              className="pharos-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:h-5 sm:w-5"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px]">
              For each open confirmed depeg, the resolver weighs kill signals against recovery
              anchors for a mechanistic verdict, then — when recovery is plausible — an empirical
              expected duration from comparable historical incidents.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {lineage ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          calibrated on {lineage.incidentCount.toLocaleString()} recovered incidents ·{" "}
          {lineage.coinCount} coins
        </p>
      ) : null}
    </div>
  );
}

function ResolverNote() {
  return (
    <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {DDR_PUBLIC_WARNING}
    </p>
  );
}

// --- public component -------------------------------------------------------

export function DepegResolverModule({ data, logos }: DepegResolverModuleProps) {
  if (!isDepegResolverEnabled()) return null;

  const rows = data?.rows ?? [];
  const showStaleRows =
    data?._meta.degraded === true && data._meta.degradedReason === "stale-cache" && rows.length > 0;

  return (
    <section aria-label="Depeg Duration Resolver" className="space-y-4">
      <ResolverHeader data={data} />
      <ResolverNote />

      {!data ? (
        <div className="pharos-empty-note text-center">Resolver data is loading.</div>
      ) : data._meta.degraded && !showStaleRows ? (
        <div className="pharos-empty-note text-center">Resolver data is temporarily unavailable.</div>
      ) : rows.length === 0 ? (
        <div className="pharos-empty-note">
          <p className="font-medium text-foreground">No active confirmed depegs.</p>
          <p className="mt-1">
            When Pharos confirms an open depeg, its recovery verdict and — if recovery looks likely
            — an expected-duration band appear here.
          </p>
        </div>
      ) : (
        <>
          {showStaleRows ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Resolver snapshot is stale; duration estimates are suppressed until the next refresh.
            </p>
          ) : null}
          <div className="pharos-stagger-entrance grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {rows.map((row, i) => (
              <div
                key={`${row.stablecoinId}:${row.eventId}`}
                style={{ "--stagger-index": i } as CSSProperties}
              >
                <ResolverRowCard row={row} logos={logos} />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
