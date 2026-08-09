import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  recordTelegramChatCommandFlood,
  TELEGRAM_CHAT_FLOOD_UPSERT_SQL,
} from "../telegram-store/processed-updates";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function executeInWorker(path: string, binds: unknown[]): Promise<{ value: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        const sqlite = new DatabaseSync(workerData.path, { timeout: 5_000 });
        try {
          const row = sqlite.prepare(workerData.sql).get(...workerData.binds);
          sqlite.close();
          parentPort.postMessage(row);
        } catch (error) {
          sqlite.close();
          throw error;
        }
      `,
      {
        eval: true,
        workerData: { path, sql: TELEGRAM_CHAT_FLOOD_UPSERT_SQL, binds },
      },
    );
    worker.once("message", (row) => resolve(row as { value: string }));
    worker.once("error", reject);
  });
}

describe("recordTelegramChatCommandFlood", () => {
  it("does not lose increments across concurrent SQLite writers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-telegram-flood-"));
    const path = join(directory, "flood.sqlite");
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const rows = await Promise.all(
        Array.from({ length: 16 }, () =>
          executeInWorker(path, ["telegram:command-flood:123", 1_700_000_000, 1_699_999_940, 1_699_999_940]),
        ),
      );

      const row = sqlite
        .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get("telegram:command-flood:123") as { value: string; updated_at: number };
      expect(row).toEqual({ value: "16", updated_at: 1_700_000_000 });
      expect(rows.map((result) => Number(result.value)).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the window one second before expiry", async () => {
    const { sqlite, db } = createHarness();
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("telegram:command-flood:123", "20", 1_699_999_941);

    const result = await recordTelegramChatCommandFlood(db, {
      chatId: "123",
      nowSec: 1_700_000_000,
      windowSec: 60,
      limit: 20,
    });

    expect(result).toEqual({ allowed: false, firstExceeded: true });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").get()).toEqual({
      value: "21",
      updated_at: 1_699_999_941,
    });
  });

  it("rotates the window exactly at expiry", async () => {
    const { sqlite, db } = createHarness();
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("telegram:command-flood:123", "20", 1_699_999_940);

    const result = await recordTelegramChatCommandFlood(db, {
      chatId: "123",
      nowSec: 1_700_000_000,
      windowSec: 60,
      limit: 20,
    });

    expect(result).toEqual({ allowed: true, firstExceeded: false });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").get()).toEqual({
      value: "1",
      updated_at: 1_700_000_000,
    });
  });
});
