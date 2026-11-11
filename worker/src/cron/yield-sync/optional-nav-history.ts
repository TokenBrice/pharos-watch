import { DAY_SECONDS } from "@shared/lib/time-constants";
import { OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";

type OracleAnchorRow = { exchange_rate: number; recorded_at: number; source_observed_at?: number | null };

async function loadNavOracleAnchorRow(
  db: D1Database,
  stablecoinId: string,
  sourceKey: string,
  startSec: number,
  minAgeDays: number,
  maxAgeDays: number,
  useObservationClock = false,
): Promise<OracleAnchorRow | null> {
  const newestAllowed = startSec - minAgeDays * DAY_SECONDS;
  const oldestAllowed = startSec - maxAgeDays * DAY_SECONDS;
  const rawRow = await db
    .prepare(
      useObservationClock
        ? `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor */
         exchange_rate, recorded_at, source_observed_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND source_observed_at <= ?
         AND source_observed_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY source_observed_at DESC LIMIT 1`
        : `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor */
         exchange_rate, recorded_at, source_observed_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
  if (rawRow) return rawRow;

  // Raw history keeps `YIELD_HISTORY_RAW_DAYS` (30) while these NAV-oracle
  // anchors allow a lookback of up to 45 days. `maxAgeDays` is a floor, not a
  // requirement — the query takes the newest row past the min-age bound, which
  // for Midas is normally ~7 days old and comfortably inside raw retention — so
  // this fallback only matters when the newest qualifying observation sits
  // outside the raw window (a publication gap longer than the raw policy). It
  // exists because Midas has no shorter-window retry (Ondo retries at 3/14
  // days), so without it such a gap would stop the source resolving silently
  // rather than degrading. `yield_history_daily` keeps a year and carries the
  // same `exchange_rate`/`publication_state` columns.
  return db
    .prepare(
      useObservationClock
        ? `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor-daily */
         exchange_rate, recorded_at, source_observed_at FROM yield_history_daily
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND source_observed_at <= ?
         AND source_observed_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY source_observed_at DESC LIMIT 1`
        : `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor-daily */
         exchange_rate, recorded_at, source_observed_at FROM yield_history_daily
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
}

export async function loadOndoOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  const preferredPriorRow = await loadNavOracleAnchorRow(
    db,
    OPTIONAL_YIELD_SOURCES.ondo.stablecoinId,
    OPTIONAL_YIELD_SOURCES.ondo.sourceKey,
    startSec,
    7,
    45,
  );
  if (preferredPriorRow) return preferredPriorRow;

  return loadNavOracleAnchorRow(db, OPTIONAL_YIELD_SOURCES.ondo.stablecoinId, OPTIONAL_YIELD_SOURCES.ondo.sourceKey, startSec, 3, 14);
}

export async function loadMidasMmevOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  return loadNavOracleAnchorRow(db, OPTIONAL_YIELD_SOURCES.midas.stablecoinId, OPTIONAL_YIELD_SOURCES.midas.sourceKey, startSec, 7, 45, true);
}
