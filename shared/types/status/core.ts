import { z } from "zod";
import { CacheStatusSchema, StatusHealthOrUnknownSchema, StatusHealthValueSchema } from "./schema-primitives";

export { StatusHealthValueSchema } from "./schema-primitives";

export type CacheStatus = z.infer<typeof CacheStatusSchema>;
export type StatusHealthValue = z.infer<typeof StatusHealthValueSchema>;
export type StatusHealthOrUnknown = z.infer<typeof StatusHealthOrUnknownSchema>;

export const StatusCauseSchema = z.object({
  code: z.string(),
  layer: z.enum(["availability", "data-quality", "system"]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  metric: z.string().optional(),
  value: z.number().optional(),
  threshold: z.number().optional(),
  /**
   * Optional operator-facing runbook link. Populated only for cause codes
   * that have a documented runbook — UI renders the link only when present.
   */
  runbookUrl: z.string().optional(),
});
export type StatusCause = z.output<typeof StatusCauseSchema>;

export const StatusStateInfoSchema = z.object({
  scope: z.literal("global"),
  currentStatus: StatusHealthValueSchema,
  rawStatus: StatusHealthValueSchema,
  lastEvaluatedAt: z.number(),
  lastChangedAt: z.number(),
  minDwellSec: z.number(),
  staleMinDwellSec: z.number(),
  consecutiveRaw: z.object({
    healthy: z.number(),
    degraded: z.number(),
    stale: z.number(),
  }),
  thresholds: z.object({
    escalateToDegraded: z.number(),
    escalateToStale: z.number(),
    recoverToDegraded: z.number(),
    recoverToHealthy: z.number(),
  }),
});
export type StatusStateInfo = z.output<typeof StatusStateInfoSchema>;

export const StatusStalenessSchema = z.object({
  ageSeconds: z.number(),
  maxAgeSec: z.number(),
  isStale: z.boolean(),
});
export type StatusStaleness = z.output<typeof StatusStalenessSchema>;

export const StatusProbePlaneSummarySchema = z.object({
  status: StatusHealthOrUnknownSchema,
  sampleCount: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  p95LatencyMs: z.number().nullable(),
  origins: z.array(z.string()),
});
export type StatusProbePlaneSummary = z.output<typeof StatusProbePlaneSummarySchema>;

export const STATUS_PROBE_COMPARISON_REASON_VALUES = [
  "in-sync",
  "internal-missing",
  "external-missing",
  "external-worse",
  "internal-worse",
] as const;
export type StatusProbeComparisonReason = (typeof STATUS_PROBE_COMPARISON_REASON_VALUES)[number];

export const StatusProbeComparisonSchema = z.object({
  hasDivergence: z.boolean(),
  severityDelta: z.number(),
  internalStatus: StatusHealthOrUnknownSchema,
  externalStatus: StatusHealthOrUnknownSchema,
  reason: z.enum(STATUS_PROBE_COMPARISON_REASON_VALUES),
  details: z.string().nullable(),
});
export type StatusProbeComparison = z.output<typeof StatusProbeComparisonSchema>;

export const STATUS_DISCREPANCY_REASON_VALUES = ["in-sync", "probe-stale", "probe-disagrees", "probe-missing"] as const;
export type StatusDiscrepancyReason = (typeof STATUS_DISCREPANCY_REASON_VALUES)[number];

export const StatusDiscrepancySchema = z.object({
  hasDivergence: z.boolean(),
  severityDelta: z.number(),
  statusSeverity: z.number(),
  probeSeverity: z.number(),
  details: z.string().nullable(),
  probeAgeSeconds: z.number().nullable(),
  consecutiveDivergent: z.number(),
  /**
   * Machine-readable classification so UI and alert logic can branch without
   * parsing `details`. Disambiguates "probe never ran" vs "probe ran but
   * disagrees" vs "probe is stale".
   */
  discrepancyReason: z.enum(STATUS_DISCREPANCY_REASON_VALUES),
});
export type StatusDiscrepancy = z.output<typeof StatusDiscrepancySchema>;

export const StatusTransitionSchema = z.object({
  id: z.number(),
  scope: z.literal("global"),
  from: StatusHealthValueSchema.nullable(),
  to: StatusHealthValueSchema,
  rawStatus: StatusHealthValueSchema,
  transitionType: z.enum(["degrade", "recover", "init"]),
  reason: z.string(),
  confidence: z.number(),
  causes: z.array(StatusCauseSchema),
  at: z.number(),
});
export type StatusTransition = z.output<typeof StatusTransitionSchema>;

export const StatusProbeSummarySchema = z.object({
  timestamp: z.number().nullable(),
  status: StatusHealthOrUnknownSchema,
  sampleCount: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  bootstrapMissCount: z.number().optional(),
  p95LatencyMs: z.number().nullable(),
  internal: StatusProbePlaneSummarySchema.nullable().optional(),
  external: StatusProbePlaneSummarySchema.nullable().optional(),
  internalExternalDiscrepancy: StatusProbeComparisonSchema.nullable().optional(),
});
export type StatusProbeSummary = z.output<typeof StatusProbeSummarySchema>;

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

export interface ActivePriceCoverageGap {
  stablecoinId: string;
  symbol: string;
  marketCapUsd: number | null;
  currentPrice: number | null;
  currentSource: string | null;
  currentObservedAt: number | null;
  currentConfidence: string | null;
  consecutiveMissingGenerations: number;
  lastAcceptedPrice: number | null;
  lastAcceptedSource: string | null;
  lastAcceptedObservedAt: number | null;
  rejectionReason: string;
  alertEligible: boolean;
}

export interface ActivePriceCoverageHealth {
  status: "complete" | "incomplete" | "unknown";
  expectedActiveCount: number;
  presentActiveCount: number;
  pricedActiveCount: number;
  missingPriceCount: number;
  pricedActiveIds: string[];
  missingActiveIds: string[];
  affectedMarketCapUsd: number;
  missingActiveAssets: ActivePriceCoverageGap[];
  alertEligibleCount: number;
  alertEligibleIds: string[];
  maxConsecutiveMissingGenerations: number;
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

interface RepairDebtKindSummary {
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
}
