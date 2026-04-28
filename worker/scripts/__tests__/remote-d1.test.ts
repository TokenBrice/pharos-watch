import { existsSync } from "node:fs";
import { dirname } from "node:path";
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
    const client = createRemoteD1Client("stablecoin-db");
    const rows = client.query("SELECT 1");

    expect(rows).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--command", "SELECT 1"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  it("executes SQL files without shell interpolation and removes temp directories", () => {
    const client = createRemoteD1Client("stablecoin-db");

    client.executeStatements(["SELECT 1;"], "worker-remote-d1-test");

    const call = execFileSyncMock.mock.calls[0] as unknown[] | undefined;
    const args = call?.[1] as string[] | undefined;
    const fileArg = args?.[args.length - 1];
    expect(args).toBeDefined();
    expect(args).toEqual([
      "wrangler",
      "d1",
      "execute",
      "stablecoin-db",
      "--remote",
      "--json",
      "--file",
      expect.stringMatching(/worker-remote-d1-test-.+\/statements\.sql$/),
    ]);
    expect(fileArg).toBeTypeOf("string");
    // Test-owned path captured from the mocked wrangler invocation.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(dirname(fileArg as string))).toBe(false);
  });

  it("escapes SQL string literals", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
