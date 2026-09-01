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

function stringifyWithAdapterLatencyReserved(metadata: Record<string, unknown>): string {
  let serialized = JSON.stringify(metadata);
  if (
    metadata.adapterLatency == null
    || utf8Bytes(serialized) <= MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES
  ) {
    return serialized;
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
  return serialized;
}

export function mergeCronMetadataWithLease(
  cronMetadata: string | null | undefined,
  leaseMeta: Record<string, unknown>,
): string {
  if (!cronMetadata) return JSON.stringify(leaseMeta);
  try {
    const parsed = JSON.parse(cronMetadata) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, ...leaseMeta });
  } catch {
    return `${cronMetadata} | lease=${JSON.stringify(leaseMeta)}`;
  }
}

export function normalizeCronMetadata(
  result: CronResult | null | void,
  extras: Record<string, unknown> = {},
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

  return stringifyWithAdapterLatencyReserved({
    rowsRead: parsed.rowsRead ?? null,
    rowsWritten: parsed.rowsWritten ?? rowsWrittenDefault,
    rowsDropped: parsed.rowsDropped ?? 0,
    sourceCoverage: parsed.sourceCoverage ?? null,
    fallbackMode: parsed.fallbackMode ?? null,
    validationFailures: parsed.validationFailures ?? 0,
    ...parsed,
    ...extras,
  });
}
