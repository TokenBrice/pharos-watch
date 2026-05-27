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
  DdrResponse,
  DdrResolution,
  DdrResolutionTier,
  DdrRow,
} from "@shared/types/depeg-resolver";

interface DepegResolverRowCardProps {
  row: DdrDisplayRow;
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
        rows: DdrDisplayRow[];
      }
    | undefined;
  logoSrc?: string;
}

type DdrDisplayRow = DdrResponse["rows"][number] | DdrRow;

type DdrPublicPredictionState =
  | "pending_lock"
  | "lock_deferred"
  | "publication_retry_pending"
  | "publication_failed"
  | "frozen"
  | "no_call"
  | "invalidated";

type DdrCompatPrediction = {
  state?: string | null;
  lockedAt?: number | null;
  predictedAt?: number | null;
  assessedAt?: number | null;
  eligibleAt?: number | null;
  eventAgeAtLockSec?: number | null;
  lockTiming?: string | null;
  missingReasons?: string[] | null;
  deferralReason?: string | null;
  retryStatus?: string | null;
  nextRetryAt?: number | null;
  publicationSnapshotToken?: string | null;
  originalOutcomeKind?: string | null;
  outcomeKind?: string | null;
  invalidatedAt?: number | null;
  invalidationReason?: string | null;
};

type DdrCompatErratum = {
  id?: string | number | null;
  reason?: string | null;
  summary?: string | null;
  createdAt?: number | null;
};

type DdrCompatRow = DdrDisplayRow & {
  kind?: string | null;
  predictionState?: string | null;
  incidentKey?: string | null;
  eligibleAt?: number | null;
  lockedAt?: number | null;
  lockTiming?: string | null;
  missingReasons?: string[] | null;
  prediction?: DdrCompatPrediction | null;
  frozen?: {
    resolution?: DdrResolution;
    duration?: DdrDuration;
    relatedContext?: DdrRow["relatedContext"];
    sourceRow?: Partial<DdrRow>;
  } | null;
  noCall?: {
    lockedAt?: number | null;
    eventAgeAtLockSec?: number | null;
    missingReasons?: string[] | null;
    relatedContext?: DdrRow["relatedContext"];
  } | null;
  originalOutcome?: {
    resolution?: DdrResolution;
    duration?: DdrDuration;
    relatedContext?: DdrRow["relatedContext"];
    missingReasons?: string[] | null;
  } | null;
  originalKind?: string | null;
  coverage?: { predictionState?: string | null; coverageState?: string | null } | null;
  live?: {
    ageSec?: number | null;
    currentDeviationBps?: number | null;
    peakDeviationBps?: number | null;
    status?: string | null;
    eventState?: string | null;
    active?: boolean | null;
    stale?: boolean | null;
    degradedReason?: string | null;
  } | null;
  latestErratum?: DdrCompatErratum | null;
  errata?: DdrCompatErratum[] | null;
};

const EMPTY_DURATION: DdrDuration = {
  suppressed: true,
  suppressedReason: "unavailable",
  stratum: null,
  medianSec: null,
  iqrSec: null,
  ageStatus: null,
  horizons: [],
};

const EMPTY_RESOLUTION: DdrResolution = {
  tier: "insufficient_signal",
  factors: [],
  insufficientReasons: [],
};

const EMPTY_CONTEXT: DdrRow["relatedContext"] = {
  dewsBand: null,
  dewsScore: null,
  liquidityScore: null,
  safetyGrade: null,
  safetyScore: null,
  supplyChange7dPct: null,
  supplyChange30dPct: null,
  mintSurge: null,
};

function getResolution(row: DdrDisplayRow): DdrResolution {
  const compat = row as DdrCompatRow;
  return ("resolution" in row ? row.resolution : undefined) ?? compat.frozen?.resolution ?? compat.originalOutcome?.resolution ?? EMPTY_RESOLUTION;
}

function getDuration(row: DdrDisplayRow): DdrDuration {
  const compat = row as DdrCompatRow;
  return ("duration" in row ? row.duration : undefined) ?? compat.frozen?.duration ?? compat.originalOutcome?.duration ?? EMPTY_DURATION;
}

function getRelatedContext(row: DdrDisplayRow): DdrRow["relatedContext"] {
  const compat = row as DdrCompatRow;
  return (
    ("relatedContext" in row ? row.relatedContext : undefined) ??
    compat.frozen?.relatedContext ??
    compat.noCall?.relatedContext ??
    EMPTY_CONTEXT
  );
}

function getAgeSec(row: DdrDisplayRow): number {
  const compat = row as DdrCompatRow;
  return ("ageSec" in row ? row.ageSec : undefined) ?? compat.live?.ageSec ?? compat.prediction?.eventAgeAtLockSec ?? compat.noCall?.eventAgeAtLockSec ?? 0;
}

function getPeakDeviationBps(row: DdrDisplayRow): number {
  const compat = row as DdrCompatRow;
  return ("peakDeviationBps" in row ? row.peakDeviationBps : undefined) ?? compat.live?.peakDeviationBps ?? compat.frozen?.sourceRow?.peakDeviationBps ?? 0;
}

function getCurrentDeviationBps(row: DdrDisplayRow): number | null {
  const compat = row as DdrCompatRow;
  return ("currentDeviationBps" in row ? row.currentDeviationBps : undefined) ?? compat.live?.currentDeviationBps ?? compat.frozen?.sourceRow?.currentDeviationBps ?? null;
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
const DDR_V2_STATES = new Set<string>([
  "pending_lock",
  "lock_deferred",
  "publication_retry_pending",
  "publication_failed",
  "frozen",
  "no_call",
  "invalidated",
]);

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

function formatUtcTimestamp(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function compactLockTiming(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

function getPredictionState(row: DdrDisplayRow): DdrPublicPredictionState | null {
  const compat = row as DdrCompatRow;
  const state =
    compat.prediction?.state ?? compat.predictionState ?? compat.coverage?.predictionState ?? compat.coverage?.coverageState;
  if (state && DDR_V2_STATES.has(state)) return state as DdrPublicPredictionState;

  switch (compat.kind) {
    case "pending":
      return "pending_lock";
    case "prediction":
      return "frozen";
    case "no_call":
      return "no_call";
    case "invalidated_prediction":
      return "invalidated";
    default:
      return null;
  }
}

function getLockMetadata(row: DdrDisplayRow) {
  const compat = row as DdrCompatRow;
  const prediction = compat.prediction ?? {};
  const lockedAt = prediction.lockedAt ?? prediction.assessedAt ?? compat.lockedAt ?? null;
  const eligibleAt = prediction.eligibleAt ?? compat.eligibleAt ?? null;
  const predictedAt = prediction.predictedAt ?? prediction.assessedAt ?? lockedAt;
  const predictedAgeSec = lockedAt != null ? Math.max(0, lockedAt - row.startedAt) : null;

  return {
    lockedAt,
    eligibleAt,
    predictedAt,
    predictedAgeSec,
    lockTiming: prediction.lockTiming ?? compat.lockTiming ?? null,
    incidentKey: compat.incidentKey ?? null,
  };
}

function getMissingReasons(row: DdrDisplayRow): string[] {
  const compat = row as DdrCompatRow;
  return (
    compat.prediction?.missingReasons ??
    compat.noCall?.missingReasons ??
    compat.originalOutcome?.missingReasons ??
    compat.missingReasons ??
    getResolution(row).insufficientReasons ??
    []
  );
}

function getLatestErratum(row: DdrDisplayRow): DdrCompatErratum | null {
  const compat = row as DdrCompatRow;
  return compat.latestErratum ?? compat.errata?.[0] ?? null;
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

function MetadataPill({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function CoinLockup({
  row,
  logos,
}: {
  row: Pick<DdrDisplayRow, "stablecoinId" | "symbol" | "name">;
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

function PastDeviationSpark({ row }: { row: DdrDisplayRow }) {
  const peak = Math.abs(getPeakDeviationBps(row));
  const currentDeviationBps = getCurrentDeviationBps(row);
  const now = currentDeviationBps != null ? Math.abs(currentDeviationBps) : peak;
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

function ForecastTimeline({ row }: { row: DdrDisplayRow }) {
  const resolution = getResolution(row);
  const tier = resolution.tier;
  const duration = getDuration(row);
  const predictionState = getPredictionState(row);
  const lockAnchored = predictionState === "frozen";
  const lockMetadata = getLockMetadata(row);
  const terminal = tier === "recovery_unlikely";
  const insufficient = tier === "insufficient_signal";
  const hasBand =
    !terminal && !insufficient && !duration.suppressed && (duration.medianSec != null || duration.horizons.length > 0);

  const forwardLabel = terminal
    ? "no recovery expected"
      : insufficient
      ? "awaiting signal"
      : "duration not benchmarked";

  const ageSec = lockAnchored ? lockMetadata.predictedAgeSec ?? getAgeSec(row) : getAgeSec(row);
  const peakDeviationBps = getPeakDeviationBps(row);
  const currentDeviationBps = getCurrentDeviationBps(row);
  const ariaLabel = lockAnchored
    ? `Forecast timeline frozen at public lock: depeg age at lock ${formatElapsedSeconds(ageSec)}, peak ${formatBps(
        peakDeviationBps,
      )}${currentDeviationBps != null ? `, lock deviation ${formatBps(currentDeviationBps)}` : ""}; verdict ${
        TIER_META[tier].label
      }${hasBand && duration.medianSec != null ? `; expected to resolve in about ${formatDurationSec(duration.medianSec)} after lock` : `; ${forwardLabel}`}.`
    : `Forecast timeline: depeg open ${formatElapsedSeconds(ageSec)}, peak ${formatBps(peakDeviationBps)}${
        currentDeviationBps != null ? `, now ${formatBps(currentDeviationBps)}` : ""
      }; verdict ${TIER_META[tier].label}${
        hasBand && duration.medianSec != null ? `; expected to resolve in about ${formatDurationSec(duration.medianSec)}` : `; ${forwardLabel}`
      }.`;

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5" role="img" aria-label={ariaLabel}>
      <div className="grid grid-cols-[1.05fr_auto_1.85fr] items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <span className="truncate">
          {lockAnchored ? "At lock" : "So far"}{" "}
          <span className="font-mono normal-case text-muted-foreground/90">· {formatElapsedSeconds(ageSec)}</span>
        </span>
        <span className="px-1 text-foreground/70">{lockAnchored ? "Lock" : "Now"}</span>
        <span className="text-right">{terminal || insufficient ? "Outlook" : lockAnchored ? "From lock" : "Projected"}</span>
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

const STATE_COPY: Record<
  Exclude<DdrPublicPredictionState, "frozen">,
  { badge: string; title: string; body: string; tone: string }
> = {
  pending_lock: {
    badge: "Pending lock",
    title: "Prediction lock pending",
    body: "This incident is still before the 24h public lock point. DDR shows live facts only until the official lock run.",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  lock_deferred: {
    badge: "Lock deferred",
    title: "Health deferral",
    body: "The lock point has arrived, but a system-health predicate failed. DDR will retry on the next healthy run.",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  publication_retry_pending: {
    badge: "Publication delayed",
    title: "Forecast publication delayed",
    body: "A sealed outcome exists operationally but has not entered the first-publication manifest. DDR hides the sealed verdict until publication succeeds.",
    tone: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  publication_failed: {
    badge: "Publication failed",
    title: "Publication failed before public exposure",
    body: "DDR did not recoverably publish this lock outcome. DDRR counts it as operational coverage debt, not as a prediction users saw.",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  no_call: {
    badge: "No-call locked",
    title: "No-call at lock",
    body: "At the official lock run, required row-level inputs were missing. This is an accountable no-call, not a recovery or terminal verdict.",
    tone: "border-border bg-muted/70 text-foreground",
  },
  invalidated: {
    badge: "Invalidated",
    title: "Prediction invalidated by erratum",
    body: "The first-published lock outcome remains visible for audit, but an append-only erratum invalidated the source event or input.",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

function LiveFacts({ row }: { row: DdrDisplayRow }) {
  const compat = row as DdrCompatRow;
  const live = compat.live ?? {};
  const ageSec = live.ageSec ?? getAgeSec(row);
  const peakDeviationBps = live.peakDeviationBps ?? getPeakDeviationBps(row);
  const currentDeviationBps = live.currentDeviationBps ?? getCurrentDeviationBps(row);
  const status = live.status ?? ("eventState" in live ? live.eventState : live.active === false ? "closed" : live.stale ? "stale" : "active");

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
      <StageLabel>Live incident</StageLabel>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
        <span>
          age <span className="text-foreground">{formatElapsedSeconds(ageSec)}</span>
        </span>
        <span>
          peak <span className="text-foreground">{formatBps(peakDeviationBps)}</span>
        </span>
        {currentDeviationBps != null ? (
          <span>
            now <span className="text-foreground">{formatBps(currentDeviationBps)}</span>
          </span>
        ) : null}
        {status ? <span className="uppercase tracking-wide">{status}</span> : null}
      </div>
      {live.degradedReason ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Live overlay degraded: {live.degradedReason}.</p>
      ) : null}
    </div>
  );
}

function LockMetadataStrip({ row, showAnchoredDuration = false }: { row: DdrDisplayRow; showAnchoredDuration?: boolean }) {
  const metadata = getLockMetadata(row);
  const duration = getDuration(row);
  const lockedAt = formatUtcTimestamp(metadata.lockedAt);
  const eligibleAt = formatUtcTimestamp(metadata.eligibleAt);
  const predictedAt = formatUtcTimestamp(metadata.predictedAt);
  const anchoredDuration =
    showAnchoredDuration && duration.medianSec != null && !duration.suppressed
      ? `~${formatDurationSec(duration.medianSec)}${
          duration.iqrSec
            ? ` (${formatDurationSec(duration.iqrSec[0])}-${formatDurationSec(duration.iqrSec[1])})`
            : ""
        }`
      : null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <MetadataPill label="eligible" value={eligibleAt} />
      <MetadataPill label="locked" value={lockedAt} />
      <MetadataPill label="predicted at" value={metadata.predictedAgeSec != null ? formatElapsedSeconds(metadata.predictedAgeSec) : null} />
      <MetadataPill label="lock timing" value={compactLockTiming(metadata.lockTiming)} />
      <MetadataPill label="anchored duration" value={anchoredDuration} />
      <MetadataPill label="manifest" value={predictedAt && !lockedAt ? predictedAt : null} />
    </div>
  );
}

function StateOnlyCard({
  row,
  state,
  logos,
}: {
  row: DdrDisplayRow;
  state: Exclude<DdrPublicPredictionState, "frozen">;
  logos?: Record<string, string>;
}) {
  const copy = STATE_COPY[state];
  const compat = row as DdrCompatRow;
  const retryText =
    compat.prediction?.nextRetryAt != null
      ? `Next retry ${formatUtcTimestamp(compat.prediction.nextRetryAt)}`
      : compat.prediction?.retryStatus ?? null;
  const deferralReason = compat.prediction?.deferralReason ?? compat.live?.degradedReason ?? null;
  const missingReasons = getMissingReasons(row);
  const erratum = getLatestErratum(row);
  const originalOutcome = compat.prediction?.originalOutcomeKind ?? compat.prediction?.outcomeKind ?? null;
  const dirGlyph = row.direction === "below" ? "▼" : "▲";

  return (
    <Card className="gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CoinLockup row={row} logos={logos} />
          </div>
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        <div className={cn("rounded-lg border px-3 py-2.5", copy.tone)}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.95rem] font-bold uppercase leading-none tracking-wide">{copy.title}</p>
            <span className="rounded-full border border-current/30 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
              {copy.badge}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-snug opacity-85">{copy.body}</p>
        </div>

        <LockMetadataStrip row={row} />
        <LiveFacts row={row} />

        {state === "lock_deferred" && (deferralReason || retryText) ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-xs">
            {deferralReason ? <p className="text-foreground">Deferral reason: {deferralReason}</p> : null}
            {retryText ? <p className="mt-1 text-muted-foreground">{retryText}</p> : null}
          </div>
        ) : null}

        {state === "publication_retry_pending" && retryText ? (
          <p className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] px-3 py-2.5 text-xs text-muted-foreground">
            {retryText}
          </p>
        ) : null}

        {state === "no_call" ? (
          <div className="space-y-1.5">
            <StageLabel>Missing inputs</StageLabel>
            {missingReasons.length ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {missingReasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted-foreground/50">
                      -
                    </span>
                    <span className="min-w-0">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No missing-input detail was published for this no-call.</p>
            )}
          </div>
        ) : null}

        {state === "invalidated" ? (
          <details className="group rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
            <summary className="pharos-focus-ring cursor-pointer list-none text-xs font-medium text-foreground">
              Erratum and original outcome
              <span aria-hidden="true" className="ml-1 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <p>
                Original lock outcome:{" "}
                <span className="font-mono uppercase text-foreground">{originalOutcome ?? "published prediction"}</span>
              </p>
              <p>
                Latest erratum:{" "}
                <span className="text-foreground">
                  {erratum?.summary ?? erratum?.reason ?? compat.prediction?.invalidationReason ?? "details unavailable"}
                </span>
              </p>
              {erratum?.createdAt ? <p>Recorded {formatUtcTimestamp(erratum.createdAt)}.</p> : null}
            </div>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

export function DepegResolverRowCard({ row, logos }: DepegResolverRowCardProps) {
  const predictionState = getPredictionState(row);
  if (predictionState && predictionState !== "frozen") {
    return <StateOnlyCard row={row} state={predictionState} logos={logos} />;
  }

  const resolution = getResolution(row);
  const duration = getDuration(row);
  const tier = resolution.tier;
  const meta = TIER_META[tier];
  const factors = resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const showTension = factors.length > 0 && tier !== "insufficient_signal";
  const chronic = duration.ageStatus === "chronic_tail";
  const dirGlyph = row.direction === "below" ? "▼" : "▲";
  const durationAnchorLabel = predictionState === "frozen" ? "from lock" : "~resolve";
  const priceLabel =
    getCurrentDeviationBps(row) != null
      ? formatPrice(1 + (getCurrentDeviationBps(row) ?? 0) / 10_000, pegCurrencySymbol(row.pegCurrency))
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.95rem] font-bold uppercase tracking-wide leading-none">{meta.label}</p>
            {predictionState === "frozen" ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Prediction frozen
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs leading-snug opacity-80">{meta.blurb}</p>
        </div>

        {predictionState === "frozen" ? <LockMetadataStrip row={row} showAnchoredDuration /> : null}

        <ForecastTimeline row={row} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>
            peak <span className="text-foreground">{formatBps(getPeakDeviationBps(row))}</span>
          </span>
          {getCurrentDeviationBps(row) != null ? (
            <span>
              {predictionState === "frozen" ? "live now" : "now"}{" "}
              <span className="text-foreground">{formatBps(getCurrentDeviationBps(row) ?? 0)}</span>
            </span>
          ) : null}
          {duration.medianSec != null && !duration.suppressed && tier !== "recovery_unlikely" ? (
            <span>
              {durationAnchorLabel} <span className="text-foreground">{formatDurationSec(duration.medianSec)}</span>
              {duration.iqrSec ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({formatDurationSec(duration.iqrSec[0])}–{formatDurationSec(duration.iqrSec[1])})
                </span>
              ) : null}
            </span>
          ) : null}
          {duration.stratum && !duration.suppressed && tier !== "recovery_unlikely" ? (
            <span className="truncate text-muted-foreground/80" title={duration.stratum}>
              {duration.stratum}
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
            {resolution.insufficientReasons?.length ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {resolution.insufficientReasons.map((reason) => (
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
        ) : duration.suppressed && duration.suppressedReason ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {SUPPRESSED_REASON_LABELS[duration.suppressedReason] ?? "Duration estimate is not available."}
          </p>
        ) : null}

        {predictionState === "frozen" ? <LiveFacts row={row} /> : null}

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

function RelatedContextDetails({ row }: { row: DdrDisplayRow }) {
  const c = getRelatedContext(row);
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
