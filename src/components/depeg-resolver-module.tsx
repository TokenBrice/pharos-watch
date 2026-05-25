"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import {
  DDR_PUBLIC_WARNING,
  type DdrCellState,
  type DdrFactor,
  type DdrHorizonCell,
  type DdrResolutionTier,
  type DdrResponse,
  type DdrRow,
} from "@shared/types";

interface DepegResolverModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
}

// --- copy maps -------------------------------------------------------------

const TIER_LABELS: Record<DdrResolutionTier, string> = {
  recovery_likely: "Recovery Likely",
  at_risk: "At Risk",
  recovery_unlikely: "Recovery Unlikely",
  insufficient_signal: "Insufficient Signal",
};

// Accent border + badge tones per tier, drawn from the design-system palette.
const TIER_STYLES: Record<DdrResolutionTier, { border: string; badge: string }> = {
  recovery_likely: {
    border: "border-l-emerald-500",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  at_risk: {
    border: "border-l-amber-500",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  recovery_unlikely: {
    border: "border-l-red-500",
    badge: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  insufficient_signal: {
    border: "border-l-zinc-500",
    badge: "border-border bg-muted text-muted-foreground",
  },
};

const CELL_STATE_LABELS: Record<DdrCellState, string> = {
  benchmarked: "Benchmarked",
  thin_support: "Thin support",
  no_comparable_closures: "No comparable closures",
  chronic_tail: "Chronic tail",
  unsupported: "Insufficient support",
  data_issue: "Data issue",
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

// --- sub-components ---------------------------------------------------------

function FactorChip({ factor }: { factor: DdrFactor }) {
  const isKill = factor.kind === "kill";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        isKill
          ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
      title={`${isKill ? "Kill signal" : "Recovery anchor"} · ${factor.severity}`}
    >
      <span>{factor.label}</span>
      <span className="font-mono text-[10px] uppercase tracking-wide opacity-70">
        {factor.severity}
      </span>
    </span>
  );
}

function HorizonCell({ cell }: { cell: DdrHorizonCell }) {
  const value = cell.probabilityDisplay ?? CELL_STATE_LABELS[cell.state];
  const hasProbability = cell.probabilityDisplay != null;
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {cell.horizon}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          hasProbability ? "font-mono text-foreground" : "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
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
    items.push({ label: "Supply 7d", value: `${c.supplyChange7dPct > 0 ? "+" : ""}${c.supplyChange7dPct.toFixed(1)}%` });
  }
  if (c.mintSurge != null) {
    items.push({ label: "Mint surge", value: c.mintSurge ? "yes" : "no" });
  }

  if (items.length === 0) return null;

  return (
    <details className="group mt-3">
      <summary className="pharos-focus-ring cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        Related context
        <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
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

function ResolverRowCard({ row, logos }: { row: DdrRow; logos?: Record<string, string> }) {
  const tier = row.resolution.tier;
  const style = TIER_STYLES[tier];
  const factors = row.resolution.factors;
  const duration = row.duration;
  const showBand = tier !== "recovery_unlikely" && !duration.suppressed;

  return (
    <Card className={cn("rounded-xl border-l-[3px]", style.border)}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={buildStablecoinUrl(row.stablecoinId)}
            className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-sm"
          >
            <StablecoinLogo src={logos?.[row.stablecoinId]} name={row.symbol} size={22} />
            <span className="truncate text-sm font-semibold">{row.symbol}</span>
            <span className="truncate text-xs text-muted-foreground">{row.name}</span>
          </Link>
          <Badge variant="outline" className={cn("text-xs", style.badge)}>
            {TIER_LABELS[tier]}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {row.direction === "below" ? "Below" : "Above"} {row.pegCurrency}
          </span>
          <span className="font-mono tabular-nums">
            peak {formatBps(row.peakDeviationBps)}
          </span>
          {row.currentDeviationBps != null ? (
            <span className="font-mono tabular-nums">now {formatBps(row.currentDeviationBps)}</span>
          ) : null}
          <span className="font-mono tabular-nums">age {formatElapsedSeconds(row.ageSec)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {factors.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {factors.map((factor) => (
              <FactorChip key={factor.code} factor={factor} />
            ))}
          </div>
        ) : null}

        {tier === "recovery_unlikely" ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm">
            <p className="text-foreground">
              Duration not estimated — comparable structural failures did not recover.
            </p>
            <Link
              href="/cemetery"
              className="pharos-focus-ring mt-1 inline-block rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              See the Stablecoin Cemetery →
            </Link>
          </div>
        ) : tier === "insufficient_signal" ? (
          <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <p className="text-foreground">Not enough signal for a verdict.</p>
            {row.resolution.insufficientReasons?.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {row.resolution.insufficientReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : showBand ? (
          <div className="space-y-2">
            {duration.medianSec != null ? (
              <p className="text-sm text-foreground">
                Typically resolves within{" "}
                <span className="font-mono font-semibold tabular-nums">
                  ~{formatDurationSec(duration.medianSec)}
                </span>
                {duration.iqrSec ? (
                  <span className="text-muted-foreground">
                    {" "}
                    ({formatDurationSec(duration.iqrSec[0])}–{formatDurationSec(duration.iqrSec[1])})
                  </span>
                ) : null}
              </p>
            ) : null}
            {duration.stratum ? (
              <p className="text-[11px] text-muted-foreground">Stratum: {duration.stratum}</p>
            ) : null}
            {duration.horizons.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {duration.horizons.map((cell) => (
                  <HorizonCell key={cell.horizon} cell={cell} />
                ))}
              </div>
            ) : null}
          </div>
        ) : duration.suppressedReason ? (
          <p className="text-sm text-muted-foreground">{duration.suppressedReason}</p>
        ) : null}

        <RelatedContextDetails row={row} />
      </CardContent>
    </Card>
  );
}

// --- public component -------------------------------------------------------

export function DepegResolverModule({ data, logos }: DepegResolverModuleProps) {
  if (!isDepegResolverEnabled()) return null;

  const rows = data?.rows ?? [];

  return (
    <section aria-label="Depeg Duration Resolver" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="pharos-kicker">Depeg Duration Resolver</h2>
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
                className="pharos-focus-ring inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                For each open confirmed depeg, the resolver gives a mechanistic recovery
                verdict and, when recoverable, an empirical expected duration drawn from
                comparable historical incidents.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {DDR_PUBLIC_WARNING}
      </p>

      {rows.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No active confirmed depegs. Resolver readouts appear here when Pharos has an open
            confirmed event.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((row) => (
            <ResolverRowCard key={`${row.stablecoinId}:${row.eventId}`} row={row} logos={logos} />
          ))}
        </div>
      )}
    </section>
  );
}
