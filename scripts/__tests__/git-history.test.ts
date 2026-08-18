import { describe, expect, it, vi } from "vitest";
import { assertFullGitHistory, isShallowRepository } from "../lib/git-history.mts";

function execReturning(value: string) {
  return vi.fn(() => value) as never;
}

describe("git history guard", () => {
  it("reports a shallow checkout", () => {
    expect(isShallowRepository({ execFile: execReturning("true\n") })).toBe(true);
  });

  it("reports a full checkout", () => {
    expect(isShallowRepository({ execFile: execReturning("false\n") })).toBe(false);
  });

  it("passes through on a full checkout", () => {
    expect(() => assertFullGitHistory("sitemap-dates", { execFile: execReturning("false\n") })).not.toThrow();
  });

  it("names the artifact and the fix when the checkout is shallow", () => {
    expect(() => assertFullGitHistory("sitemap-dates", { execFile: execReturning("true\n") })).toThrow(
      /\[sitemap-dates\].*shallow.*fetch-depth: 0/s,
    );
  });
});
