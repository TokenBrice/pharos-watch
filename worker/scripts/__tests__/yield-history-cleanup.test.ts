import { runOperatorCli } from "./operator-cli.test-support";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    insert.run("usde-ethena", "unrelated-pool", 1_700_001_440, 0, 2.0, null, null, null, 100, "defillama", null, "Unrelated lending", "lending");
  } finally {
    db.close();
  }
}

function readAllRows(path: string) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT * FROM yield_history ORDER BY stablecoin_id, source_key, recorded_at").all();
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
      sqlite.exec("CREATE TABLE cache (key TEXT, value TEXT, updated_at INTEGER); CREATE TABLE cron_leases (job TEXT, lease_until INTEGER)");
      if (pause) sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
        "yield-history-cleanup:writer-pause", JSON.stringify({ reason: "cleanup", pausedAt: now, operator: "ops" }), now,
      );
      sqlite.prepare("INSERT INTO cron_leases VALUES ('sync-yield-data', ?)").run(now + leaseDelta);
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
    const beforeRows = loadCleanupRowsFromSqlite(path);
    const artifact = createYieldHistoryCleanupArtifact(beforeRows, "test-operator");

    deleteCleanupRowsFromSqlite(path);
    expect(readAllRows(path)).toEqual(survivors);

    restoreCleanupRowsToSqlite(path, artifact.rows);
    expect(readAllRows(path)).toEqual(entireTable);
    expect(artifact.rowCount).toBe(beforeRows.length);
    expect(artifact.operator).toBe("test-operator");
  });
});
