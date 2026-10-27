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
import {
  DDR_TIER_LABELS,
  DDR_VERDICT_CLASSES,
  getDdrTierVocabulary,
  type DdrTierVocabulary,
} from "@shared/lib/classification";

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

const TIER_TONES: Record<DdrResolutionTier, { band: string; accent: string }> = {
  recovery_likely: {
    band: DDR_VERDICT_CLASSES.recovery_likely.band,
    accent: DDR_VERDICT_CLASSES.recovery_likely.accent,
  },
  at_risk: {
    band: DDR_VERDICT_CLASSES.at_risk.band,
    accent: DDR_VERDICT_CLASSES.at_risk.accent,
  },
  recovery_unlikely: {
    band: DDR_VERDICT_CLASSES.recovery_unlikely.band,
    accent: DDR_VERDICT_CLASSES.recovery_unlikely.accent,
  },
  insufficient_signal: {
    band: "border-border/70 bg-muted/50 text-foreground",
    accent: "text-foreground",
  },
};

export interface DdrTierMeta {
  label: string;
  short: string;
  blurb: string;
  band: string;
  accent: string;
}

/** Tier copy in the vocabulary the forecast was locked under; colors do not change with the label. */
export function getTierMeta(tier: DdrResolutionTier, vocabulary: DdrTierVocabulary): DdrTierMeta {
  return { ...DDR_TIER_LABELS[vocabulary][tier], ...TIER_TONES[tier] };
}

/** Rows locked before DDRv5 keep the labels they were published with. */
export function getTierVocabulary(row: Pick<DdrV2ResponseRow, "prediction">): DdrTierVocabulary {
  return getDdrTierVocabulary(row.prediction.predictionMethodologyVersion);
}

/** DDRv5 durations are unconditional cumulative incidence; absent means legacy conditional-on-recovery. */
export function isCumulativeIncidence(duration: Pick<DdrDuration, "estimand">): boolean {
  return duration.estimand === "cumulative_incidence";
}

const COARSE_HOURS_LIMIT_SEC = 2 * 86_400;

/** Coarse secondary readout for DDRv5 quantiles: whole hours under two days, else whole days. */
export function formatCoarseDurationSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < COARSE_HOURS_LIMIT_SEC) return `${Math.max(1, Math.round(seconds / 3600))}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** Share of comparable incidents unresolved within 30 days, rounded to 5 percentage points. */
export function formatUnresolvedShare(share: number): string {
  const rounded = Math.round(share * 20) * 5;
  return rounded === 0 && share > 0 ? "<5%" : `~${rounded}%`;
}

export const NOT_INFORMATIVE_CELL_LABEL = "Not informative at this age";

/** Reader copy for live-overlay and lock-deferral reason codes; unknown codes are de-kebabed. */
const DDR_REASON_LABELS: Record<string, string> = {
  "duration-exceeded": "past its forecast window",
  "secondary-overlay-unavailable": "secondary live data unavailable",
  "lock-deferred": "lock deferred",
  "lock-deferral-overlay": "lock deferral overlay unavailable",
  "closed-pending-review": "closed, pending review",
  "stale-cache": "showing the last cached build",
};

/** Serving-path reasons are operator signal (ADR-42); they never caption a reader's live facts. */
export function isDdrInfrastructureReason(code: string): boolean {
  return code === "stale-cache"
    || code === "errata-overlay-read-failed"
    || code === "lock-deferral-overlay-read-failed"
    || code.startsWith("manifest-fallback:");
}

export function formatDdrReason(code: string): string {
  if (code.startsWith("manifest-fallback:")) return "served from the publication manifest";
  return DDR_REASON_LABELS[code] ?? code.replace(/[-_:]+/g, " ");
}

export const DDR_EVENT_STATE_LABELS: Record<DdrV2ResponseRow["live"]["eventState"], string> = {
  active: "Active",
  closed_pending_review: "Closed, pending review",
  source_event_missing: "Source event missing",
  event_invalidated: "Event invalidated",
};

export function formatDdrDirection(row: Pick<DdrV2ResponseRow, "direction" | "pegCurrency">): string {
  return `${row.direction === "below" ? "▼ Below" : "▲ Above"} ${row.pegCurrency}`;
}

export const NOW_DOT_TONE: Record<DdrResolutionTier, string> = {
  recovery_likely: DDR_VERDICT_CLASSES.recovery_likely.dot,
  at_risk: DDR_VERDICT_CLASSES.at_risk.dot,
  recovery_unlikely: DDR_VERDICT_CLASSES.recovery_unlikely.dot,
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

/** Original invalidated outcomes belong to audit cards, never live forecast aggregates. */
export function isCurrentForecast(row: DdrV2ResponseRow): row is Extract<DdrV2ResponseRow, { kind: "prediction" }> {
  return row.kind === "prediction" && row.prediction.state === "frozen";
}

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

export function getAgeSec(row: DdrV2ResponseRow): number | null {
  return row.live.ageSec;
}

export function getPeakDeviationBps(row: DdrV2ResponseRow): number | null {
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
