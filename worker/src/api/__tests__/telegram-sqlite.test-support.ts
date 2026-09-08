import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1, type SqliteD1Options } from "../../test-helpers/sqlite-d1";

export function createCacheSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  return { sqlite, db: createSqliteD1(sqlite) };
}

export function createMiniAppSqlite(options: SqliteD1Options = {}) {
  const fixture = createLatestSchemaSqlite(options);
  fixture.sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, username, created_at, last_active_at) VALUES ('42', 'alice', 1800000000, 1800000000)").run();
  fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, 1800000000)").run(JSON.stringify({ peggedAssets: [
    { id: "usdt-tether", symbol: "USDT", name: "Tether", circulating: { peggedUSD: 2000000000 } },
    { id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 1000000000 } },
  ] }));
  return fixture;
}
