import { describe, expect, it } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillDEWS } from "../backfill-dews";
import { handleStressSignals } from "../stress-signals";

stubCryptoForAuth();

function createSqliteD1(sqlite: import("node:sqlite").DatabaseSync): D1Database {
  const makeStatement = (sql: string, boundValues: unknown[] = []): D1PreparedStatement => ({
    bind: (...args: unknown[]) => makeStatement(sql, args),
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(boundValues as never[])) as T[],
      success: true,
      meta: {},
    }),
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(boundValues as never[])) as T | undefined;
      return row ?? null;
    },
    run: async () => {
      const result = sqlite.prepare(sql).run(...(boundValues as never[]));
      return {
        success: true,
        meta: { changes: Number(result.changes ?? 0) },
      };
    },
  }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStatement(sql),
  } as unknown as D1Database;
}

describe("DEWS history repair", () => {
  it("prunes the requested history window and the public stress-signals read path stops returning it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE stress_signals (
        stablecoin_id TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        score REAL NOT NULL,
        band TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        PRIMARY KEY (stablecoin_id, computed_at)
      );
      CREATE TABLE stress_signal_history (
        stablecoin_id TEXT NOT NULL,
        snapshot_date INTEGER NOT NULL,
        score REAL NOT NULL,
        band TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        PRIMARY KEY (stablecoin_id, snapshot_date)
      );
    `);

    const signalsJson = JSON.stringify({
      supply: { value: 10, available: true },
      price: { value: 5, available: true },
    });
    sqlite.prepare(
      "INSERT INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    ).run("usdt-tether", 1_775_700_000, 25, "WATCH", signalsJson);
    sqlite.prepare(
      "INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    ).run("usdt-tether", 1_772_928_000, 11, "CALM", signalsJson);
    sqlite.prepare(
      "INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    ).run("usdt-tether", 1_773_100_800, 44, "ALERT", signalsJson);
    sqlite.prepare(
      "INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
    ).run("usdt-tether", 1_773_187_200, 52, "ALERT", signalsJson);

    const db = createSqliteD1(sqlite);
    const repairRequest = makeApiRequest(
      "/api/backfill-dews?repair=prune-history&stablecoin=usdt-tether&startDay=2026-03-10&endDay=2026-03-12",
      { adminKey: "secret", method: "POST" },
    );

    const repairResponse = await handleBackfillDEWS(db, makeApiUrl(repairRequest.url), true, repairRequest);
    expect(repairResponse.status).toBe(200);
    const repairBody = (await repairResponse.json()) as { prunedRows: number };
    expect(repairBody.prunedRows).toBe(2);

    const historyResponse = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=90"),
    );
    expect(historyResponse.status).toBe(200);
    const historyBody = (await historyResponse.json()) as {
      history: Array<{ date: number }>;
    };
    expect(historyBody.history.map((row) => row.date)).toEqual([1_772_928_000]);

    sqlite.close();
  });
});
