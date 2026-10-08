import { describe, expect, it, vi } from "vitest";
import { mergeCriticalCoverage } from "../maintenance/merge-critical-coverage";
import { parseCriticalCoverageRefs } from "../lib/critical-coverage-refs.mts";

describe("critical coverage merge refs", () => {
  it.each([
    {},
    { PR_BASE_SHA: "frozen-base" },
    { PR_HEAD_SHA: "frozen-head" },
    { CRITICAL_COVERAGE_COMPARE_REF: "frozen-base" },
  ])("rejects incomplete event refs before merging or enforcing coverage: %j", (refs) => {
    const runCommand = vi.fn(() => 0);
    expect(() => mergeCriticalCoverage({ env: { NODE_ENV: "test", GITHUB_ACTIONS: "true", ...refs }, runCommand }))
      .toThrow("requires frozen base and head refs");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("retains both frozen event identities and permits explicit shard CLI refs", () => {
    expect(parseCriticalCoverageRefs([], { NODE_ENV: "test", GITHUB_ACTIONS: "true", PR_BASE_SHA: "base", PR_HEAD_SHA: "head" }))
      .toMatchObject({ base: "base", head: "head" });
    expect(parseCriticalCoverageRefs(["--base=base", "--head=head", "--shard=1/4"], { NODE_ENV: "test", GITHUB_ACTIONS: "true" }))
      .toEqual({ base: "base", head: "head", rest: ["--shard=1/4"], staged: false });
  });
});
