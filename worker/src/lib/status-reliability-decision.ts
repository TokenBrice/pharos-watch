import type { StatusHealthValue } from "@shared/types/status/core";

interface StatusHysteresisPolicy {
  escalateToDegraded: number;
  escalateToStale: number;
  recoverToDegraded: number;
  recoverToHealthy: number;
  minDwellSec: number;
  staleMinDwellSec: number;
}

export function decideNextStatus(
  current: StatusHealthValue,
  raw: StatusHealthValue,
  /** `nonHealthy`: consecutive degraded-or-stale readings; defaults to the degraded streak. */
  counters: { healthy: number; degraded: number; stale: number; nonHealthy?: number },
  dwellSec: number,
  policy: StatusHysteresisPolicy,
): { next: StatusHealthValue; changed: boolean; reason: string } {
  if (current !== "stale" && raw === "stale" && counters.stale >= policy.escalateToStale) {
    return { next: "stale", changed: true, reason: "raw-stale-consecutive-threshold" };
  }
  // A stale reading still counts toward degraded, so alternating stale and
  // degraded readings cannot hold a healthy state indefinitely.
  if (current === "healthy" && raw !== "healthy"
    && (counters.nonHealthy ?? counters.degraded) >= policy.escalateToDegraded) {
    return { next: "degraded", changed: true, reason: "raw-degraded-consecutive-threshold" };
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
