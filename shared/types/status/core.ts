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

export const BlacklistReconciliationStatusSchema = z.object({
  status: z.enum(["not-run", "running", "verified", "failed", "unknown"]),
  runId: z.string().nullable(),
  manifestId: z.string().nullable(),
  manifestSha256: z.string().nullable(),
  bookmarkRecorded: z.boolean(),
  expectedEventCount: z.number(),
  presentEventCount: z.number(),
  missingEventCount: z.number(),
  duplicateIdentityCount: z.number(),
  destroyedAmountExpectedRaw: z.string(),
  destroyedAmountActualRaw: z.string(),
  balanceReplayExpectedCount: z.number(),
  balanceReplayMatchingCount: z.number(),
  unresolvedManifestGapCount: z.number(),
  tronAtSafeHead: z.boolean(),
  arbitrumAtSafeHead: z.boolean(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});
export type BlacklistReconciliationStatus = z.output<typeof BlacklistReconciliationStatusSchema>;

const RepairDebtKindSummarySchema = z.object({
  openCount: z.number(),
  oldestAgeSec: z.number().nullable(),
  nextRunnerDueAt: z.number().nullable(),
});

export const RepairDebtSummarySchema = z.object({
  status: z.enum(["ok", "present", "unknown"]),
  openCount: z.number(),
  oldestAgeSec: z.number().nullable(),
  byKind: z.record(z.string(), RepairDebtKindSummarySchema),
  availabilityEscalated: z.boolean(),
  nextRunnerDueAt: z.number().nullable(),
  source: z.enum([
    "worker-repair-tasks",
    "worker-repair-tasks+ddr-cache-fallback",
    "ddr-cache-fallback",
    "unavailable",
  ]),
});
export type RepairDebtSummary = z.output<typeof RepairDebtSummarySchema>;
export const StablecoinPublicationHealthSchema = z.object({
  status: z.enum(["complete", "incomplete", "unknown"]),
  expectedActiveCount: z.number(),
  presentActiveCount: z.number(),
  waivedActiveCount: z.number(),
  missingActiveIds: z.array(z.string()),
  waivedActiveIds: z.array(z.string()),
  expiredWaiverIds: z.array(z.string()),
  observedAt: z.number().nullable(),
});
export type StablecoinPublicationHealth = z.output<typeof StablecoinPublicationHealthSchema>;

export const DataQualitySchema = z.object({
  stablecoinsCacheStatus: z.enum(["ok", "degraded", "error"]),
  stablecoinsCacheReason: z.string().nullable(),
  blacklistGapStatus: z.enum(["ok", "failed"]),
  activeDepegStatus: z.enum(["ok", "failed"]),
  onchainSupplyQueryStatus: z.enum(["ok", "failed", "unavailable"]),
  repairDebt: RepairDebtSummarySchema,
  ddrRepairDebtStatus: z.enum(["ok", "present", "unknown"]),
  ddrRepairDebtCount: z.number(),
  ddrRepairDebtCheckedAt: z.number().nullable(),
  ddrRepairDebtEvents: z.array(
    z.object({
      eventId: z.number(),
      reason: z.string(),
    }),
  ),
  ddrRepairDebtEventsTruncated: z.boolean(),
  sourceFailures: z.array(
    z.object({
      source: z.enum(["stablecoins-cache", "blacklist-gaps", "active-depegs", "onchain-supply"]),
      message: z.string(),
    }),
  ),
  totalStablecoins: z.number(),
  missingPrices: z.number(),
  stablecoinPublication: StablecoinPublicationHealthSchema.optional(),
  blacklistMissingAmounts: z.number(),
  blacklistRecentMissingAmounts: z.number(),
  blacklistRecentWindowSec: z.number(),
  blacklistMissingRatio: z.number(),
  blacklistTotal: z.number(),
  blacklistOldestRecoverableAgeSec: z.number().nullable(),
  blacklistNeverAttemptedCount: z.number(),
  blacklistRepeatedFailureCount: z.number(),
  blacklistReconciliation: BlacklistReconciliationStatusSchema.optional(),
  onchainSupplyDivergences: z.number(),
  onchainDivergenceRatio: z.number(),
  onchainSupplyMonitoring: z.enum(["active", "unavailable"]),
  onchainSupplyLatestAt: z.number().nullable(),
  onchainSupplyTrackedCoins: z.number(),
  activeDepegs: z.number(),
  staleOnchainSupply: z.number(),
  onchainStaleRatio: z.number(),
});
export type DataQuality = z.output<typeof DataQualitySchema>;

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

export const DatasetFreshnessSchema = z.object({
  stablecoins: z.number().nullable(),
  blacklist: z.number().nullable(),
  mintBurn: z.number().nullable(),
  supply: z.number().nullable(),
  safetyGrades: z.number().nullable(),
  yield: z.number().nullable(),
  depegs: z.number().nullable(),
  dews: z.number().nullable(),
  digest: z.number().nullable(),
});
export type DatasetFreshness = z.output<typeof DatasetFreshnessSchema>;
