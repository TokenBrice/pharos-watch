import { describe, expect, it, vi } from "vitest";
import { collectStagedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";

describe("staged file collection", () => {
  it("reads the index with a NUL-delimited diff", () => {
    const execFile = vi.fn(() => "b.ts\0a.ts\0a.ts\0");
    expect(collectStagedFiles({ execFile: execFile as never, cwd: "/repo" })).toEqual(["a.ts", "b.ts"]);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });

  it("normalizes separators and leading ./", () => {
    const execFile = vi.fn(() => "./src\\app\\page.tsx\0");
    expect(collectStagedFiles({ execFile: execFile as never })).toEqual(["src/app/page.tsx"]);
  });

  it("parses the --staged flag without consuming a value", () => {
    expect(parseChangedFileArgs(["--staged"]).staged).toBe(true);
    expect(parseChangedFileArgs(["--staged"]).rest).toEqual([]);
    expect(parseChangedFileArgs([]).staged).toBe(false);
  });
});
