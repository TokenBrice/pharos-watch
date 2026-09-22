import type {
  DdrDuration,
  DdrFactorSeverity,
  DdrHorizon,
  DdrPublicPredictionState,
  DdrResolution,
  DdrResolutionTier,
  DdrV2PredictionRow,
  DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";

type DdrRelatedContext = DdrV2PredictionRow["frozen"]["relatedContext"];

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

const EMPTY_CONTEXT: DdrRelatedContext = {
  dewsBand: null,
  dewsScore: null,
  liquidityScore: null,
  safetyGrade: null,
  safetyScore: null,
  supplyChange7dPct: null,
  supplyChange30dPct: null,
  mintSurge: null,
};

export const TIER_META: Record<DdrResolutionTier, { label: string; blurb: string; band: string; accent: string }> = {
  recovery_likely: {
    label: "Recovery Likely",
    blurb: "Structure and live signals favor a return to peg.",
    band: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    accent: "text-emerald-700 dark:text-emerald-400",
  },
  at_risk: {
    label: "At Risk",
    blurb: "Recovery is plausible but not assured — the kill signals are live.",
    band: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "text-amber-700 dark:text-amber-400",
  },
  recovery_unlikely: {
    label: "Recovery Unlikely",
    blurb: "Comparable structural failures did not return to peg.",
    band: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    accent: "text-red-700 dark:text-red-400",
  },
  insufficient_signal: {
    label: "Insufficient Signal",
    blurb: "Not enough live signal for a verdict yet.",
    band: "border-border/70 bg-muted/50 text-foreground",
    accent: "text-foreground",
  },
};

export const NOW_DOT_TONE: Record<DdrResolutionTier, string> = {
  recovery_likely: "bg-emerald-500",
  at_risk: "bg-amber-500",
  recovery_unlikely: "bg-red-500",
  insufficient_signal: "bg-muted-foreground/60",
};

export const SEVERITY_LABEL: Record<DdrFactorSeverity, string> = {
  severe: "Severe",
  elevated: "Elevated",
  strong: "Strong",
  weak: "Weak",
};

export const SEVERITY_WEIGHT: Record<DdrFactorSeverity, number> = {
  severe: 2,
  elevated: 1,
  strong: 2,
  weak: 1,
};

export const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  insufficient_support: "Insufficient comparable recoveries for a duration band.",
  insufficient_signal: "Duration suppressed until the resolver has enough live signal.",
  verdict_terminal: "DDR does not expect recovery on current signals, so no duration estimate is shown.",
  stale_cache: "Duration suppressed because the resolver snapshot is stale.",
};

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;

const HORIZON_SECONDS: Record<DdrHorizon, number> = {
  "6h": 6 * HOUR_SECONDS,
  "24h": 24 * HOUR_SECONDS,
  "7d": 7 * DAY_SECONDS,
  "30d": 30 * DAY_SECONDS,
};

export const FORWARD_STOPS: ReadonlyArray<{ horizon: DdrHorizon; x: number }> = [
  { horizon: "6h", x: 16 },
  { horizon: "24h", x: 40 },
  { horizon: "7d", x: 64 },
  { horizon: "30d", x: 88 },
];

export function getResolution(row: DdrV2ResponseRow): DdrResolution {
  if (row.kind === "prediction") return row.frozen.resolution;
  if (row.kind === "invalidated_prediction" && row.originalKind === "prediction") {
    return (row.originalOutcome as DdrV2PredictionRow["frozen"]).resolution;
  }
  return EMPTY_RESOLUTION;
}

export function getDuration(row: DdrV2ResponseRow): DdrDuration {
  if (row.kind === "prediction") return row.frozen.duration;
  if (row.kind === "invalidated_prediction" && row.originalKind === "prediction") {
    return (row.originalOutcome as DdrV2PredictionRow["frozen"]).duration;
  }
  return EMPTY_DURATION;
}

export function getRelatedContext(row: DdrV2ResponseRow): DdrRelatedContext {
  if (row.kind === "prediction") return row.frozen.relatedContext;
  if (row.kind === "no_call") return row.noCall.relatedContext;
  if (row.kind === "invalidated_prediction") return row.originalOutcome.relatedContext;
  return EMPTY_CONTEXT;
}

export function getAgeSec(row: DdrV2ResponseRow): number {
  return row.live.ageSec;
}

export function getPeakDeviationBps(row: DdrV2ResponseRow): number {
  return row.kind === "prediction" ? row.frozen.sourceRow.peakDeviationBps : row.live.peakDeviationBps;
}

export function getCurrentDeviationBps(row: DdrV2ResponseRow): number | null {
  return row.kind === "prediction" ? row.frozen.sourceRow.currentDeviationBps : row.live.currentDeviationBps;
}

export function getLiveCurrentDeviationBps(row: DdrV2ResponseRow): number | null {
  return row.live.currentDeviationBps;
}

export function formatDurationSec(seconds: number): string {
  return formatApproxDurationSeconds(seconds, { invalidFallback: "—" });
}

export function formatUtcTimestamp(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function compactLockTiming(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

export function getPredictionState(row: DdrV2ResponseRow): DdrPublicPredictionState {
  return row.prediction.state;
}

export function getLockMetadata(row: DdrV2ResponseRow) {
  const prediction = row.prediction;
  const lockedAt = prediction.lockedAt;
  return {
    lockedAt,
    eligibleAt: prediction.eligibleAt,
    predictedAt: prediction.publishedAt,
    predictedAgeSec: lockedAt != null ? Math.max(0, lockedAt - row.startedAt) : null,
    lockTiming: prediction.lockTiming,
    lockTrigger: prediction.lockTrigger,
    policyDelaySec: prediction.policyDelaySec,
    readinessScore: prediction.readiness?.score ?? null,
    readinessThreshold: prediction.readiness?.threshold ?? null,
    backstopAt: prediction.backstop?.backstopAt ?? null,
    backstopDelaySec: prediction.backstop?.delaySec ?? null,
    incidentKey: row.incidentKey,
  };
}

export function getMissingReasons(row: DdrV2ResponseRow): string[] {
  if (row.kind === "no_call") return row.noCall.missingReasons;
  if (row.kind === "invalidated_prediction" && row.originalKind === "no_call") {
    return row.noCall?.missingReasons ?? [];
  }
  return getResolution(row).insufficientReasons ?? [];
}

export function timeToForwardX(seconds: number): number {
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
