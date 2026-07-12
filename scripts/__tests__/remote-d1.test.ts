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

  it("executes D1 SQL files without shell interpolation", () => {
    createD1Client("stablecoin-db").executeStatements(["SELECT 1;"], "test-remote-d1");

    const [, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(args).toEqual([
      "wrangler",
      "d1",
      "execute",
      "stablecoin-db",
      "--remote",
      "--file",
      expect.stringMatching(/test-remote-d1-.+\/statements\.sql$/),
      "--json",
    ]);
  });

  it("escapes SQL string literals", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
