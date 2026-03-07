import type { DepegEvent } from "@shared/types";

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

export async function loadDexPriceMap(db: D1Database): Promise<Map<string, number>> {
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number }>();
    return new Map((dexResult.results ?? []).map((row) => [row.stablecoin_id, row.dex_price_usd]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading dex_prices:", msg);
    }
    return new Map<string, number>();
  }
}

export function buildInsertDepegEventStmt(
  db: D1Database,
  event: DepegEvent,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
    )
    .bind(
      event.stablecoinId,
      event.symbol,
      event.pegType,
      event.direction,
      event.peakDeviationBps,
      event.startedAt,
      event.startPrice,
      event.peakPrice ?? event.startPrice,
      event.pegReference,
    );
}

const VALID_DIRECTIONS = new Set(["above", "below"]);
const VALID_SOURCES = new Set(["live", "backfill"]);

/** Convert a snake_case D1 row to a camelCase DepegEvent */
export function rowToDepegEvent(row: DepegRow): DepegEvent {
  if (!VALID_DIRECTIONS.has(row.direction)) {
    console.warn(`[depeg-helpers] Invalid direction "${row.direction}" for event ${row.id}, defaulting to "below"`);
  }
  if (!VALID_SOURCES.has(row.source)) {
    console.warn(`[depeg-helpers] Invalid source "${row.source}" for event ${row.id}, defaulting to "live"`);
  }
  return {
    id: row.id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    pegType: row.peg_type,
    direction: VALID_DIRECTIONS.has(row.direction) ? row.direction as "above" | "below" : "below",
    peakDeviationBps: row.peak_deviation_bps,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startPrice: row.start_price,
    peakPrice: row.peak_price,
    recoveryPrice: row.recovery_price,
    pegReference: row.peg_reference,
    source: VALID_SOURCES.has(row.source) ? row.source as "live" | "backfill" : "live",
  };
}
