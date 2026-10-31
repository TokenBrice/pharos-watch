import { stripSensitive } from "./safe-error-message";
import { parseJsonObject } from "./json-parse";

/** Absolute ceiling; individual jobs normally admit only 8 KiB. */
export const MAX_PERSISTED_CRON_METADATA_BYTES = 64 * 1_024 - 1;
export const DEFAULT_CRON_METADATA_BUDGET_BYTES = 8 * 1_024;
// Producer-side assembly retains its existing headroom; write-time admission owns the job budget.
const SCHEDULED_CRON_METADATA_ENRICHMENT_HEADROOM_BYTES = 4 * 1_024;
export const MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES =
  MAX_PERSISTED_CRON_METADATA_BYTES - SCHEDULED_CRON_METADATA_ENRICHMENT_HEADROOM_BYTES;
// Exceptions retain consumer-read cohort/coverage evidence, not arbitrary diagnostic payloads.
const CRON_METADATA_BUDGET_BYTES: Readonly<Record<string, number>> = {
  "cron-sentinel": MAX_PERSISTED_CRON_METADATA_BYTES, // Nested source evidence and complete stale-generation rows.
  "sync-stablecoins": MAX_PERSISTED_CRON_METADATA_BYTES, // Complete missing-asset continuity feeds the next run.
  "sync-mint-burn": 32 * 1_024, // Per-config cursor/head and critical coverage evidence.
  "sync-mint-burn-extended": 32 * 1_024,
  "sync-live-reserves": 32 * 1_024, // Exact per-coin breaker names and warning/error cohorts rendered by operators.
  "sync-dex-liquidity": 16 * 1_024, // Consumer-read sourceCoverage and measured-execution ledger.
};
export function getCronMetadataBudgetBytes(job?: string): number {
  return (job ? CRON_METADATA_BUDGET_BYTES[job] : undefined) ?? DEFAULT_CRON_METADATA_BUDGET_BYTES;
}

const MAX_DIAGNOSTIC_STRING_CHARS = 500;
const MAX_NESTED_SCALARS = 24;
// Audited readers: cron-output, cron-health, freshness oracle, status supplements,
// public-health reads, cron-metadata-summary and the measured-execution ledger.
// Scalars remain top-level too. These collections must NEVER turn into counts.
const CONSUMER_METADATA_KEYS: Readonly<Record<string, boolean>> = Object.fromEntries([
  "reason", "reasons", "degradedReason", "degradedReasons", "quality", "outputPublishedAt",
  "mode", "stale", "sources", "sourceStatuses", "resourcePressure", "retentionTruncated", "d1Cost", "truncated",
  "sourceCoverage", "fallbackMode", "publication", "active", "chainHeads", "criticalCoverage", "extendedCoverage",
  "laggingConfigs", "breakerKeys", "coinsWithWarnings", "coinsWithErrors", "failedCoins", "failedSources",
  "tierBreakdown", "apiErrorClasses", "artifactCleanup", "invalidSupplyIds", "missingActiveIds", "missingFromCache",
  "pendingBacklog", "safetySource", "zeroSend", "runtimeBreaching", "slotAbandonmentBreaching",
  "latencySummary", "slowestProbes", "progress", "lease", "sourceFailures", "sourceFailureReasons",
  "sourceDistribution", "confidenceDistribution", "sourceDepthDistribution", "supplyCoverage", "priceHealth",
  "priceSourceHealth", "onchainPartition", "probePlanes", "internalExternalDiscrepancy", "freshnessDiagnostics",
  "activePriceCoverage", "activePublicationCoverage", "missingActiveState", "coverageOutcomeCounts", "persistence",
  "publicationStats", "apiErrorConfigs",
  "adapterTelemetryProgress", "adapterFailureBudget", "cohortGrading",
  "publicationAbortCause", "publicationPhaseElapsedMs", "publicationSubphaseElapsedMs", "publicMaterialization", "publicationPhaseTimingBasis",
  "executorMode", "executorColo", "executorColoSource", "cfPlacement", "executorWorkerVersion", "executionGeneration",
  "reserveQueue", "reserveQueueHandoff", "capabilities",
].map((key) => [key, true]));
// These are forensic-only cron copies. Active-price coverage is deliberately excluded:
// the next producer and public-health reader reconstruct missing-asset streaks from it.
// breakerKeys is deliberately excluded: the live-reserves summary renders its exact names.
const BULKY_DIAGNOSTIC_KEYS = [
  "adapterLatency", "priceSourceAttemptLedger", "providerDiagnostics", "fullAssets", "bridgeJoinDiagnostics",
];

export interface CompactedCronMetadata {
  metadata: string | null;
  originalBytes: number;
  persistedBytes: number;
  compacted: boolean;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedScalar(value: unknown): string | number | boolean | null | undefined {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return stripSensitive(value).slice(0, MAX_DIAGNOSTIC_STRING_CHARS);
  return undefined;
}

function summarizeDiagnostic(value: unknown): unknown {
  const scalar = boundedScalar(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) return { count: value.length };
  if (!value || typeof value !== "object") return undefined;

  const summary: Record<string, unknown> = {};
  let included = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (included >= MAX_NESTED_SCALARS) break;
    const nestedScalar = boundedScalar(nested);
    if (nestedScalar !== undefined) {
      summary[key] = nestedScalar;
      included++;
    } else if (Array.isArray(nested)) {
      summary[`${key}Count`] = nested.length;
      included++;
    }
  }
  return Object.keys(summary).length > 0 ? summary : { count: Object.keys(value).length };
}


export function compactCronMetadataForPersistence(
  metadata: string | null | undefined,
  preparsed?: Record<string, unknown> | null,
  job?: string,
): CompactedCronMetadata {
  if (!metadata) return { metadata: null, originalBytes: 0, persistedBytes: 0, compacted: false };
  const budgetBytes = getCronMetadataBudgetBytes(job);
  const originalBytes = utf8Bytes(metadata);
  if (originalBytes <= budgetBytes) {
    return { metadata, originalBytes, persistedBytes: originalBytes, compacted: false };
  }
  const parsed = preparsed !== undefined ? preparsed : parseJsonObject(metadata);
  const entries = parsed ? Object.entries(parsed) : [];
  const retained: Record<string, unknown> = { ...(parsed ?? {}) };
  if (!parsed) retained.reason = "cron-metadata-invalid-json";
  const diagnostics: Record<string, unknown> = {};
  const compaction = {
    schemaVersion: 2, budgetBytes, originalBytes, originalTopLevelKeys: entries.length,
    retainedTopLevelDiagnostics: 0, omittedTopLevelDiagnostics: 0, overBudget: false,
  };
  retained.persistenceCompaction = compaction;
  let compacted: string;

  // First reduce only named diagnostics, leaving every other field and shape untouched.
  for (const key of BULKY_DIAGNOSTIC_KEYS) {
    if (!(key in retained)) continue;
    retained[key] = summarizeDiagnostic(retained[key]);
  }
  // The fallback producer repeats its diagnostics inside `enrichment`; that copy is
  // not a consumer contract and must not force the consumer-key pass.
  const enrichment = retained.enrichment;
  if (enrichment && typeof enrichment === "object" && !Array.isArray(enrichment)) {
    const nested = { ...(enrichment as Record<string, unknown>) };
    for (const key of BULKY_DIAGNOSTIC_KEYS) {
      if (!(key in nested)) continue;
      nested[key] = summarizeDiagnostic(nested[key]);
    }
    retained.enrichment = nested;
  }
  compacted = JSON.stringify(retained);
  if (utf8Bytes(compacted) > budgetBytes) {
    // Preserve complete consumer contracts at their original paths. Unread forensic
    // collections and oversized strings move into the existing diagnostics envelope.
    for (const [key, value] of entries) {
      if (CONSUMER_METADATA_KEYS[key] || key.startsWith("mxLedger")
        || key.startsWith("scheduler") || key === "childDisposition") continue;
      if (value == null || typeof value === "number" || typeof value === "boolean"
        || (typeof value === "string" && value.length <= MAX_DIAGNOSTIC_STRING_CHARS)) continue;
      const summary = summarizeDiagnostic(value);
      if (summary !== undefined) diagnostics[key] = summary;
      delete retained[key];
    }
    retained.diagnostics = diagnostics;
    compaction.retainedTopLevelDiagnostics = Object.keys(diagnostics).length;
    compacted = JSON.stringify(retained);
  }
  // Trim diagnostics only, largest first. Never discard consumer evidence to make
  // an oversized row appear valid, and never silently truncate a stale cohort.
  for (const key of Object.keys(diagnostics).sort((a, b) =>
    utf8Bytes(JSON.stringify(diagnostics[b])) - utf8Bytes(JSON.stringify(diagnostics[a])))) {
    if (utf8Bytes(compacted) <= budgetBytes) break;
    delete diagnostics[key];
    compaction.retainedTopLevelDiagnostics--;
    compaction.omittedTopLevelDiagnostics++;
    compacted = JSON.stringify(retained);
  }
  if (utf8Bytes(compacted) > budgetBytes) {
    // Terminal accounting must survive even when contractual evidence alone exceeds policy.
    // Keep every consumer key and expose the exception instead of failing the terminal write.
    compaction.overBudget = true;
    compacted = JSON.stringify(retained);
    console.warn("[cron-metadata] Consumer evidence exceeds persistence budget", {
      job: job ?? "default", budgetBytes, persistedBytes: utf8Bytes(compacted),
    });
  }
  return { metadata: compacted, originalBytes, persistedBytes: utf8Bytes(compacted), compacted: true };
}
