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
  // Stablecoins supply. A non-ok cache fails the digest closed before an
  // edition is published, so only these recorded reasons can reach a row.
  "stablecoins-cache-stale",
  "supply-current-unavailable",
  "supply-prev-week-baseline",
  // Safety Score
  "safety-canonical-snapshot",
  "source-load-failed",
] as const;
