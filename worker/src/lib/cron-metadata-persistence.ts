import { stripSensitive } from "./safe-error-message";
import { parseJsonObject } from "./json-parse";

export const MAX_PERSISTED_CRON_METADATA_BYTES = 64 * 1_024 - 1;
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

export function compactCronMetadataForPersistence(
  metadata: string | null | undefined,
): CompactedCronMetadata {
  if (!metadata) {
    return { metadata: null, originalBytes: 0, persistedBytes: 0, compacted: false };
  }
  const originalBytes = utf8Bytes(metadata);
  if (originalBytes <= MAX_PERSISTED_CRON_METADATA_BYTES) {
    return { metadata, originalBytes, persistedBytes: originalBytes, compacted: false };
  }

  const parsed = safeParseMetadata(metadata);
  const diagnostics: Record<string, unknown> = {};
  const entries = parsed ? Object.entries(parsed) : [];
  for (const [key, value] of entries.slice(0, MAX_TOP_LEVEL_DIAGNOSTICS)) {
    const summary = summarizeDiagnostic(value);
    if (summary !== undefined) diagnostics[key] = summary;
  }
  const reason = typeof parsed?.reason === "string"
    ? stripSensitive(parsed.reason).slice(0, MAX_DIAGNOSTIC_STRING_CHARS)
    : "cron-metadata-over-64-kib";
  const envelope: Record<string, unknown> = {
    reason,
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
