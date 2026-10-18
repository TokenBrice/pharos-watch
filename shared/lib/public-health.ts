import { getCacheImpactStatus } from "./cache-health";
import { getCircuitScope } from "./circuit-sources";
import type { CacheStatus, CircuitRecord, HealthResponse, StatusHealthValue } from "../types/status";

export type PublicStatusTone = StatusHealthValue;

/** Public mint/burn freshness tolerates one missed critical-lane run; the next half-window is degraded. */
export const MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO = 1.5;

/** Source-wide open circuits required to affect public availability and admin causes. */
export const PUBLIC_CIRCUIT_IMPACT_QUORUM = 3;

/**
 * Public component grace: an age-graded component past its stale band stays
 * `degraded` (last good data still served) until its age reaches this multiple
 * of the stale band, which proves the stale state has persisted for at least one
 * further full stale budget. Only then does the public projection report an
 * outage. The multiple is printed with every age-graded verdict (R3).
 */
export const PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER = 2;

const STATUS_SEVERITY: Record<PublicStatusTone, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export function getStatusSeverity(status: PublicStatusTone): number {
  return STATUS_SEVERITY[status];
}

export function maxPublicStatus(...statuses: PublicStatusTone[]): PublicStatusTone {
  let result: PublicStatusTone = "healthy";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[result]) {
      result = status;
    }
  }
  return result;
}

export function getPublicMintBurnStatus(sync: HealthResponse["mintBurn"]["sync"]): PublicStatusTone {
  if (sync.freshnessStatus == null || sync.criticalLaneHealthy == null) return "degraded";
  if (sync.freshnessStatus === "stale") return "stale";
  if (sync.freshnessStatus === "degraded" || !sync.criticalLaneHealthy || sync.warning != null) {
    return "degraded";
  }
  return "healthy";
}

export function getOverallCacheImpactStatus(caches: Record<string, CacheStatus>): PublicStatusTone {
  let worstStatus: PublicStatusTone = "healthy";

  for (const [key, cache] of Object.entries(caches)) {
    worstStatus = maxPublicStatus(worstStatus, getCacheImpactStatus(cache, key));
    if (worstStatus === "stale") {
      return worstStatus;
    }
  }

  return worstStatus;
}

export function getCircuitImpactStatus(openCircuitCount: number | null): PublicStatusTone {
  return openCircuitCount == null || openCircuitCount >= PUBLIC_CIRCUIT_IMPACT_QUORUM ? "degraded" : "healthy";
}

export function isPublicImpactCircuitKey(key: string): boolean {
  return getCircuitScope(key) === "source-wide";
}

export function countPublicImpactOpenCircuits(circuits: Record<string, CircuitRecord>): number {
  return Object.entries(circuits).filter(([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state === "open")
    .length;
}
