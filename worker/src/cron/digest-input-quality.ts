/**
 * Degraded collector keys that remove a regime-critical family from a
 * published digest. The digest still generates and delivers when one of these
 * collectors fails, recording the key in `inputData.degradedSources`; the
 * publication watchdog uses this reviewed set to turn that silent quality
 * finding into an operator condition.
 *
 * `active-depegs-query`, PSI, supply and Safety are the regime families named
 * by the owner ruling. Keys come from the collectors themselves
 * (`worker/src/cron/daily-digest/collectors-*.ts`, `input.ts`).
 */
export const REGIME_CRITICAL_DIGEST_DEGRADED_SOURCES = [
  // Active depegs
  "active-depegs-query",
  // PSI headline sample and contributor detail
  "psi-unavailable",
  "psi-contributors-query",
  "psi-contributors-stale",
  // Stablecoins supply (the digest fails closed on a non-ok cache)
  "supply-unavailable",
  "missing-cache",
  "json-parse-failed",
  "invalid-payload-shape",
  "missing-pegged-assets",
  "filtered-malformed-entries",
  "published-contract-invalid",
  "cache-read-failed",
  // Safety Score
  "safety-canonical-snapshot",
  "source-load-failed",
] as const;
