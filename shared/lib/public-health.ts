import { getCacheImpactStatus } from "./cache-health";
import type { CacheStatus, CircuitRecord, HealthResponse } from "../types/status";

export type PublicStatusTone = HealthResponse["status"];

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

export function getPublicMintBurnStatus(
  sync: HealthResponse["mintBurn"]["sync"],
): PublicStatusTone {
  if (sync.freshnessStatus === "stale") return "stale";
  if (sync.freshnessStatus === "degraded" || !sync.criticalLaneHealthy || sync.warning != null) {
    return "degraded";
  }
  return "healthy";
}

export function getOverallCacheImpactStatus(
  caches: Record<string, CacheStatus>,
): PublicStatusTone {
  let worstStatus: PublicStatusTone = "healthy";

  for (const cache of Object.values(caches)) {
    worstStatus = maxPublicStatus(worstStatus, getCacheImpactStatus(cache));
    if (worstStatus === "stale") {
      return worstStatus;
    }
  }

  return worstStatus;
}

export function getCircuitImpactStatus(openCircuitCount: number): PublicStatusTone {
  return openCircuitCount >= 3 ? "degraded" : "healthy";
}

export function isPublicImpactCircuitKey(key: string): boolean {
  if (key.startsWith("live-reserves:")) return false;
  if (key === "dexscreener-search") return false;
  return true;
}

export function countPublicImpactOpenCircuits(
  circuits: Record<string, CircuitRecord>,
): number {
  return Object.entries(circuits).filter(
    ([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state === "open",
  ).length;
}
