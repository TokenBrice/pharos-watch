import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "[]"));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { d1ExecFile, d1Query } = await import("../lib/remote-d1");

describe("remote-d1 helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValue("[]");
  });

  it("executes D1 queries without shell interpolation", () => {
    const output = d1Query("stablecoin-db", "SELECT 1");

    expect(output).toBe("[]");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--command", "SELECT 1", "--json"],
      expect.objectContaining({ encoding: "utf-8", stdio: "pipe" }),
    );
  });

  it("executes D1 SQL files without shell interpolation", () => {
    d1ExecFile("stablecoin-db", ["SELECT 1;"], "test-remote-d1");

    const [, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(args).toEqual([
      "wrangler",
      "d1",
      "execute",
      "stablecoin-db",
      "--remote",
      "--file",
      expect.stringMatching(/test-remote-d1-\d+\.sql$/),
      "--json",
    ]);
  });
});
