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
  // edition is published, so a stale cache is the recorded supply failure.
  // `supply-current-unavailable` / `supply-prev-week-baseline` mark a partial
  // core cohort, which every edition since 2026-10-27 records; they stay
  // degraded-source metadata rather than a standing operator condition.
  "stablecoins-cache-stale",
  // Safety Score
  "safety-canonical-snapshot",
  "source-load-failed",
] as const;
