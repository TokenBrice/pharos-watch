import { describe, expect, it, vi } from "vitest";
import { assertFullGitHistory } from "../lib/git-history.mts";

function execReturning(value: string) {
  return vi.fn(() => value) as never;
}

describe("git history guard", () => {
  it("names the artifact and the fix when the checkout is shallow", () => {
    expect(() => assertFullGitHistory("sitemap-dates", { execFile: execReturning("true\n") })).toThrow(
      /\[sitemap-dates\].*shallow.*fetch-depth: 0/s,
    );
  });
});
