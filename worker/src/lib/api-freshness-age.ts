export const API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC = 60;

export interface FreshnessAge {
  ageSeconds: number;
  futureSkewSeconds: number;
}

/**
 * Measure a producer timestamp without allowing clock skew to become a
 * negative public age. Callers decide how excessive future skew affects their
 * availability/status contract.
 */
export function measureFreshnessAge(
  nowSec: number,
  updatedAtSec: number,
  allowedFutureSkewSec: number,
): FreshnessAge {
  if (!Number.isFinite(nowSec) || !Number.isFinite(updatedAtSec)) {
    throw new TypeError("Freshness timestamps must be finite");
  }
  if (!Number.isFinite(allowedFutureSkewSec) || allowedFutureSkewSec < 0) {
    throw new RangeError("Allowed freshness future skew must be finite and nonnegative");
  }
  const rawAgeSeconds = Math.floor(nowSec) - Math.floor(updatedAtSec);
  return {
    ageSeconds: Math.max(0, rawAgeSeconds),
    futureSkewSeconds: Math.max(0, -rawAgeSeconds),
  };
}
