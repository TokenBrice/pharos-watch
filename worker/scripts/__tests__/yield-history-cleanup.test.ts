import { runOperatorCli } from "./operator-cli.test-support";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { LEGACY_BEST_YIELD_SOURCE_KEY } from "../../src/lib/yield-history-ownership-handoffs";
import {
  createYieldHistoryCleanupArtifact,
  deleteCleanupRowsFromSqlite,
  loadCleanupRowsFromSqlite,
  parseYieldHistoryCleanupCliOptions,
  restoreCleanupRowsToSqlite,
  runYieldHistoryCleanupCli,
  summarizeYieldHistoryCleanupRows,
} from "../yield-history-cleanup";
import { createWorkerD1Client } from "../lib/remote-d1";
import type * as RemoteD1Module from "../lib/remote-d1";
import type { RemoteD1Client } from "../lib/remote-d1";

vi.mock("../lib/remote-d1", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteD1Module>()),
  createWorkerD1Client: vi.fn(),
}));

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yield-history-cleanup-test-"));
  return join(dir, "test.sqlite");
}

function seedDb(path: string): void {
  // The drill runs against the real migrated schema: a column that leaves the
  // migration (or the export list) breaks the round-trip instead of silently
  // losing data. Every exported column is non-NULL in at least one targeted row.
  const db = createLatestSchemaSqlite().sqlite;
  try {
    const insert = db.prepare(`
      INSERT INTO yield_history (
        stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward,
        exchange_rate, source_tvl_usd, data_source, warning_signals, yield_source, yield_type,
        publication_generation_id, publication_state, pys_at_publish, safety_at_publish,
        variance_at_publish, pys_inputs_at_publish
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run("usde-ethena", "66985a81-9c51-46ca-9977-42b4fe7bc6df", 1_700_000_360, 0, 5.2, null, null, 1.0001, 10_100_000, "defillama", null, "Ethena staking (sUSDe)", "nav-appreciation", "gen-usde-2", "published", 55.3, 90.2, 0.013, '{"apy30d":5.2}');
    insert.run("usde-ethena", LEGACY_BEST_YIELD_SOURCE_KEY, 1_700_000_000, 1, 5.1, 4.9, 0.2, 1.0, 10_000_000, "defillama", '["reward-heavy"]', "Ethena staking (sUSDe)", "nav-appreciation", "gen-usde-1", "published", 55.2, 90.1, 0.012, '{"apy30d":5.1}');
    insert.run("usds-sky", "d8c4eff5-c8a9-46fc-a888-057c4c668e72", 1_700_000_720, 0, 4.0, null, null, null, 8_000_000, "defillama", null, "Sky Savings Rate (sUSDS)", "lending-vault", "gen-usds-1", "published", 41.5, 88.4, 0.014, '{"apy30d":4.0}');
    insert.run("susde-ethena", "onchain:susde-ethena", 1_700_001_080, 1, 5.3, null, null, null, 10_200_000, "onchain", null, "Ethena staking (sUSDe)", "nav-appreciation", "gen-susde-1", "published", 56.1, 91.0, 0.015, '{"apy30d":5.3}');
    insert.run("usde-ethena", "unrelated-pool", 1_700_001_440, 0, 2.0, null, null, null, 100, "defillama", null, "Unrelated lending", "lending", "gen-usde-3", "failed", 12.3, 70.0, 0.02, '{"apy30d":2.0}');

    const insertDaily = db.prepare(`
      INSERT INTO yield_history_daily (
        stablecoin_id, source_key, snapshot_date, recorded_at, is_best, apy, apy_base, apy_reward,
        exchange_rate, source_tvl_usd, data_source, warning_signals, yield_source, yield_type,
        publication_generation_id, publication_state, pys_at_publish, safety_at_publish,
        variance_at_publish, pys_inputs_at_publish
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertDaily.run("usde-ethena", "66985a81-9c51-46ca-9977-42b4fe7bc6df", 1_699_968_000, 1_700_000_000, 1, 5.1, 4.9, 0.2, 1.0, 10_000_000, "defillama", null, "Ethena staking (sUSDe)", "nav-appreciation", "gen-usde-1", "published", 55.2, 90.1, 0.012, '{"apy30d":5.1}');
    insertDaily.run("susde-ethena", "onchain:susde-ethena", 1_699_968_000, 1_700_001_080, 1, 5.3, null, null, null, 10_200_000, "onchain", null, "Ethena staking (sUSDe)", "nav-appreciation", "gen-susde-1", "published", 56.1, 91.0, 0.015, '{"apy30d":5.3}');

    writeFileSync(path, db.serialize());
  } finally {
    db.close();
  }
}

function readAllRows(path: string, table: "yield_history" | "yield_history_daily" = "yield_history") {
  const db = new DatabaseSync(path);
  try {
    const lastOrderingColumn = table === "yield_history" ? "recorded_at" : "snapshot_date";
    return db.prepare(`SELECT * FROM ${table} ORDER BY stablecoin_id, source_key, ${lastOrderingColumn}`).all();
  } finally {
    db.close();
  }
}

const tempPaths: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const path of tempPaths.splice(0)) {
    rmSync(path.replace(/\/test\.sqlite$/, ""), { recursive: true, force: true });
  }
});

describe("yield-history-cleanup", () => {
  it.each([
    { pause: false, leaseDelta: -1 },
    { pause: true, leaseDelta: 0 },
    { pause: true, leaseDelta: 1 },
    { pause: true, leaseDelta: -1 },
  ])("enforces Wrangler pause=$pause and lease delta=$leaseDelta for cleanup and restore", async ({ pause, leaseDelta }) => {
    const now = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const path = createTempDbPath();
    tempPaths.push(path);
    seedDb(path);
    const before = readAllRows(path);
    const artifact = createYieldHistoryCleanupArtifact(loadCleanupRowsFromSqlite(path), "ops");
    const restorePath = path.replace("test.sqlite", "restore.json");
    writeFileSync(restorePath, JSON.stringify(artifact));
    const sqlite = new DatabaseSync(path);
    try {
      // cache and cron_leases already exist with the migrated schemas; the
      // test only needs the columns the script's guarded queries touch.
      if (pause) sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
        "yield-history-cleanup:writer-pause", JSON.stringify({ reason: "cleanup", pausedAt: now, operator: "ops" }), now,
      );
      sqlite
        .prepare("INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at) VALUES ('sync-yield-data', 'test', ?, ?, ?)")
        .run(now + leaseDelta, now, now);
      vi.mocked(createWorkerD1Client).mockReturnValue({
        query: (sql: string) => sqlite.prepare(sql).all(),
        executeStatements: (statements: string[]) => { for (const sql of statements) sqlite.exec(sql); },
        queryRaw: () => "[]",
      } as RemoteD1Client);
      const args = ["--execute", "--confirm", "yield-history-cleanup"];
      const dependencies = { printJson: vi.fn() };
      if (!pause || leaseDelta >= 0) {
        const reason = pause ? /lease is active/ : /pause guard is not armed/;
        await expect(runYieldHistoryCleanupCli(args, dependencies)).rejects.toThrow(reason);
        expect(readAllRows(path)).toEqual(before);
        await expect(runYieldHistoryCleanupCli([...args, "--restore", restorePath], dependencies)).rejects.toThrow(reason);
        expect(readAllRows(path)).toEqual(before);
      } else {
        await runYieldHistoryCleanupCli(args, dependencies);
        expect(readAllRows(path)).toEqual(before.filter((row) =>
          row.stablecoin_id === "susde-ethena" || row.source_key === "unrelated-pool"));
        await runYieldHistoryCleanupCli([...args, "--restore", restorePath], dependencies);
        expect(readAllRows(path)).toEqual(before);
      }
    } finally {
      sqlite.close();
    }
  });

  it("parses destructive mode through the shared guard with remote dry-run as the default", () => {
    const options = parseYieldHistoryCleanupCliOptions(["--export", "cleanup.json", "--operator", "ops"]);

    expect(options).toMatchObject({
      help: false,
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

  it("keeps writer-pause changes in dry-run mode without live confirmation", async () => {
    const setWriterPause = vi.fn();
    const clearWriterPause = vi.fn();
    const printJson = vi.fn();
    const dependencies = { setWriterPause, clearWriterPause, printJson };

    await runYieldHistoryCleanupCli(["--arm-writer-pause", "--operator", "ops"], dependencies);
    await runYieldHistoryCleanupCli(["--clear-writer-pause"], dependencies);

    expect(setWriterPause).not.toHaveBeenCalled();
    expect(clearWriterPause).not.toHaveBeenCalled();
    expect(printJson).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "arm-writer-pause",
      mode: "dry-run",
      operator: "ops",
      remote: true,
    }));
    expect(printJson).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "clear-writer-pause",
      mode: "dry-run",
      remote: true,
    }));
  });

  it("executes writer-pause changes only in confirmed live mode", async () => {
    const setWriterPause = vi.fn();
    const clearWriterPause = vi.fn();
    const printJson = vi.fn();
    const dependencies = { setWriterPause, clearWriterPause, printJson };
    const liveArgs = ["--execute", "--confirm", "yield-history-cleanup"];

    await runYieldHistoryCleanupCli(["--arm-writer-pause", "--operator", "ops", ...liveArgs], dependencies);
    await runYieldHistoryCleanupCli(["--clear-writer-pause", ...liveArgs], dependencies);

    expect(setWriterPause).toHaveBeenCalledOnce();
    expect(setWriterPause).toHaveBeenCalledWith(true, "ops");
    expect(clearWriterPause).toHaveBeenCalledOnce();
    expect(clearWriterPause).toHaveBeenCalledWith(true);
    expect(printJson).toHaveBeenNthCalledWith(1, expect.objectContaining({ armed: true, remote: true }));
    expect(printJson).toHaveBeenNthCalledWith(2, expect.objectContaining({ cleared: true, remote: true }));
  });

  it("[entrypoint integration] prints direct-run guard refusals without an unhandled rejection", async () => {
    const result = await runOperatorCli(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["worker/scripts/yield-history-cleanup.ts", "--execute"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "yield-history-cleanup: Refusing yield-history-cleanup: live mutation requires --execute --confirm yield-history-cleanup",
    );
    expect(result.stderr).toContain("Usage: tsx worker/scripts/yield-history-cleanup.ts");
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection|unhandled rejection/i);
  });

  it("[entrypoint integration] prints direct-run help with exit 0", async () => {
    const result = await runOperatorCli(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["worker/scripts/yield-history-cleanup.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: tsx worker/scripts/yield-history-cleanup.ts");
    expect(result.stderr).toBe("");
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

  it("rejects value-taking cleanup flags when their value is missing", () => {
    expect(() =>
      parseYieldHistoryCleanupCliOptions([
        "--sqlite",
        "test.sqlite",
        "--restore",
        "--execute",
        "--confirm",
        "yield-history-cleanup",
      ]),
    ).toThrow(/--restore[\s\S]*(?:ambiguous|missing)/);

    expect(() => parseYieldHistoryCleanupCliOptions(["--sqlite", "--export"])).toThrow(
      /--sqlite[\s\S]*(?:ambiguous|missing)/,
    );
    expect(() => parseYieldHistoryCleanupCliOptions(["--export="])).toThrow(
      "--export requires a non-empty value",
    );
  });

  it("rejects unknown, duplicate, conflicting, and positional arguments", () => {
    expect(() => parseYieldHistoryCleanupCliOptions(["--bogus"])).toThrow(/Unknown option/);
    expect(() =>
      parseYieldHistoryCleanupCliOptions(["--operator", "one", "--operator", "two"]),
    ).toThrow(/may only be specified once/);
    expect(() =>
      parseYieldHistoryCleanupCliOptions(["--arm-writer-pause", "--clear-writer-pause"]),
    ).toThrow(/cannot be used together/);
    expect(() =>
      parseYieldHistoryCleanupCliOptions(["--restore", "backup.json", "--export", "new.json"]),
    ).toThrow(/cannot be used together/);
    expect(() =>
      parseYieldHistoryCleanupCliOptions(["--sqlite", "test.sqlite", "--arm-writer-pause"]),
    ).toThrow(/cannot be used together/);
    expect(() => parseYieldHistoryCleanupCliOptions(["unexpected"])).toThrow(/Unexpected argument/);
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

    const entireTable = readAllRows(path);
    const survivors = entireTable.filter((row) => row.stablecoin_id === "susde-ethena" || row.source_key === "unrelated-pool");
    const entireDailyTable = readAllRows(path, "yield_history_daily");
    const beforeRows = loadCleanupRowsFromSqlite(path);
    const artifact = createYieldHistoryCleanupArtifact(beforeRows, "test-operator");

    deleteCleanupRowsFromSqlite(path);
    expect(readAllRows(path)).toEqual(survivors);
    expect(readAllRows(path, "yield_history_daily")).toEqual(
      entireDailyTable.filter((row) => row.stablecoin_id === "susde-ethena"),
    );

    restoreCleanupRowsToSqlite(path, artifact.rows);
    expect(readAllRows(path)).toEqual(entireTable);
    expect(artifact.rowCount).toBe(beforeRows.length);
    expect(artifact.operator).toBe("test-operator");
  });
});
