import type {
  DdrDuration,
  DdrFactorSeverity,
  DdrHorizon,
  DdrResponse,
  DdrResolution,
  DdrResolutionTier,
  DdrRow,
} from "@shared/types/depeg-resolver";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";

export type DdrDisplayRow = DdrResponse["rows"][number] | DdrRow;

export type DdrPublicPredictionState =
  | "pending_lock"
  | "lock_deferred"
  | "publication_retry_pending"
  | "publication_failed"
  | "frozen"
  | "no_call"
  | "invalidated";

export type DdrCompatPrediction = {
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
  lockTrigger?: string | null;
  policyDelaySec?: number | null;
  readiness?: {
    score?: number | null;
    threshold?: number | null;
    version?: string | null;
  } | null;
  backstop?: {
    backstopAt?: number | null;
    delaySec?: number | null;
    reached?: boolean | null;
    version?: string | null;
  } | null;
  publicationSnapshotToken?: string | null;
  originalOutcomeKind?: string | null;
  outcomeKind?: string | null;
  invalidatedAt?: number | null;
  invalidationReason?: string | null;
};

export type DdrCompatErratum = {
  id?: string | number | null;
  reason?: string | null;
  summary?: string | null;
  createdAt?: number | null;
};

export type DdrCompatRow = DdrDisplayRow & {
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

const DDR_V2_STATES = new Set<string>([
  "pending_lock",
  "lock_deferred",
  "publication_retry_pending",
  "publication_failed",
  "frozen",
  "no_call",
  "invalidated",
]);

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

export function getResolution(row: DdrDisplayRow): DdrResolution {
  const compat = row as DdrCompatRow;
  return (
    ("resolution" in row ? row.resolution : undefined) ??
    compat.frozen?.resolution ??
    compat.originalOutcome?.resolution ??
    EMPTY_RESOLUTION
  );
}

export function getDuration(row: DdrDisplayRow): DdrDuration {
  const compat = row as DdrCompatRow;
  return (
    ("duration" in row ? row.duration : undefined) ??
    compat.frozen?.duration ??
    compat.originalOutcome?.duration ??
    EMPTY_DURATION
  );
}

export function getRelatedContext(row: DdrDisplayRow): DdrRow["relatedContext"] {
  const compat = row as DdrCompatRow;
  return (
    ("relatedContext" in row ? row.relatedContext : undefined) ??
    compat.frozen?.relatedContext ??
    compat.noCall?.relatedContext ??
    EMPTY_CONTEXT
  );
}

export function getAgeSec(row: DdrDisplayRow): number {
  const compat = row as DdrCompatRow;
  return (
    ("ageSec" in row ? row.ageSec : undefined) ??
    compat.live?.ageSec ??
    compat.prediction?.eventAgeAtLockSec ??
    compat.noCall?.eventAgeAtLockSec ??
    0
  );
}

export function getPeakDeviationBps(row: DdrDisplayRow): number {
  const compat = row as DdrCompatRow;
  const lockAnchored = compat.kind === "prediction" || compat.prediction?.state === "frozen";
  return (
    ("peakDeviationBps" in row ? row.peakDeviationBps : undefined) ??
    (lockAnchored ? compat.frozen?.sourceRow?.peakDeviationBps : undefined) ??
    compat.live?.peakDeviationBps ??
    compat.frozen?.sourceRow?.peakDeviationBps ??
    0
  );
}

export function getCurrentDeviationBps(row: DdrDisplayRow): number | null {
  const compat = row as DdrCompatRow;
  const lockAnchored = compat.kind === "prediction" || compat.prediction?.state === "frozen";
  return (
    ("currentDeviationBps" in row ? row.currentDeviationBps : undefined) ??
    (lockAnchored ? compat.frozen?.sourceRow?.currentDeviationBps : undefined) ??
    compat.live?.currentDeviationBps ??
    compat.frozen?.sourceRow?.currentDeviationBps ??
    null
  );
}

export function getLiveCurrentDeviationBps(row: DdrDisplayRow): number | null {
  const compat = row as DdrCompatRow;
  if (compat.live && "currentDeviationBps" in compat.live) {
    return compat.live.currentDeviationBps ?? null;
  }
  return (
    ("currentDeviationBps" in row ? row.currentDeviationBps : undefined) ??
    compat.frozen?.sourceRow?.currentDeviationBps ??
    null
  );
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

export function getPredictionState(row: DdrDisplayRow): DdrPublicPredictionState | null {
  const compat = row as DdrCompatRow;
  const state =
    compat.prediction?.state ??
    compat.predictionState ??
    compat.coverage?.predictionState ??
    compat.coverage?.coverageState;
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

export function getLockMetadata(row: DdrDisplayRow) {
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
    lockTrigger: prediction.lockTrigger ?? null,
    policyDelaySec: prediction.policyDelaySec ?? null,
    readinessScore: prediction.readiness?.score ?? null,
    readinessThreshold: prediction.readiness?.threshold ?? null,
    backstopAt: prediction.backstop?.backstopAt ?? null,
    backstopDelaySec: prediction.backstop?.delaySec ?? null,
    incidentKey: compat.incidentKey ?? null,
  };
}

export function getMissingReasons(row: DdrDisplayRow): string[] {
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

export function getLatestErratum(row: DdrDisplayRow): DdrCompatErratum | null {
  const compat = row as DdrCompatRow;
  return compat.latestErratum ?? compat.errata?.[0] ?? null;
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
