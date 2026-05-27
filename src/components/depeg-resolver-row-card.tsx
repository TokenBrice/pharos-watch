"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatBps, formatElapsedSeconds, formatPrice, pegCurrencySymbol } from "@shared/lib/format";
import type {
  DdrDuration,
  DdrFactor,
  DdrFactorSeverity,
  DdrHorizon,
  DdrResolutionTier,
  DdrRow,
} from "@shared/types/depeg-resolver";

interface DepegResolverRowCardProps {
  row: DdrRow;
  logos?: Record<string, string>;
}

interface StablecoinDepegResolverRowsProps {
  stablecoinId: string;
  data:
    | {
        _meta: {
          degraded: boolean;
          degradedReason?: string | null;
        };
        rows: DdrRow[];
      }
    | undefined;
  logoSrc?: string;
}

const TIER_META: Record<DdrResolutionTier, { label: string; blurb: string; band: string }> = {
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

const NOW_DOT_TONE: Record<DdrResolutionTier, string> = {
  recovery_likely: "bg-emerald-500",
  at_risk: "bg-amber-500",
  recovery_unlikely: "bg-red-500",
  insufficient_signal: "bg-muted-foreground/60",
};

const SEVERITY_LABEL: Record<DdrFactorSeverity, string> = {
  severe: "Severe",
  elevated: "Elevated",
  strong: "Strong",
  weak: "Weak",
};

const SEVERITY_WEIGHT: Record<DdrFactorSeverity, number> = {
  severe: 2,
  elevated: 1,
  strong: 2,
  weak: 1,
};

const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  insufficient_support: "Insufficient comparable recoveries for a duration band.",
  insufficient_signal: "Duration suppressed until the resolver has enough live signal.",
  verdict_terminal: "DDR does not expect recovery on current signals, so no duration estimate is shown.",
  stale_cache: "Duration suppressed because the resolver snapshot is stale.",
};

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;

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

const HORIZON_SECONDS: Record<DdrHorizon, number> = {
  "6h": 6 * HOUR_SECONDS,
  "24h": 24 * HOUR_SECONDS,
  "7d": 7 * DAY_SECONDS,
  "30d": 30 * DAY_SECONDS,
};

const FORWARD_STOPS: ReadonlyArray<{ horizon: DdrHorizon; x: number }> = [
  { horizon: "6h", x: 16 },
  { horizon: "24h", x: 40 },
  { horizon: "7d", x: 64 },
  { horizon: "30d", x: 88 },
];

function timeToForwardX(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const first = FORWARD_STOPS[0];
  const last = FORWARD_STOPS[FORWARD_STOPS.length - 1];
  if (seconds <= HORIZON_SECONDS[first.horizon]) {
    return (seconds / HORIZON_SECONDS[first.horizon]) * first.x;
  }
  if (seconds >= HORIZON_SECONDS[last.horizon]) return Math.min(last.x + 6, 96);
  for (let i = 0; i < FORWARD_STOPS.length - 1; i += 1) {
    const a = FORWARD_STOPS[i];
    const b = FORWARD_STOPS[i + 1];
    const aSec = HORIZON_SECONDS[a.horizon];
    const bSec = HORIZON_SECONDS[b.horizon];
    if (seconds <= bSec) {
      const t = (seconds - aSec) / (bSec - aSec);
      return a.x + t * (b.x - a.x);
    }
  }
  return last.x;
}

function StageLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{children}</p>;
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

function FactorList({ kind, factors }: { kind: "kill" | "anchor"; factors: DdrFactor[] }) {
  const heading = kind === "kill" ? "Toward terminal" : "Toward repeg";
  const headTone = kind === "kill" ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400";

  return (
    <div className="min-w-0 space-y-1.5">
      <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", headTone)}>{heading}</p>
      {factors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">none fired</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-2 text-xs">
              <SeverityPips kind={kind} weight={SEVERITY_WEIGHT[factor.severity]} />
              <span className="min-w-0 break-words leading-snug text-foreground/90">{factor.label}</span>
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

function SignalPull({ killWeight, anchorWeight }: { killWeight: number; anchorWeight: number }) {
  const max = Math.max(killWeight, anchorWeight, 1);
  const leftPct = (killWeight / max) * 100;
  const rightPct = (anchorWeight / max) * 100;
  const label = `Signal pull: kill signals weight ${killWeight}, recovery anchors weight ${anchorWeight}.`;

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

function PastDeviationSpark({ row }: { row: DdrRow }) {
  const peak = Math.abs(row.peakDeviationBps);
  const now = row.currentDeviationBps != null ? Math.abs(row.currentDeviationBps) : peak;
  const max = Math.max(peak, now, 1);
  const below = row.direction === "below";

  const pegY = 20;
  const depthY = (frac: number) => (below ? pegY + frac * 16 : pegY - frac * 16);
  const peakY = depthY(peak / max);
  const nowY = depthY(now / max);
  const line = `0,${pegY} 48,${peakY} 100,${nowY}`;
  const area = `0,${pegY} 48,${peakY} 100,${nowY} 100,${pegY}`;

  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full text-red-500"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1={pegY}
        x2="100"
        y2={pegY}
        stroke="currentColor"
        className="text-border"
        strokeWidth={0.75}
        strokeDasharray="2 3"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={area} fill="currentColor" fillOpacity={0.1} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ForwardProjection({ duration }: { duration: DdrDuration }) {
  const medianX = duration.medianSec != null ? timeToForwardX(duration.medianSec) : null;
  const iqrLeft = duration.iqrSec ? timeToForwardX(duration.iqrSec[0]) : null;
  const iqrRight = duration.iqrSec ? timeToForwardX(duration.iqrSec[1]) : null;
  const displayHorizons = duration.horizons.filter((cell) =>
    FORWARD_STOPS.some((stop) => stop.horizon === cell.horizon),
  );

  return (
    <div className="absolute inset-0">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-sky-500/60 via-sky-500/30 to-transparent" />
      <span
        className="absolute right-0 top-1/2 -translate-y-1/2 border-y-[3px] border-l-[5px] border-y-transparent border-l-sky-500/40"
        aria-hidden="true"
      />

      {iqrLeft != null && iqrRight != null ? (
        <span
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-sky-500/20"
          style={{ left: `${iqrLeft}%`, width: `${Math.max(2, iqrRight - iqrLeft)}%` }}
        />
      ) : null}

      {displayHorizons.map((cell) => {
        const stop = FORWARD_STOPS.find((s) => s.horizon === cell.horizon)!;
        const hasProb = cell.probability != null;
        return (
          <div
            key={cell.horizon}
            className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
            style={{ left: `${stop.x}%` }}
          >
            <span className="text-[8px] font-medium uppercase tracking-wide text-muted-foreground">{cell.horizon}</span>
            {hasProb ? (
              <span className="font-mono text-[9px] leading-none text-sky-700 dark:text-sky-400">
                {Math.round((cell.probability ?? 0) * 100)}%
              </span>
            ) : (
              <span className="font-mono text-[9px] leading-none text-muted-foreground/50">·</span>
            )}
          </div>
        );
      })}

      {displayHorizons.map((cell) => {
        const stop = FORWARD_STOPS.find((s) => s.horizon === cell.horizon)!;
        return (
          <span
            key={`tick-${cell.horizon}`}
            className="absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border"
            style={{ left: `${stop.x}%` }}
            aria-hidden="true"
          />
        );
      })}

      {medianX != null && duration.medianSec != null ? (
        <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${medianX}%` }}>
          <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] font-semibold leading-none text-foreground">
            ~{formatDurationSec(duration.medianSec)}
          </span>
          <span className="block h-2 w-2 rotate-45 bg-sky-500" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

function ForwardCap({ tone, label }: { tone: "terminal" | "muted"; label: string }) {
  const lineTone = tone === "terminal" ? "bg-red-500/30" : "bg-border";
  const textTone = tone === "terminal" ? "text-red-700 dark:text-red-400" : "text-muted-foreground/80";
  return (
    <div className="absolute inset-0 flex items-center">
      <span className={cn("h-px flex-1", lineTone)} aria-hidden="true" />
      <span className={cn("px-2 text-center text-[10px] font-medium leading-tight", textTone)}>{label}</span>
      <span className={cn("h-px flex-1", lineTone)} aria-hidden="true" />
    </div>
  );
}

function ForecastTimeline({ row }: { row: DdrRow }) {
  const tier = row.resolution.tier;
  const { duration } = row;
  const terminal = tier === "recovery_unlikely";
  const insufficient = tier === "insufficient_signal";
  const hasBand =
    !terminal && !insufficient && !duration.suppressed && (duration.medianSec != null || duration.horizons.length > 0);

  const forwardLabel = terminal
    ? "no recovery expected"
    : insufficient
      ? "awaiting signal"
      : "duration not benchmarked";

  const ariaLabel = `Forecast timeline: depeg open ${formatElapsedSeconds(row.ageSec)}, peak ${formatBps(
    row.peakDeviationBps,
  )}${row.currentDeviationBps != null ? `, now ${formatBps(row.currentDeviationBps)}` : ""}; verdict ${
    TIER_META[tier].label
  }${hasBand && duration.medianSec != null ? `; expected to resolve in about ${formatDurationSec(duration.medianSec)}` : `; ${forwardLabel}`}.`;

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5" role="img" aria-label={ariaLabel}>
      <div className="grid grid-cols-[1.05fr_auto_1.85fr] items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <span className="truncate">
          So far{" "}
          <span className="font-mono normal-case text-muted-foreground/90">· {formatElapsedSeconds(row.ageSec)}</span>
        </span>
        <span className="px-1 text-foreground/70">Now</span>
        <span className="text-right">{terminal || insufficient ? "Outlook" : "Projected"}</span>
      </div>

      <div className="mt-1 flex h-[58px] items-stretch gap-2">
        <div className="relative flex-[1.05]">
          <PastDeviationSpark row={row} />
        </div>

        <div className="relative flex w-3 items-center justify-center">
          <span className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border" aria-hidden="true" />
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            {!terminal && !insufficient ? (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping",
                  NOW_DOT_TONE[tier],
                )}
                aria-hidden="true"
              />
            ) : null}
            <span
              className={cn("relative inline-flex h-3 w-3 rounded-full ring-4 ring-background", NOW_DOT_TONE[tier])}
            />
          </span>
        </div>

        <div className="relative flex-[1.85]">
          {hasBand ? (
            <ForwardProjection duration={duration} />
          ) : (
            <ForwardCap tone={terminal ? "terminal" : "muted"} label={forwardLabel} />
          )}
        </div>
      </div>
    </div>
  );
}

export function DepegResolverRowCard({ row, logos }: DepegResolverRowCardProps) {
  const tier = row.resolution.tier;
  const meta = TIER_META[tier];
  const factors = row.resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const showTension = factors.length > 0 && tier !== "insufficient_signal";
  const chronic = row.duration.ageStatus === "chronic_tail";
  const dirGlyph = row.direction === "below" ? "▼" : "▲";
  const priceLabel =
    row.currentDeviationBps != null
      ? formatPrice(1 + row.currentDeviationBps / 10_000, pegCurrencySymbol(row.pegCurrency))
      : null;

  return (
    <Card className="gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CoinLockup row={row} logos={logos} />
            {priceLabel ? (
              <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                {priceLabel}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        <div className={cn("rounded-lg border px-3 py-2.5", meta.band)}>
          <p className="text-[0.95rem] font-bold uppercase tracking-wide leading-none">{meta.label}</p>
          <p className="mt-1.5 text-xs leading-snug opacity-80">{meta.blurb}</p>
        </div>

        <ForecastTimeline row={row} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>
            peak <span className="text-foreground">{formatBps(row.peakDeviationBps)}</span>
          </span>
          {row.currentDeviationBps != null ? (
            <span>
              now <span className="text-foreground">{formatBps(row.currentDeviationBps)}</span>
            </span>
          ) : null}
          {row.duration.medianSec != null && !row.duration.suppressed && tier !== "recovery_unlikely" ? (
            <span>
              ~resolve <span className="text-foreground">{formatDurationSec(row.duration.medianSec)}</span>
              {row.duration.iqrSec ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({formatDurationSec(row.duration.iqrSec[0])}–{formatDurationSec(row.duration.iqrSec[1])})
                </span>
              ) : null}
            </span>
          ) : null}
          {row.duration.stratum && !row.duration.suppressed && tier !== "recovery_unlikely" ? (
            <span className="truncate text-muted-foreground/80" title={row.duration.stratum}>
              {row.duration.stratum}
            </span>
          ) : null}
        </div>

        {chronic ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Unusually prolonged — already past comparable incidents&apos; P99.
          </p>
        ) : null}

        {tier === "recovery_unlikely" ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">DDR does not expect this depeg to recover.</p>
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
              <p className="text-xs text-muted-foreground">Key inputs are missing for this event.</p>
            )}
          </div>
        ) : row.duration.suppressed && row.duration.suppressedReason ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {SUPPRESSED_REASON_LABELS[row.duration.suppressedReason] ?? "Duration estimate is not available."}
          </p>
        ) : null}

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

export function StablecoinDepegResolverRows({ stablecoinId, data, logoSrc }: StablecoinDepegResolverRowsProps) {
  const rows = data?.rows.filter((row) => row.stablecoinId === stablecoinId) ?? [];
  const showStaleRows = data?._meta.degraded === true && data._meta.degradedReason === "stale-cache" && rows.length > 0;

  if (!data || (data._meta.degraded && !showStaleRows) || rows.length === 0) {
    return null;
  }

  const logos = logoSrc ? { [stablecoinId]: logoSrc } : undefined;

  return (
    <section aria-label={`Depeg Duration Resolver for ${rows[0]?.symbol ?? stablecoinId}`} className="space-y-4">
      {showStaleRows ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Resolver snapshot is stale; duration estimates are suppressed until the next refresh.
        </p>
      ) : null}
      <div className="space-y-4">
        {rows.map((row) => (
          <DepegResolverRowCard key={`${row.stablecoinId}:${row.eventId}`} row={row} logos={logos} />
        ))}
      </div>
    </section>
  );
}
