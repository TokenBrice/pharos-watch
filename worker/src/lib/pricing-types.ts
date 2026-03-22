import type { PriceConfidence } from "@shared/types";

export interface PriceSourceDiagnostics {
  allPrices?: Record<string, number>;
  disagreeSources?: string[];
  observedAtBySource?: Record<string, number | null>;
}

export interface PriceMetadata {
  source: string;
  confidence: PriceConfidence | null;
  observedAt: number | null;
  syncedAt: number | null;
  consensusSources?: string[];
  agreeSources?: string[];
  diagnostics?: PriceSourceDiagnostics;
}

export function pickConservativeObservedAt(
  sourceKeys: string[] | undefined,
  observedAtBySource: Record<string, number | null> | undefined,
): number | null {
  if (!sourceKeys || sourceKeys.length === 0 || !observedAtBySource) return null;
  const timestamps = sourceKeys
    .map((source) => observedAtBySource[source])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return Math.min(...timestamps);
}

export function buildObservedAtRecord(
  entries: Array<{ source: string; observedAt?: number | null }>,
): Record<string, number | null> {
  const record: Record<string, number | null> = {};
  for (const entry of entries) {
    record[entry.source] =
      typeof entry.observedAt === "number" && Number.isFinite(entry.observedAt)
        ? entry.observedAt
        : null;
  }
  return record;
}
