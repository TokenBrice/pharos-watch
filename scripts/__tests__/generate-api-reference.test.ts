import { readFileSync } from "node:fs";
import type * as FileSystem from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { END_MARKER, START_MARKER, main } from "../maintenance/generate-api-reference";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

afterEach(() => vi.restoreAllMocks());

describe("generate-api-reference check mode", () => {
  it("rejects a modified generated API block without writing the document", () => {
    const previousExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readFileSync).mockReturnValueOnce(`${START_MARKER}\nmodified generated content\n${END_MARKER}`);
    try {
      main(true);
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("docs/api-reference.md is out of date"));
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
