type StatusLevel = "healthy" | "degraded" | "stale";

interface StatusHysteresisPolicy {
  escalateToDegraded: number;
  escalateToStale: number;
  recoverToDegraded: number;
  recoverToHealthy: number;
  minDwellSec: number;
  staleMinDwellSec: number;
}

export function decideNextStatus(
  current: StatusLevel,
  raw: StatusLevel,
  counters: { healthy: number; degraded: number; stale: number },
  dwellSec: number,
  policy: StatusHysteresisPolicy,
): { next: StatusLevel; changed: boolean; reason: string } {
  if (current === "healthy" && raw === "stale" && counters.stale >= policy.escalateToStale) {
    return { next: "stale", changed: true, reason: "raw-stale-immediate-escalation" };
  }
  if (current === "healthy" && raw === "degraded" && counters.degraded >= policy.escalateToDegraded) {
    return { next: "degraded", changed: true, reason: "raw-degraded-consecutive-threshold" };
  }
  if (current === "degraded" && raw === "stale" && counters.stale >= 2) {
    return { next: "stale", changed: true, reason: "raw-stale-consecutive-threshold" };
  }
  if (
    current === "degraded" &&
    raw === "healthy" &&
    counters.healthy >= policy.recoverToHealthy &&
    dwellSec >= policy.minDwellSec
  ) {
    return { next: "healthy", changed: true, reason: "raw-healthy-recovery-threshold" };
  }
  if (
    current === "stale" &&
    raw === "degraded" &&
    counters.degraded >= policy.recoverToDegraded &&
    dwellSec >= policy.staleMinDwellSec
  ) {
    return { next: "degraded", changed: true, reason: "raw-degraded-recovery-from-stale" };
  }
  if (
    current === "stale" &&
    raw === "healthy" &&
    counters.healthy >= policy.recoverToHealthy &&
    dwellSec >= policy.staleMinDwellSec
  ) {
    return { next: "healthy", changed: true, reason: "raw-healthy-recovery-from-stale" };
  }
  return { next: current, changed: false, reason: "hysteresis-hold" };
}
