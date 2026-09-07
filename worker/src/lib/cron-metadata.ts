import type { CronResult } from "./cron-logger";
import { MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES } from "./cron-metadata-persistence";

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compactDiagnostic(value: unknown, originalBytes: number): Record<string, unknown> {
  return {
    metadataCompacted: true,
    originalBytes,
    ...(Array.isArray(value) ? { count: value.length } : {}),
  };
}

function reserveAdapterLatencyByteBudget(metadata: Record<string, unknown>): void {
  let serialized = JSON.stringify(metadata);
  if (
    metadata.adapterLatency == null
    || utf8Bytes(serialized) <= MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES
  ) {
    return;
  }

  const candidates = Object.entries(metadata)
    .filter(([key]) => key !== "adapterLatency" && key !== "adapterLatencyMetadataCompaction")
    .map(([key, value]) => ({ key, value, bytes: utf8Bytes(JSON.stringify(value) ?? "null") }))
    .sort((left, right) => right.bytes - left.bytes || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  let compactedFields = 0;
  for (const candidate of candidates) {
    if (utf8Bytes(serialized) <= MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES) break;
    metadata[candidate.key] = compactDiagnostic(candidate.value, candidate.bytes);
    compactedFields += 1;
    metadata.adapterLatencyMetadataCompaction = {
      schemaVersion: 1,
      compactedFields,
    };
    serialized = JSON.stringify(metadata);
  }
}

/**
 * Normalizes a job's metadata and merges the bounded scheduler/lease identity
 * in one pass: the producer metadata string is decoded once, defaults are
 * applied, the adapter-latency byte reservation compacts oversized diagnostics
 * BEFORE lease enrichment (so lease keys can never be compaction candidates),
 * and the enriched object is serialized once for the persisted result.
 */
export function normalizeCronMetadataWithLease(
  result: CronResult | null | void,
  leaseMeta: Record<string, unknown>,
): string {
  const parsed: Record<string, unknown> = {};
  if (result?.metadata) {
    try {
      Object.assign(parsed, JSON.parse(result.metadata) as Record<string, unknown>);
    } catch {
      parsed.rawMetadata = result.metadata;
    }
  }

  const rowsWrittenDefault = typeof result?.itemCount === "number" ? result.itemCount : null;

  const metadata = {
    rowsRead: parsed.rowsRead ?? null,
    rowsWritten: parsed.rowsWritten ?? rowsWrittenDefault,
    rowsDropped: parsed.rowsDropped ?? 0,
    sourceCoverage: parsed.sourceCoverage ?? null,
    fallbackMode: parsed.fallbackMode ?? null,
    validationFailures: parsed.validationFailures ?? 0,
    ...parsed,
  };
  reserveAdapterLatencyByteBudget(metadata);
  return JSON.stringify({ ...metadata, ...leaseMeta });
}
