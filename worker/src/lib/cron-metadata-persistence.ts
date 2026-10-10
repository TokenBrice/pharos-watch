import { stripSensitive } from "./safe-error-message";
import { parseJsonObject } from "./json-parse";
import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import { ResourcePressureSchema } from "@shared/types/status/cron";

export const MAX_PERSISTED_CRON_METADATA_BYTES = 64 * 1_024 - 1;
// The scheduled wrapper appends bounded lease and slot identity after a producer returns.
const SCHEDULED_CRON_METADATA_ENRICHMENT_HEADROOM_BYTES = 4 * 1_024;
export const MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES =
  MAX_PERSISTED_CRON_METADATA_BYTES - SCHEDULED_CRON_METADATA_ENRICHMENT_HEADROOM_BYTES;
const MAX_TOP_LEVEL_DIAGNOSTICS = 80;
const MAX_DIAGNOSTIC_STRING_CHARS = 500;
const MAX_NESTED_SCALARS = 24;

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
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function safeParseMetadata(metadata: string): Record<string, unknown> | null {
  return parseJsonObject(metadata);
}
function preserveFreshnessEvidence(parsed: Record<string, unknown> | null): Record<string, unknown> {
  const sources = parsed?.sources;
  const freshness = sources && typeof sources === "object" ? (sources as Record<string, unknown>).freshness : null;
  const source = freshness && typeof freshness === "object" ? freshness as Record<string, unknown> : null;
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata as Record<string, unknown> : parsed;
  if (!Array.isArray(metadata?.stale)) return {};
  const fields = ["laneKey", "cacheKey", "producerJob", "ageSeconds", "publishedAt", "generationId",
    "assessedAt", "thresholdSec", "producerThresholdSec", "endpointThresholdSec", "availabilityThresholdSec", "availabilityImpacting"];
  const stale = metadata.stale.slice(0, 80).map((entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    return Object.fromEntries(fields.flatMap((key) => {
      const value = boundedScalar((entry as Record<string, unknown>)[key]);
      return value === undefined ? [] : [[key, typeof value === "string" ? value.slice(0, 128) : value]];
    }));
  });
  const evidence = { stale, ...(metadata.stale.length > stale.length ? { staleOmitted: metadata.stale.length - stale.length } : {}) };
  const preserved = source ? { sources: { freshness: { ...summarizeDiagnostic(source) as Record<string, unknown>, metadata: evidence } } } : evidence;
  // Keep contractual evidence below half the persistence cap; never omit rows silently.
  while (utf8Bytes(JSON.stringify(preserved)) > 32 * 1_024 && stale.length > 0) {
    stale.pop();
    Object.assign(evidence, { staleOmitted: metadata.stale.length - stale.length });
  }
  return preserved;
}

export function compactCronMetadataForPersistence(
  metadata: string | null | undefined,
  preparsed?: Record<string, unknown> | null,
): CompactedCronMetadata {
  if (!metadata) {
    return { metadata: null, originalBytes: 0, persistedBytes: 0, compacted: false };
  }
  const originalBytes = utf8Bytes(metadata);
  if (originalBytes <= MAX_PERSISTED_CRON_METADATA_BYTES) {
    return { metadata, originalBytes, persistedBytes: originalBytes, compacted: false };
  }

  const parsed = preparsed !== undefined ? preparsed : safeParseMetadata(metadata);
  const diagnostics: Record<string, unknown> = {};
  const entries = parsed ? Object.entries(parsed) : [];
  // Measured-execution ledger chunks must survive compaction as TOP-LEVEL scalars:
  // producer history keeps only top-level scalars (normalizeHistoryMetadata), and the
  // durable activation-gate ledger reads them from there. Each is bounded to <=240 chars
  // and at most a handful of parts, so preserving them cannot re-breach the byte cap.
  const preservedLedgerScalars: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    if (!key.startsWith("mxLedger") && key !== "outputPublishedAt"
      && key !== "schedulerAttemptKey" && key !== "schedulerTerminalSource"
      && key !== "schedulerTerminalToken" && key !== "childDisposition") continue;
    const scalar = boundedScalar(value);
    if (scalar !== undefined) preservedLedgerScalars[key] = scalar;
  }
  // Publication and quality are independent operator contracts, not disposable diagnostics.
  const qualityReasons = getCronQualityReasons(parsed)
    .slice(0, MAX_NESTED_SCALARS)
    .map((reason) => stripSensitive(reason).slice(0, MAX_DIAGNOSTIC_STRING_CHARS));
  const preservedQuality = qualityReasons.length > 0 ? { quality: { reasons: qualityReasons } } : {};
  const pressure = ResourcePressureSchema.safeParse(parsed?.resourcePressure);
  const preservedPressure = pressure.success ? { resourcePressure: pressure.data } : {};
  const preservedFreshness = preserveFreshnessEvidence(parsed);
  for (const [key, value] of entries.slice(0, MAX_TOP_LEVEL_DIAGNOSTICS)) {
    const summary = summarizeDiagnostic(value);
    if (summary !== undefined) diagnostics[key] = summary;
  }
  const reason = typeof parsed?.reason === "string"
    ? stripSensitive(parsed.reason).slice(0, MAX_DIAGNOSTIC_STRING_CHARS)
    : "cron-metadata-over-64-kib";
  const envelope: Record<string, unknown> = {
    reason,
    ...preservedLedgerScalars,
    ...preservedQuality,
    ...preservedPressure,
    ...preservedFreshness,
    persistenceCompaction: {
      schemaVersion: 1,
      originalBytes,
      originalTopLevelKeys: entries.length,
      retainedTopLevelDiagnostics: Object.keys(diagnostics).length,
      omittedTopLevelDiagnostics: Math.max(0, entries.length - Object.keys(diagnostics).length),
    },
    diagnostics,
  };

  let compacted = JSON.stringify(envelope);
  while (utf8Bytes(compacted) > MAX_PERSISTED_CRON_METADATA_BYTES && Object.keys(diagnostics).length > 0) {
    const diagnosticKeys = Object.keys(diagnostics);
    const lastKey = diagnosticKeys[diagnosticKeys.length - 1]!;
    delete diagnostics[lastKey];
    (envelope.persistenceCompaction as Record<string, unknown>).retainedTopLevelDiagnostics =
      Object.keys(diagnostics).length;
    (envelope.persistenceCompaction as Record<string, unknown>).omittedTopLevelDiagnostics =
      Math.max(0, entries.length - Object.keys(diagnostics).length);
    compacted = JSON.stringify(envelope);
  }

  if (utf8Bytes(compacted) > MAX_PERSISTED_CRON_METADATA_BYTES) {
    compacted = JSON.stringify({
      reason: "cron-metadata-over-64-kib",
      ...preservedLedgerScalars,
      ...preservedQuality,
      ...preservedPressure,
      ...preservedFreshness,
      persistenceCompaction: { schemaVersion: 1, originalBytes, diagnosticsDropped: true },
    });
  }
  return {
    metadata: compacted,
    originalBytes,
    persistedBytes: utf8Bytes(compacted),
    compacted: true,
  };
}
