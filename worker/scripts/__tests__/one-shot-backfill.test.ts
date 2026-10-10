import { afterEach, describe, expect, it, vi } from "vitest";
import { runOneShotBackfillCli, ONE_SHOT_BACKFILL_JOBS, ATOMIC_IMPORT_BACKFILL_JOBS } from "../one-shot-backfill";
import { bindBackfillSql, createBackfillDatabase } from "../lib/backfill-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getEndpointDefinition, getStatusPageActions } from "@shared/lib/api-endpoints";
import * as stabilityBackfill from "../backfills/backfill-stability-index";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

function envelope(results: unknown[] = [], changes = 0): string {
  return JSON.stringify([{ success: true, results, meta: { changes, duration: 0 } }]);
}

describe("one-shot backfill operator lane", () => {
  it("removes every migrated job from HTTP routing and the admin action catalog", () => {
    expect(ONE_SHOT_BACKFILL_JOBS).toHaveLength(12);
    for (const job of ONE_SHOT_BACKFILL_JOBS) {
      expect(getEndpointDefinition(`/api/${job}`)).toBeUndefined();
      expect(getStatusPageActions().some((action) => action.path.startsWith(`/api/${job}`))).toBe(false);
    }
    for (const job of ["backfill-dews", "remediate-blacklist-amount-gaps", "trigger-digest", "trigger-yield-coverage-audit", "reset-blacklist-sync"]) {
      expect(getEndpointDefinition(`/api/${job}`)).toBeDefined();
    }
  });

  it("prints help and rejects unsafe/unknown invocations before any D1 access", async () => {
    const client = { queryRaw: vi.fn(), executeStatementsRaw: vi.fn() };
    const write = vi.fn();
    await runOneShotBackfillCli(["--help"], { client, write });
    expect(write.mock.calls[0]![0]).toContain("default remote");
    for (const args of [[], ["unknown", "--execute"], ["backfill-supply-history"],
      ["backfill-supply-history", "--query", "dry-run=true"], ["backfill-depegs", "--query", "dryRun=true"],
      ["bootstrap-jltxx-reserves", "--execute"], ["backfill-depegs", "--execute", "--bogus"]]) {
      await expect(runOneShotBackfillCli(args, { client, write })).rejects.toThrow();
    }
    expect(client.queryRaw).not.toHaveBeenCalled();
    expect(client.executeStatementsRaw).not.toHaveBeenCalled();
  });

  it("requires explicit availability consent for each atomic job before any D1 access", async () => {
    const client = { queryRaw: vi.fn(), executeStatementsRaw: vi.fn() };
    for (const job of ATOMIC_IMPORT_BACKFILL_JOBS) {
      await expect(runOneShotBackfillCli([job, "--execute"], { client })).rejects.toThrow("--allow-atomic-import");
    }
    for (const argv of [
      ["backfill-supply-history", "--execute", "--allow-atomic-import"],
      ["backfill-depegs", "--query", "dry-run=true", "--allow-atomic-import"],
    ]) {
      await expect(runOneShotBackfillCli(argv, { client })).rejects.toThrow("only supported");
    }
    expect(client.queryRaw).not.toHaveBeenCalled();
    expect(client.executeStatementsRaw).not.toHaveBeenCalled();
  });

  it.each(["backfill-supply-history", "backfill-depegs", "backfill-cg-prices", "backfill-yield-history"])(
    "preserves the exact existing out-of-range no-op response bytes for %s", async (job) => {
      const client = { queryRaw: vi.fn(), executeStatementsRaw: vi.fn() };
      const write = vi.fn();
      await runOneShotBackfillCli([job, "--execute", ...(job === "backfill-depegs" ? ["--allow-atomic-import"] : []),
        "--query", "batch=999999"], { client, write, env: {} });
      expect(write).toHaveBeenCalledWith('{"message":"No coins in this batch"}\n');
      expect(client.queryRaw).not.toHaveBeenCalled();
    },
  );

  it("preserves error response bytes and fails the CLI without swallowing the job status", async () => {
    const write = vi.fn();
    await expect(runOneShotBackfillCli(["backfill-mint-burn", "--execute", "--allow-atomic-import"], {
      client: { queryRaw: vi.fn() }, write, env: {},
    })).rejects.toThrow("failed with status 500");
    expect(write).toHaveBeenCalledWith('{"error":"ALCHEMY_API_KEY is not configured"}\n');
  });

  it("surfaces uncertain import receipts even if an algorithm catches the transport error", async () => {
    vi.spyOn(stabilityBackfill, "handleBackfillStabilityIndex").mockImplementationOnce(async ({ db }) => {
      try {
        await db.batch([db.prepare("DELETE FROM cache"), db.prepare("DELETE FROM cache WHERE key='x'")]);
      } catch { /* Historical jobs can return a per-item error instead of throwing. */ }
      return Response.json({ errors: ["write failed"] });
    });
    await expect(runOneShotBackfillCli(["backfill-stability-index", "--execute", "--allow-atomic-import"], {
      client: { queryRaw: vi.fn(), executeStatementsRaw: () => { throw new Error("interrupted"); } },
      write: vi.fn(), env: {},
    })).rejects.toThrow(/Atomic outcome unknown.*_pharos_backfill_[a-f0-9]{32}/);
  });
});

describe("remote D1 backfill statements", () => {
  it("binds positional literals without replacing SQL strings, quoted identifiers or comments", () => {
    expect(bindBackfillSql("SELECT '?', \"?\", [?], `?`, ?1, ?2, ?1 -- ?\n/* ? */", ["O'Hara", null]))
      .toBe("SELECT '?', \"?\", [?], `?`, 'O''Hara', NULL, 'O''Hara' -- ?\n/* ? */");
    expect(() => bindBackfillSql("SELECT ?", [NaN])).toThrow("Unsupported");
    expect(() => bindBackfillSql("SELECT ?", [])).toThrow("Missing");
    expect(() => bindBackfillSql("SELECT 1", [1])).toThrow("Unused");
  });

  it("retains result ordering, changes, bound values and transaction rollback on the latest schema", async () => {
    const { sqlite } = fixtures.open();
    const client = {
      queryRaw(sql: string) {
        const statement = sqlite.prepare(sql);
        return statement.columns().length ? envelope(statement.all()) : envelope([], Number(statement.run().changes));
      },
      executeStatementsRaw(statements: string[]) {
        sqlite.exec("BEGIN");
        try {
          for (const sql of statements) this.queryRaw(sql);
          sqlite.exec("COMMIT");
          // Remote Wrangler imports return one aggregate receipt, not a D1 batch.
          return envelope([{ "Total queries executed": statements.length }], 0);
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    };
    const db = createBackfillDatabase(client, { atomicImports: true });
    const results = await db.batch([
      db.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)").bind("test", "quote ' ?", 123),
      db.prepare("UPDATE cache SET updated_at = ? WHERE key = ?").bind(124, "test"),
    ]);
    expect(results.map((result) => result.meta.changes)).toEqual([1, 1]);
    const ddl = await db.batch([
      db.prepare("UPDATE cache SET updated_at = 125 WHERE key = 'test'"),
      db.prepare("CREATE TABLE backfill_test_scratch (id INTEGER)"),
      db.prepare("DROP TABLE backfill_test_scratch"),
    ]);
    expect(ddl.map((result) => result.meta.changes)).toEqual([1, 0, 0]);
    expect(results.every((result) => result.results.length === 0)).toBe(true);
    expect(await db.prepare("SELECT value FROM cache WHERE key = ?").bind("test").first("value")).toBe("quote ' ?");
    await expect(db.batch([
      db.prepare("DELETE FROM cache WHERE key = ?").bind("test"),
      db.prepare("INSERT INTO cache (key,value,updated_at) VALUES ('invalid',NULL,123)"),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT value FROM cache WHERE key = ?").bind("test").first("value")).toBe("quote ' ?");
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_pharos_backfill_%'").all()).toEqual([]);
    await expect(db.batch([db.prepare("SELECT 1"), db.prepare("DELETE FROM cache")])).rejects.toThrow("nonreturning-writes");
  });

  it("uses command envelopes without imports and retains per-write counts, including local metadata stripping", async () => {
    // Wrangler 4.129.0 execute.ts: remote query API emits ordered envelopes;
    // executeLocally maps meta to duration only. Sanitized source-recorded shapes.
    const remote = {
      success: true, results: [],
      meta: { served_by: "v3-prod", duration: 0.19, changes: 7, last_row_id: 1,
        changed_db: true, size_after: 32768, rows_read: 7, rows_written: 7 },
    };
    const client = {
      queryRaw: vi.fn<(sql: string) => string>()
        .mockReturnValueOnce(JSON.stringify([remote, { success: true, results: [{ __pharos_changes: 7 }], meta: { duration: 0.02 } }]))
        .mockReturnValueOnce(JSON.stringify([{ success: true, results: [], meta: { duration: 1 } },
          { success: true, results: [{ __pharos_changes: 0 }], meta: { duration: 0 } }])),
      executeStatementsRaw: vi.fn(),
    };
    const db = createBackfillDatabase(client);
    const results = await db.batch([
      db.prepare("UPDATE cache SET value = ? WHERE key = ?").bind("RETURNING; SELECT 'read' --", "test"),
      db.prepare("CREATE TABLE scratch (\"RETURNING\" TEXT) -- SELECT RETURNING"),
    ]);
    expect(results.map((result) => result.meta.changes)).toEqual([7, 0]);
    expect(client.queryRaw.mock.calls[0]![0]).toContain("SELECT changes() AS __pharos_changes");
    expect(client.queryRaw.mock.calls[1]![0]).toMatch(/-- SELECT RETURNING\n;\s+SELECT 0 AS __pharos_changes/);
    expect(client.executeStatementsRaw).not.toHaveBeenCalled();
  });

  it("ignores quoted/commented keywords but rejects mixed reads, actual RETURNING and multiple writes before effects", async () => {
    const client = { queryRaw: vi.fn((_sql: string) => JSON.stringify([
      { success: true, results: [], meta: { duration: 0 } },
      { success: true, results: [{ __pharos_changes: 1 }], meta: { duration: 0 } },
    ])), executeStatementsRaw: vi.fn() };
    const db = createBackfillDatabase(client);
    await db.prepare("/* SELECT RETURNING */ INSERT INTO cache (key,value,updated_at) VALUES ('x','RETURNING',1); -- RETURNING").run();
    expect(client.queryRaw).toHaveBeenCalledTimes(1);
    client.queryRaw.mockClear();
    for (const sql of ["SELECT 1; DELETE FROM cache", "UPDATE cache SET value='x' RETURNING key",
      "DELETE FROM cache; INSERT INTO cache (key,value,updated_at) VALUES ('x','x',1)"]) {
      await expect(db.batch([db.prepare(sql)])).rejects.toThrow("nonreturning-writes");
    }
    expect(client.queryRaw).not.toHaveBeenCalled();
    expect(client.executeStatementsRaw).not.toHaveBeenCalled();
  });

  it("supports TAPE-style read-only batches through ordered command envelopes without importing", async () => {
    const client = { queryRaw: vi.fn<(sql: string) => string>()
      .mockReturnValueOnce(envelope([{ total: 1 }]))
      .mockReturnValueOnce(envelope([{ id: "first" }])), executeStatementsRaw: vi.fn() };
    const db = createBackfillDatabase(client, { atomicImports: true });
    const result = await db.batch([
      db.prepare("/* DELETE RETURNING */ SELECT COUNT(*) AS total FROM tape_events"),
      db.prepare("SELECT id FROM tape_events WHERE class = ?").bind("SELECT RETURNING"),
    ]);
    expect(result.map((row) => row.results)).toEqual([[{ total: 1 }], [{ id: "first" }]]);
    expect(client.queryRaw).toHaveBeenCalledTimes(2);
    expect(client.executeStatementsRaw).not.toHaveBeenCalled();
  });

  it("decodes the aggregate remote import shape only via ordered receipts and cleans up after confirmed readback", async () => {
    // executeRemotely --file returns this single import envelope, never one per statement.
    const client = {
      executeStatementsRaw: vi.fn((_statements: string[]) => JSON.stringify([{
        success: true, results: [{ "Total queries executed": 5, "Rows read": 3,
          "Rows written": 5, "Database size (MB)": "0.03" }],
        finalBookmark: "00000000-00000001-00000002-00000003",
        meta: { duration: 0.4, changes: 5, rows_read: 3, rows_written: 5, size_after: 32768 },
      }])),
      queryRaw: vi.fn<(sql: string) => string>()
        .mockReturnValueOnce(envelope([{ ordinal: 0, changed: 3 }, { ordinal: 1, changed: 0 }]))
        .mockReturnValueOnce(envelope()),
    };
    const db = createBackfillDatabase(client, { atomicImports: true });
    const results = await db.batch([db.prepare("DELETE FROM cache"), db.prepare("CREATE TABLE scratch (id INTEGER)")]);
    expect(results.map((result) => result.meta.changes)).toEqual([3, 0]);
    expect(client.executeStatementsRaw.mock.calls[0]![0]).toContainEqual(expect.stringContaining("SELECT 1, 0;"));
    expect(client.queryRaw.mock.calls[1]![0]).toMatch(/^DROP TABLE _pharos_backfill_[a-f0-9]{32};$/);
  });

  it("preserves receipt evidence and reports its exact name after uncertain import or readback", async () => {
    for (const failsAtImport of [true, false]) {
      const client = {
        executeStatementsRaw: vi.fn(() => {
          if (failsAtImport) throw new Error("interrupted polling");
          return envelope([{ "Total queries executed": 3 }], 99);
        }),
        queryRaw: vi.fn((_sql: string): string => { throw new Error("readback unavailable"); }),
      };
      const db = createBackfillDatabase(client, { atomicImports: true });
      await expect(db.batch([db.prepare("DELETE FROM cache"), db.prepare("DELETE FROM cache WHERE key='x'")]))
        .rejects.toThrow(/requires-reconciliation: _pharos_backfill_[a-f0-9]{32}/);
      expect(client.queryRaw.mock.calls.some(([sql]) => /^DROP/.test(sql))).toBe(false);
    }
  });

  it("stops command batches on failure without pretending previous writes rolled back", async () => {
    const client = { queryRaw: vi.fn<(sql: string) => string>()
      .mockReturnValueOnce(JSON.stringify([{ success: true, results: [], meta: { duration: 0 } },
        { success: true, results: [{ __pharos_changes: 1 }], meta: { duration: 0 } }]))
      .mockImplementationOnce(() => { throw new Error("second write failed"); }) };
    const db = createBackfillDatabase(client);
    await expect(db.batch([db.prepare("DELETE FROM cache WHERE key='first'"),
      db.prepare("DELETE FROM cache WHERE key='second'"), db.prepare("DELETE FROM cache WHERE key='third'")]))
      .rejects.toThrow("second write failed");
    expect(client.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed, unsuccessful or truncated result envelopes", async () => {
    for (const raw of ["{}", "[]", '[{"success":false,"results":[],"meta":{"changes":0}}]', '[{"success":true,"results":[]}]']) {
      const db = createBackfillDatabase({ queryRaw: () => raw });
      await expect(db.prepare("SELECT 1").all()).rejects.toThrow("backfill-d1");
    }
  });
});
