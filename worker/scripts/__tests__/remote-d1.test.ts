import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "[]"));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { createRemoteD1Client, sqlString } = await import("../lib/remote-d1");

describe("worker remote D1 script helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValue("[]");
  });

  it("executes D1 queries without shell interpolation", () => {
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
      return "[]";
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
    expect(sqlFileContents).toBe("BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;");
  });

  it("rolls back a statement chunk when a later statement fails", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE values_under_test (value INTEGER NOT NULL); INSERT INTO values_under_test VALUES (1);");
      execFileSyncMock.mockImplementation(((_command: string, args: string[]) => {
        const file = args[args.length - 2]!;
        try {
          db.exec(readFileSync(file, "utf8"));
          return "[]";
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }) as typeof execFileSyncMock);

      const client = createRemoteD1Client("stablecoin-db");
      expect(() => client.executeStatements([
        "UPDATE values_under_test SET value = 2;",
        "INSERT INTO missing_table VALUES (1);",
      ], "worker-remote-d1-rollback-test")).toThrow();
      expect(db.prepare("SELECT value FROM values_under_test").get()).toEqual({ value: 1 });
    } finally {
      db.close();
    }
  });

  it("escapes SQL string literals", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
