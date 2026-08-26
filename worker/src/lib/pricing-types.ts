import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";

export interface PriceSourceDiagnostics {
  allPrices?: Record<string, number>;
  disagreeSources?: string[];
  observedAtBySource?: Record<string, number | null>;
  observedAtModeBySource?: Record<string, PriceObservedAtMode | null>;
}

interface SelectedPrice {
  price: number;
  source: string;
  selectedSource: string;
  confidence: PriceConfidence;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  syncedAt: number | null;
  consensusSources?: string[];
  agreeSources?: string[];
  diagnostics?: PriceSourceDiagnostics;
}

interface PriceMetadata {
  source: string;
  selectedSource?: string | null;
  confidence: PriceConfidence | null;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
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

export function buildObservedAtModeRecord(
  entries: Array<{ source: string; observedAtMode?: PriceObservedAtMode | null }>,
): Record<string, PriceObservedAtMode | null> {
  const record: Record<string, PriceObservedAtMode | null> = {};
  for (const entry of entries) {
    record[entry.source] = entry.observedAtMode ?? null;
  }
  return record;
}

const OBSERVED_AT_MODE_PRIORITY: Record<PriceObservedAtMode, number> = {
  upstream: 0,
  local_fetch: 1,
  unknown: 2,
};

export function pickConservativeObservedAtMode(
  sourceKeys: string[] | undefined,
  observedAtModeBySource: Record<string, PriceObservedAtMode | null> | undefined,
): PriceObservedAtMode | null {
  if (!sourceKeys || sourceKeys.length === 0 || !observedAtModeBySource) return null;

  let selected: PriceObservedAtMode | null = null;
  for (const sourceKey of sourceKeys) {
    const mode = observedAtModeBySource[sourceKey];
    if (!mode) continue;
    if (!selected || OBSERVED_AT_MODE_PRIORITY[mode] > OBSERVED_AT_MODE_PRIORITY[selected]) {
      selected = mode;
    }
  }
  return selected;
}
