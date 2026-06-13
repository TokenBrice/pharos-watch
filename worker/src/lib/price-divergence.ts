import { BPS_PER_UNIT } from "@shared/lib/math";

export function midDivergenceBps(left: number, right: number): number {
  const mid = (left + right) / 2;
  if (!Number.isFinite(mid) || mid <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const divergence = (Math.abs(left - right) / mid) * BPS_PER_UNIT;
  return Number.isFinite(divergence) ? divergence : Number.POSITIVE_INFINITY;
}

export function pricesAgreeWithinBps(left: number, right: number, thresholdBps: number): boolean {
  return midDivergenceBps(left, right) <= thresholdBps;
}
