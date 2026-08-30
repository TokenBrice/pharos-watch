import { DatabaseSync } from "node:sqlite";
import { DEPEG_PENDING_MIN_AGE_SEC } from "../lib/constants";
import type { PendingDepegRow } from "../lib/depeg-pending";
import { createLatestSchemaSqlite } from "./latest-schema-sqlite";

const NOW_SEC = 1_700_000_000;

export function openLatestSchemaFixture(options: { openDatabases?: DatabaseSync[] } = {}): {
  sqlite: DatabaseSync;
  db: D1Database;
} {
  const fixture = createLatestSchemaSqlite();
  options.openDatabases?.push(fixture.sqlite);
  return fixture;
}

export function makePendingDepegRow(
  overrides: Partial<PendingDepegRow> = {},
  defaults: { firstSeenBps?: number; firstPrice?: number } = {},
): PendingDepegRow {
  const firstSeenAt = overrides.first_seen_at ?? NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60;
  const firstSeenBps = overrides.first_seen_bps ?? defaults.firstSeenBps ?? -200;
  const firstPrice = overrides.first_price ?? defaults.firstPrice ?? 0.98;
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    first_seen_bps: firstSeenBps,
    first_seen_at: firstSeenAt,
    first_price: firstPrice,
    last_seen_bps: firstSeenBps,
    last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC,
    last_price: firstPrice,
    peak_seen_bps: null,
    peak_price: null,
    peg_reference: 1,
    reason: "large-cap",
    updated_at: firstSeenAt,
    ...overrides,
  };
}

export function insertPendingDepeg(sqlite: DatabaseSync, row: PendingDepegRow): void {
  sqlite.prepare(
    `INSERT INTO depeg_pending (
       id, stablecoin_id, symbol, peg_type, direction, first_seen_bps,
       first_seen_at, first_price, peg_reference, reason, last_seen_bps,
       last_seen_at, last_price, peak_seen_bps, peak_price, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.stablecoin_id,
    row.symbol,
    row.peg_type,
    row.direction,
    row.first_seen_bps,
    row.first_seen_at,
    row.first_price,
    row.peg_reference,
    row.reason ?? "large-cap",
    row.last_seen_bps,
    row.last_seen_at,
    row.last_price,
    row.peak_seen_bps,
    row.peak_price,
    row.updated_at ?? row.last_seen_at ?? row.first_seen_at,
  );
}

export function insertDexPrice(
  sqlite: DatabaseSync,
  stablecoinId: string,
  symbol: string,
  price: number,
  sources: Array<{ price: number; tvl: number; protocol: string; sourceFamily: string; chain: string }>,
  updatedAt = NOW_SEC - 30,
): void {
  sqlite.prepare(
    `INSERT INTO dex_prices (
       stablecoin_id, symbol, dex_price_usd, source_pool_count,
       source_total_tvl, deviation_from_primary_bps, primary_price_at_calc,
       price_sources_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stablecoinId,
    symbol,
    price,
    sources.length,
    sources.reduce((total, source) => total + source.tvl, 0),
    0,
    price,
    JSON.stringify(sources),
    updatedAt,
  );
}
