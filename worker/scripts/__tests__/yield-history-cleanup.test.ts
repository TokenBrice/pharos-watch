import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createYieldHistoryCleanupArtifact,
  deleteCleanupRowsFromSqlite,
  loadCleanupRowsFromSqlite,
  parseYieldHistoryCleanupCliOptions,
  restoreCleanupRowsToSqlite,
  summarizeYieldHistoryCleanupRows,
} from "../yield-history-cleanup";

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yield-history-cleanup-test-"));
  return join(dir, "test.sqlite");
}

function seedDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE yield_history (
        stablecoin_id TEXT NOT NULL,
        source_key TEXT,
        recorded_at INTEGER NOT NULL,
        is_best INTEGER NOT NULL DEFAULT 0,
        apy REAL NOT NULL,
        apy_base REAL,
        apy_reward REAL,
        exchange_rate REAL,
        source_tvl_usd REAL,
        data_source TEXT NOT NULL,
        warning_signals TEXT,
        yield_source TEXT,
        yield_type TEXT,
        PRIMARY KEY (stablecoin_id, source_key, recorded_at)
      );
    `);

    const insert = db.prepare(`
      INSERT INTO yield_history (
        stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward,
        exchange_rate, source_tvl_usd, data_source, warning_signals, yield_source, yield_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run("usde-ethena", null, 1_700_000_000, 1, 5.1, null, null, null, 10_000_000, "defillama", null, "Ethena staking (sUSDe)", "nav-appreciation");
    insert.run("usde-ethena", "66985a81-9c51-46ca-9977-42b4fe7bc6df", 1_700_000_360, 0, 5.2, null, null, null, 10_100_000, "defillama", null, "Ethena staking (sUSDe)", "nav-appreciation");
    insert.run("usds-sky", "d8c4eff5-c8a9-46fc-a888-057c4c668e72", 1_700_000_720, 0, 4.0, null, null, null, 8_000_000, "defillama", null, "Sky Savings Rate (sUSDS)", "lending-vault");
    insert.run("susde-ethena", "onchain:susde-ethena", 1_700_001_080, 1, 5.3, null, null, null, 10_200_000, "onchain", null, "Ethena staking (sUSDe)", "nav-appreciation");
  } finally {
    db.close();
  }
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path.replace(/\/test\.sqlite$/, ""), { recursive: true, force: true });
  }
});

describe("yield-history-cleanup", () => {
  it("parses destructive mode through the shared guard with remote dry-run as the default", () => {
    const options = parseYieldHistoryCleanupCliOptions(["--export", "cleanup.json", "--operator", "ops"]);

    expect(options).toMatchObject({
      exportPath: "cleanup.json",
      operator: "ops",
      remote: true,
      execute: false,
      armWriterPause: false,
      clearWriterPause: false,
    });
    expect(options.operationMode).toEqual({
      dryRun: true,
      remote: true,
      targetFlag: "--remote",
    });
  });

  it("accepts the yield-history-cleanup confirmation token for live local D1 mode", () => {
    const options = parseYieldHistoryCleanupCliOptions([
      "--local",
      "--execute",
      "--confirm",
      "yield-history-cleanup",
    ]);

    expect(options).toMatchObject({
      remote: false,
      execute: true,
    });
    expect(options.operationMode).toEqual({
      dryRun: false,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("rejects live mode without the cleanup confirmation token", () => {
    expect(() => parseYieldHistoryCleanupCliOptions(["--execute"])).toThrow(
      "live mutation requires --execute --confirm yield-history-cleanup",
    );
  });

  it("preserves sqlite restore exemption from live confirmation", () => {
    const options = parseYieldHistoryCleanupCliOptions([
      "--sqlite",
      "test.sqlite",
      "--restore",
      "cleanup.json",
      "--execute",
    ]);

    expect(options).toMatchObject({
      sqlitePath: "test.sqlite",
      restorePath: "cleanup.json",
      remote: true,
      execute: false,
    });
    expect(options.operationMode.dryRun).toBe(true);
  });

  it("loads only the targeted parent-owned wrapper rows", () => {
    const path = createTempDbPath();
    tempPaths.push(path);
    seedDb(path);

    const rows = loadCleanupRowsFromSqlite(path);
    const summary = summarizeYieldHistoryCleanupRows(rows);

    expect(summary.totalRows).toBe(3);
    expect(summary.byStablecoin["usde-ethena"]).toBe(2);
    expect(summary.byStablecoin["usds-sky"]).toBe(1);
  });

  it("supports a delete and restore drill", () => {
    const path = createTempDbPath();
    tempPaths.push(path);
    seedDb(path);

    const beforeRows = loadCleanupRowsFromSqlite(path);
    const artifact = createYieldHistoryCleanupArtifact(beforeRows, "test-operator");

    deleteCleanupRowsFromSqlite(path);
    const afterDeleteRows = loadCleanupRowsFromSqlite(path);
    expect(afterDeleteRows).toEqual([]);

    restoreCleanupRowsToSqlite(path, artifact.rows);
    const restoredRows = loadCleanupRowsFromSqlite(path);

    expect(restoredRows).toEqual(beforeRows);
    expect(artifact.rowCount).toBe(beforeRows.length);
    expect(artifact.operator).toBe("test-operator");
  });
});
