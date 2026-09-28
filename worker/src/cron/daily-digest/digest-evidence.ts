import type { DigestInputData, DigestNextTrigger } from "@shared/types/digest";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

type Depeg = DigestInputData["topDepegs"][number];

/** Run-local canonical evidence, never the prompt's capped presentation sets. */
export interface DigestEvidence {
  activeDepegs?: Depeg[];
  recoveredDepegs?: NonNullable<DigestInputData["resolvedDepegs"]>;
  dews?: Array<{ stablecoinId: string; symbol: string; band: string }>;
  yields?: Array<{ stablecoinId: string; symbol: string; currentApy: number }>;
  liquidity?: Array<{ stablecoinId: string; symbol: string; currentScore: number }>;
}

export function currentDepegBps(depeg: Depeg, generatedAt?: number): number | null {
  const observedAt = depeg.priceObservedAt;
  if (depeg.severityBasis !== "current" || !Number.isFinite(depeg.currentBps)
    || !(depeg.pegReference != null && depeg.pegReference > 0)
    || observedAt == null || generatedAt == null || observedAt > generatedAt
    || generatedAt - observedAt > API_FRESHNESS_MAX_AGE_SEC.stablecoins) return null;
  return Math.abs(depeg.currentBps!);
}

export function comparableDepegs(current: Depeg, previous: Depeg, data: DigestInputData, previousData: DigestInputData): boolean {
  return current.stablecoinId != null && current.stablecoinId === previous.stablecoinId
    && current.startedAt != null && current.startedAt === previous.startedAt
    && current.pegReference === previous.pegReference
    && current.direction === previous.direction
    && currentDepegBps(current, data.dataQuality?.generatedAt) != null
    && currentDepegBps(previous, previousData.dataQuality?.generatedAt) != null
    && current.priceObservedAt! > previous.priceObservedAt!;
}

/** Never fall back to a colliding symbol when an ID is available. */
export function findTriggerTarget<T extends { stablecoinId?: string; symbol: string }>(rows: readonly T[], trigger: DigestNextTrigger): T | undefined {
  if (trigger.stablecoinId) return rows.find((row) => row.stablecoinId === trigger.stablecoinId);
  const matches = rows.filter((row) => row.symbol.toUpperCase() === trigger.symbol?.toUpperCase());
  return matches.length === 1 ? matches[0] : undefined;
}
