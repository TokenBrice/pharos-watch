import { readJsonResponse } from "./api-request-response.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleBackfillDEWS } from "../backfill-dews";
import { handleStressSignals } from "../stress-signals";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

stubCryptoForAuth();

afterEach(() => {
  vi.useRealTimers();
});

describe("DEWS history repair", () => {
  it("prunes the requested history window and the public stress-signals read path stops returning it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 3, 9, 12, 0, 0));

    const sqlite = createLatestSchemaSqlite().sqlite;

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

    const repairResponse = await handleBackfillDEWS({ db, url: makeApiUrl(repairRequest.url), trustedAdmin: true, request: repairRequest });
    const repairBody = (await readJsonResponse(repairResponse, 200)) as { prunedRows: number };
    expect(repairBody.prunedRows).toBe(2);

    const historyResponse = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=90"),
    );
    const historyBody = (await readJsonResponse(historyResponse, 200)) as {
      history: Array<{ date: number }>;
    };
    expect(historyBody.history.map((row) => row.date)).toEqual([1_772_928_000]);

    sqlite.close();
  });
});
