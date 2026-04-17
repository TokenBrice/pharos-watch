/**
 * Data loader for the `/status <ticker>` command.
 *
 * Sources:
 * - `stress_signals`          latest DEWS band + score per coin
 * - `safety_grade_history`    latest safety grade per coin
 * - `depeg_events`            only rows with `ended_at IS NULL` (an active event)
 * - `price_cache`             latest cached price by `asset_id = stablecoin_id`
 *
 * Peg math is NOT recomputed here. If a user wants live deviation context on a
 * stable coin, the formatted message links back to the Pharos detail page.
 */

export interface StatusForCoin {
  stablecoinId: string;
  priceUsd: number | null;
  priceUpdatedAt: number | null;
  dews: { band: string; score: number; recordedAt: number } | null;
  safety: { grade: string; score: number | null; recordedAt: number } | null;
  depeg:
    | { status: "stable" }
    | {
        status: "active";
        direction: "above" | "below";
        peakDeviationBps: number;
        pegReference: number;
        startedAt: number;
      };
}

export async function loadStatusForCoin(
  db: D1Database,
  stablecoinId: string,
): Promise<StatusForCoin> {
  const [dewsRow, safetyRow, depegRow, priceRow] = await Promise.all([
    db
      .prepare(
        "SELECT band, score, recorded_at FROM stress_signals WHERE stablecoin_id = ? ORDER BY recorded_at DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ band: string; score: number; recorded_at: number }>(),
    db
      .prepare(
        "SELECT grade, score, recorded_at FROM safety_grade_history WHERE stablecoin_id = ? ORDER BY recorded_at DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ grade: string; score: number | null; recorded_at: number }>(),
    db
      .prepare(
        "SELECT direction, peak_deviation_bps, peg_reference, started_at FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{
        direction: "above" | "below";
        peak_deviation_bps: number;
        peg_reference: number;
        started_at: number;
      }>(),
    db
      .prepare("SELECT price, updated_at FROM price_cache WHERE asset_id = ?")
      .bind(stablecoinId)
      .first<{ price: number; updated_at: number }>(),
  ]);

  return {
    stablecoinId,
    priceUsd: priceRow?.price ?? null,
    priceUpdatedAt: priceRow?.updated_at ?? null,
    dews: dewsRow
      ? { band: dewsRow.band, score: dewsRow.score, recordedAt: dewsRow.recorded_at }
      : null,
    safety: safetyRow
      ? { grade: safetyRow.grade, score: safetyRow.score, recordedAt: safetyRow.recorded_at }
      : null,
    depeg: depegRow
      ? {
          status: "active",
          direction: depegRow.direction,
          peakDeviationBps: depegRow.peak_deviation_bps,
          pegReference: depegRow.peg_reference,
          startedAt: depegRow.started_at,
        }
      : { status: "stable" },
  };
}
