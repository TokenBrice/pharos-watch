import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn((_file: string, _args: readonly string[]) => "[]"));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { createD1Client, sqlString } = await import("../lib/remote-d1");

describe("remote-d1 helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValue("[]");
  });

  it("executes D1 queries without shell interpolation", () => {
    const output = createD1Client("stablecoin-db").queryRaw("SELECT 1");

    expect(output).toBe("[]");
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
      return "[]";
    });
    createD1Client("stablecoin-db", { batchSize: 2, target: "local" })
      .executeStatements(["SELECT 'first';", "SELECT 'second';", "SELECT 'third';"], "test-remote-d1");

    expect(contents).toEqual(["SELECT 'first';\nSELECT 'second';", "SELECT 'third';"]);
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

  it("does not execute an empty statement list", () => {
    createD1Client("stablecoin-db").executeStatements([], "test-remote-d1");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("decodes Wrangler results and propagates malformed JSON", () => {
    const client = createD1Client("stablecoin-db", { target: "local" });
    execFileSyncMock.mockReturnValueOnce(JSON.stringify([{ success: true, results: [{ id: 1 }, { id: 2 }] }]));
    expect(client.query("SELECT id FROM assets")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(execFileSyncMock.mock.calls[0]![1]).toContain("--local");
    expect(execFileSyncMock.mock.calls[0]![1]).not.toContain("--remote");
    execFileSyncMock.mockReturnValueOnce("[]");
    expect(client.query("SELECT id FROM assets")).toEqual([]);
    execFileSyncMock.mockReturnValueOnce("not JSON");
    expect(() => client.query("SELECT id FROM assets")).toThrow(SyntaxError);
  });

  it("escapes SQL string literals", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
