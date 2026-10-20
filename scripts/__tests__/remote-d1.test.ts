import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn((_file: string, _args: readonly string[]) => '[{"success":true,"results":[]}]'));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { createRemoteD1Client } from "../../worker/scripts/lib/remote-d1";

import { createD1Client, decodeD1Envelopes, sqlString } from "../lib/remote-d1";

describe("remote-d1 helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValue('[{"success":true,"results":[]}]');
  });

  it("executes D1 queries without shell interpolation", () => {
    const output = createD1Client("stablecoin-db").queryRaw("SELECT 1");

    expect(output).toBe('[{"success":true,"results":[]}]');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--command", "SELECT 1", "--json"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  it("executes ordered local SQL batches and removes each temporary directory", () => {
    const files: string[] = [];
    const contents: string[] = [];
    execFileSyncMock.mockImplementation((_file, args) => {
      expect(args).toContain("--local");
      expect(args).not.toContain("--remote");
      const path = args[args.indexOf("--file") + 1]!;
      files.push(path);
      contents.push(readFileSync(path, "utf8"));
      return '[{"success":true,"results":[]}]';
    });
    createD1Client("stablecoin-db", { batchSize: 2, target: "local" })
      .executeStatements(["SELECT 'first';", "SELECT 'second';", "SELECT 'third';"], "test-remote-d1");

    expect(contents).toEqual([
      "SELECT 'first';\nSELECT 'second';",
      "SELECT 'third';",
    ]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    for (const path of files) expect(existsSync(dirname(path))).toBe(false);
  });

  it("removes the SQL directory and stops later batches when execution throws", () => {
    const failure = new Error("execution failed");
    let sqlPath = "";
    execFileSyncMock.mockImplementation((_file, args) => {
      sqlPath = args[args.indexOf("--file") + 1]!;
      expect(readFileSync(sqlPath, "utf8")).toBe("SELECT 1;");
      throw failure;
    });
    expect(() => createD1Client("stablecoin-db", { batchSize: 1 })
      .executeStatements(["SELECT 1;", "SELECT 2;"], "test-remote-d1")).toThrow(failure);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(sqlPath))).toBe(false);
  });

  it("retains opted-in failed SQL and exposes Wrangler stdout/stderr without executing later batches", () => {
    const scratch = mkdtempSync(join(tmpdir(), "d1-import-failure-test-"));
    const failure = Object.assign(new Error("wrangler import exited 1"), {
      stdout: JSON.stringify({ success: false, errors: [{ code: 7500, message: "statement too long" }] }),
      stderr: Buffer.from("SQLITE_TOOBIG: statement exceeds 100000 bytes"),
    });
    let sqlPath = "";
    execFileSyncMock.mockImplementation((_file, args) => {
      sqlPath = args[args.indexOf("--file") + 1]!;
      throw failure;
    });
    try {
      const client = createD1Client("stablecoin-db", { batchSize: 1, failedSqlDirectory: scratch });
      let caught: unknown;
      try {
        client.executeStatements(["SELECT 'diagnostic evidence';", "SELECT 'must not run';"], "replay-failed");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toMatchObject({ cause: failure });
      expect((caught as Error).message).toContain('"message":"statement too long"');
      expect((caught as Error).message).toContain("SQLITE_TOOBIG: statement exceeds 100000 bytes");
      expect((caught as Error).message).toContain(`SQL retained at ${sqlPath}`);
      expect(sqlPath.startsWith(scratch)).toBe(true);
      expect(readFileSync(sqlPath, "utf8")).toBe("SELECT 'diagnostic evidence';");
      expect(statSync(sqlPath).mode & 0o777).toBe(0o600);
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("cleans successful SQL imports even when failure retention is enabled", () => {
    const scratch = mkdtempSync(join(tmpdir(), "d1-import-success-test-"));
    let sqlPath = "";
    execFileSyncMock.mockImplementation((_file, args) => {
      sqlPath = args[args.indexOf("--file") + 1]!;
      return '[{"success":true,"results":[]}]';
    });
    try {
      createD1Client("stablecoin-db", { failedSqlDirectory: scratch }).executeStatements(["SELECT 1;"], "replay-ok");
      expect(existsSync(sqlPath)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retains a single remote import envelope without chunking an atomic statement group", () => {
    const imported = JSON.stringify([{
      success: true, results: [{ "Total queries executed": 2, "Rows read": 0,
        "Rows written": 2, "Database size (MB)": "0.03" }],
      finalBookmark: "00000000-00000001-00000002-00000003",
      meta: { duration: 1.23, changes: 2, rows_read: 0, rows_written: 2, size_after: 32768 },
    }]);
    let path = "";
    execFileSyncMock.mockImplementation((_file, args) => {
      expect(args).toContain("--remote");
      path = args[args.indexOf("--file") + 1]!;
      expect(readFileSync(path, "utf8")).toBe("DELETE FROM cache;\nINSERT INTO cache VALUES ('x','x',1);");
      return imported;
    });
    const client = createD1Client("stablecoin-db", { batchSize: 1 });
    expect(client.executeStatementsRaw!(["DELETE FROM cache;", "INSERT INTO cache VALUES ('x','x',1);"], "atomic-test")).toBe(imported);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("decodes every Wrangler query result envelope and propagates malformed JSON", () => {
    const client = createD1Client("stablecoin-db", { target: "local" });
    const envelopes = [
      [[{ results: [{ id: 1 }] }, { results: [{ id: 2 }] }], [{ id: 1 }, { id: 2 }]],
      [{ results: [{ id: 3 }] }, [{ id: 3 }]],
      [{ result: [{ results: [{ id: 4 }] }] }, [{ id: 4 }]],
      [{ result: { results: [{ id: 5 }] } }, [{ id: 5 }]],
      [{ success: true, result: [{ success: true, results: [{ id: 6 }] }, { results: [{ id: 7 }] }] }, [{ id: 6 }, { id: 7 }]],
      [{ result: [{ result: { success: true, results: [] } }] }, []],
      [{ success: true, results: [], error: null, errors: [] }, []],
    ] as const;

    for (const [envelope, expected] of envelopes) {
      execFileSyncMock.mockReturnValueOnce(JSON.stringify(envelope));
      expect(client.query("SELECT id FROM assets")).toEqual(expected);
    }
    expect(execFileSyncMock.mock.calls[0]![1]).toContain("--local");
    expect(execFileSyncMock.mock.calls[0]![1]).not.toContain("--remote");
    execFileSyncMock.mockReturnValueOnce('[{"success":true,"results":[]}]');
    expect(client.query("SELECT id FROM assets")).toEqual([]);
    execFileSyncMock.mockReturnValueOnce("not JSON");
    expect(() => client.query("SELECT id FROM assets")).toThrow(SyntaxError);
  });

  it.each([
    null, {}, [], { success: true }, { results: null }, { results: {} },
    { success: false, results: [] }, { success: "true", results: [] },
    { success: true, results: [], errors: [{ message: "read failed" }] },
    { results: [], error: "read failed" }, { result: [] }, { result: [{}] },
    { success: true, results: [], error: "" },
    { success: true, result: [{ results: [] }], error: "" },
    { result: [{ results: [{ id: 1 }] }, { results: [], error: "" }] },
    [{ success: true, results: [{ id: 1 }] }, { success: false, results: [] }],
    { success: false, result: [{ success: true, results: [] }] },
    { result: [{ results: [] }, { result: { success: false, results: [] } }] },
    { result: [{ results: [{ id: 1 }] }, { results: "truncated" }] },
  ].map((payload) => [payload] as const))("rejects failed or unrecognized query evidence: %j", (payload) => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(payload));
    expect(() => createD1Client("stablecoin-db").query("SELECT id FROM assets")).toThrow(/d1-/);
  });

  it("retains complete ordered envelopes and metadata for statement receipt consumers", () => {
    const first = { success: true, results: [], meta: { changes: 2 }, finalBookmark: "bookmark" };
    const second = { success: true, results: [{ changes: 3 }], meta: { changes: 0 } };
    const decoded = decodeD1Envelopes({ success: true, result: [first, { result: second }] });
    expect(decoded).toEqual([first, second]);
    expect(decoded[0]).toBe(first);
    expect(decoded[1]).toBe(second);
  });

  it("propagates process failures instead of decoding them as empty queries", () => {
    const failure = Object.assign(new Error("wrangler exited 1"), { stdout: '[{"success":true,"results":[]}]' });
    execFileSyncMock.mockImplementationOnce(() => { throw failure; });
    expect(() => createD1Client("stablecoin-db").query("SELECT 1")).toThrow(failure);
  });

  it("executes Worker wrapper queries without shell interpolation from the Worker root", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/not-pharos/worker/scripts");
    const client = createRemoteD1Client("stablecoin-db");
    const rows = client.query("SELECT 1");

    expect(rows).toEqual([]);
    cwdSpy.mockRestore();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--command", "SELECT 1", "--json"],
      expect.objectContaining({
        cwd: expect.stringMatching(/\/worker$/),
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
  });

  it("executes SQL files without shell interpolation and removes temp directories", () => {
    const client = createRemoteD1Client("stablecoin-db");
    let sqlFileContents = "";
    execFileSyncMock.mockImplementation(((_command: string, args: string[]) => {
      sqlFileContents = readFileSync(args[args.length - 2]!, "utf8");
      return '[{"success":true,"results":[]}]';
    }) as typeof execFileSyncMock);

    client.executeStatements(["SELECT 1;"], "worker-remote-d1-test");

    const call = execFileSyncMock.mock.calls[0] as unknown[] | undefined;
    const args = call?.[1] as string[] | undefined;
    const fileArg = args?.[args.length - 2];
    expect(args).toBeDefined();
    expect(args).toEqual([
      "wrangler",
      "d1",
      "execute",
      "stablecoin-db",
      "--remote",
      "--file",
      expect.stringMatching(/worker-remote-d1-test-.+\/statements\.sql$/),
      "--json",
    ]);
    expect(fileArg).toBeTypeOf("string");
    // Test-owned path captured from the mocked wrangler invocation.
    expect(existsSync(dirname(fileArg as string))).toBe(false);
    expect(sqlFileContents).toBe("SELECT 1;");
  });

  it("escapes SQL string literals", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
