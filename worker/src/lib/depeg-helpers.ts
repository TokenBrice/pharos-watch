import type { DepegEvent } from "../../../src/lib/types";

/** D1 row shape for the depeg_events table (snake_case columns) */
export interface DepegRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
}

/** Convert a snake_case D1 row to a camelCase DepegEvent */
export function rowToDepegEvent(row: DepegRow): DepegEvent {
  return {
    id: row.id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    pegType: row.peg_type,
    direction: row.direction as "above" | "below",
    peakDeviationBps: row.peak_deviation_bps,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startPrice: row.start_price,
    peakPrice: row.peak_price,
    recoveryPrice: row.recovery_price,
    pegReference: row.peg_reference,
    source: row.source as "live" | "backfill",
  };
}
