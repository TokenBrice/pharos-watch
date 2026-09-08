import type { DatabaseSync } from "node:sqlite";

export function seedOpenEvent(sqlite: DatabaseSync, overrides: Record<string, string | number | null> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
    direction: "below", peak_deviation_bps: -200, started_at: now - 3600,
    start_price: 0.98, peak_price: 0.98, peg_reference: 1, source: "live",
    ...overrides,
  };
  sqlite.prepare(`INSERT INTO depeg_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}

export function seedDexEvidence(sqlite: DatabaseSync, price: number, sources: Array<{ protocol: string; price: number; tvl: number }>) {
  sqlite.prepare(`INSERT INTO dex_prices (stablecoin_id, symbol, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json) VALUES (?, 'USDT', ?, 0, ?, ?, ?, ?)`).run(
    "usdt-tether", price, sources.length, sources.reduce((sum, source) => sum + source.tvl, 0), Math.floor(Date.now() / 1000) - 60,
    JSON.stringify(sources.map((source) => ({ ...source, sourceFamily: source.protocol, chain: "ethereum" }))),
  );
}
