import type { z } from "zod";
import { CacheStatusSchema, StatusHealthOrUnknownSchema, StatusHealthValueSchema } from "./schema-primitives";

export { StatusHealthValueSchema } from "./schema-primitives";

export type CacheStatus = z.infer<typeof CacheStatusSchema>;
export type StatusHealthValue = z.infer<typeof StatusHealthValueSchema>;
export type StatusHealthOrUnknown = z.infer<typeof StatusHealthOrUnknownSchema>;

export interface StatusCause {
  code: string;
  layer: "availability" | "data-quality" | "system";
  severity: "info" | "warning" | "critical";
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  /**
   * Optional operator-facing runbook link. Populated only for cause codes
   * that have a documented runbook — UI renders the link only when present.
   */
  runbookUrl?: string;
}

export interface StatusStateInfo {
  scope: "global";
  currentStatus: StatusHealthValue;
  rawStatus: StatusHealthValue;
  lastEvaluatedAt: number;
  lastChangedAt: number;
  minDwellSec: number;
  staleMinDwellSec: number;
  consecutiveRaw: {
    healthy: number;
    degraded: number;
    stale: number;
  };
  thresholds: {
    escalateToDegraded: number;
    escalateToStale: number;
    recoverToDegraded: number;
    recoverToHealthy: number;
  };
}

export interface StatusStaleness {
  ageSeconds: number;
  maxAgeSec: number;
  isStale: boolean;
}

export interface StatusProbeSummary {
  timestamp: number | null;
  status: StatusHealthOrUnknown;
  sampleCount: number;
  passCount: number;
  failCount: number;
  bootstrapMissCount?: number;
  p95LatencyMs: number | null;
  internal?: StatusProbePlaneSummary | null;
  external?: StatusProbePlaneSummary | null;
  internalExternalDiscrepancy?: StatusProbeComparison | null;
}

export interface StatusProbePlaneSummary {
  status: StatusHealthOrUnknown;
  sampleCount: number;
  passCount: number;
  failCount: number;
  p95LatencyMs: number | null;
  origins: string[];
}

export const STATUS_PROBE_COMPARISON_REASON_VALUES = [
  "in-sync",
  "internal-missing",
  "external-missing",
  "external-worse",
  "internal-worse",
] as const;
export type StatusProbeComparisonReason = (typeof STATUS_PROBE_COMPARISON_REASON_VALUES)[number];

export interface StatusProbeComparison {
  hasDivergence: boolean;
  severityDelta: number;
  internalStatus: StatusProbePlaneSummary["status"];
  externalStatus: StatusProbePlaneSummary["status"];
  reason: StatusProbeComparisonReason;
  details: string | null;
}

export const STATUS_DISCREPANCY_REASON_VALUES = ["in-sync", "probe-stale", "probe-disagrees", "probe-missing"] as const;
export type StatusDiscrepancyReason = (typeof STATUS_DISCREPANCY_REASON_VALUES)[number];

export interface StatusDiscrepancy {
  hasDivergence: boolean;
  severityDelta: number;
  statusSeverity: number;
  probeSeverity: number;
  details: string | null;
  probeAgeSeconds: number | null;
  consecutiveDivergent: number;
  /**
   * Machine-readable classification so UI and alert logic can branch without
   * parsing `details`. Disambiguates "probe never ran" vs "probe ran but
   * disagrees" vs "probe is stale".
   */
  discrepancyReason: StatusDiscrepancyReason;
}

export interface StatusTransition {
  id: number;
  scope: "global";
  from: StatusHealthValue | null;
  to: StatusHealthValue;
  rawStatus: StatusHealthValue;
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes: StatusCause[];
  at: number;
}

export interface DataQuality {
  stablecoinsCacheStatus: "ok" | "degraded" | "error";
  stablecoinsCacheReason: string | null;
  blacklistGapStatus: "ok" | "failed";
  activeDepegStatus: "ok" | "failed";
  onchainSupplyQueryStatus: "ok" | "failed" | "unavailable";
  repairDebt: RepairDebtSummary;
  ddrRepairDebtStatus: "ok" | "present" | "unknown";
  ddrRepairDebtCount: number;
  ddrRepairDebtCheckedAt: number | null;
  ddrRepairDebtEvents: Array<{
    eventId: number;
    reason: string;
  }>;
  ddrRepairDebtEventsTruncated: boolean;
  sourceFailures: Array<{
    source: "stablecoins-cache" | "blacklist-gaps" | "active-depegs" | "onchain-supply";
    message: string;
  }>;
  totalStablecoins: number;
  missingPrices: number;
  stablecoinPublication?: StablecoinPublicationHealth;
  blacklistMissingAmounts: number;
  blacklistRecentMissingAmounts: number;
  blacklistRecentWindowSec: number;
  blacklistMissingRatio: number;
  blacklistTotal: number;
  blacklistOldestRecoverableAgeSec: number | null;
  blacklistNeverAttemptedCount: number;
  blacklistRepeatedFailureCount: number;
  blacklistReconciliation?: BlacklistReconciliationStatus;
  onchainSupplyDivergences: number;
  onchainDivergenceRatio: number;
  onchainSupplyMonitoring: "active" | "unavailable";
  onchainSupplyLatestAt: number | null;
  onchainSupplyTrackedCoins: number;
  activeDepegs: number;
  staleOnchainSupply: number;
  onchainStaleRatio: number;
}

export interface StablecoinPublicationHealth {
  status: "complete" | "incomplete" | "unknown";
  expectedActiveCount: number;
  presentActiveCount: number;
  waivedActiveCount: number;
  missingActiveIds: string[];
  waivedActiveIds: string[];
  expiredWaiverIds: string[];
  observedAt: number | null;
}

export interface BlacklistReconciliationStatus {
  status: "not-run" | "running" | "verified" | "failed" | "unknown";
  runId: string | null;
  manifestId: string | null;
  manifestSha256: string | null;
  bookmarkRecorded: boolean;
  expectedEventCount: number;
  presentEventCount: number;
  missingEventCount: number;
  duplicateIdentityCount: number;
  destroyedAmountExpectedRaw: string;
  destroyedAmountActualRaw: string;
  balanceReplayExpectedCount: number;
  balanceReplayMatchingCount: number;
  unresolvedManifestGapCount: number;
  tronAtSafeHead: boolean;
  arbitrumAtSafeHead: boolean;
  startedAt: number | null;
  completedAt: number | null;
}

export interface RepairDebtKindSummary {
  openCount: number;
  oldestAgeSec: number | null;
  nextRunnerDueAt: number | null;
}

export interface RepairDebtSummary {
  status: "ok" | "present" | "unknown";
  openCount: number;
  oldestAgeSec: number | null;
  byKind: Record<string, RepairDebtKindSummary>;
  availabilityEscalated: boolean;
  nextRunnerDueAt: number | null;
  source: "worker-repair-tasks" | "worker-repair-tasks+ddr-cache-fallback" | "ddr-cache-fallback" | "unavailable";
}

export interface DatasetFreshness {
  stablecoins: number | null;
  blacklist: number | null;
  mintBurn: number | null;
  supply: number | null;
  safetyGrades: number | null;
  yield: number | null;
  depegs: number | null;
  dews: number | null;
  digest: number | null;
  discoveryCandidates: number | null;
}
