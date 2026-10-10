import type { DatabaseSync } from "node:sqlite";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { PsiSupplyRow } from "../../lib/psi-recompute";
import type { PsiHistoricalDewsRow } from "../../lib/psi-replay";
import type { DepegRow } from "../../lib/depeg-helpers";

export function seedPsiSupply(sqlite: DatabaseSync, rows: PsiSupplyRow[]) {
  const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)");
  for (const row of rows) insert.run(row.stablecoin_id, row.snapshot_date, row.circulating_usd, row.price ?? null);
}

export function seedPsiDews(sqlite: DatabaseSync, rows: PsiHistoricalDewsRow[]) {
  const insert = sqlite.prepare("INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, '{}')");
  for (const row of rows) insert.run(row.stablecoin_id, row.snapshot_date, row.band === "CALM" ? 0 : 60, row.band);
}

export function seedPsiEvent(sqlite: DatabaseSync, event: DepegRow) {
  sqlite.prepare(`INSERT INTO depeg_events
    (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
     start_price, peak_price, recovery_price, peg_reference, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.stablecoin_id, event.symbol, event.peg_type, event.direction,
      event.peak_deviation_bps, event.started_at, event.ended_at, event.start_price,
      event.peak_price, event.recovery_price, event.peg_reference, event.source);
}

export function seedPsiPairedHistory(sqlite: DatabaseSync, day: number, id = "usdt-tether", mcap = 100e9, price = 0.98) {
  seedPsiSupply(sqlite, [day - 7 * DAY_SECONDS, day].map((snapshot_date) => ({
    stablecoin_id: id, snapshot_date, circulating_usd: mcap, price,
  })));
  seedPsiDews(sqlite, [{ stablecoin_id: id, snapshot_date: day, band: "CALM" }]);
}

export interface StoredPsiReplayDay {
  score: number;
  band: string;
  components: string;
  input_snapshot: string;
  methodology_version: string;
}

export function readPsiDay(sqlite: DatabaseSync, day: number): StoredPsiReplayDay {
  return sqlite.prepare("SELECT score, band, components, input_snapshot, methodology_version FROM stability_index WHERE computed_at = ?")
    .get(day) as unknown as StoredPsiReplayDay;
}
