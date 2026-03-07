import { describe, it, expect } from "vitest";
import {
  createMethodologyVersion,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-version";

const TEST_CHANGELOG: MethodologyChangelogEntry[] = [
  {
    version: "2.0",
    title: "Second release",
    date: "2026-02-01",
    effectiveAt: 1000,
    summary: "Second version",
    impact: ["Change A"],
    commits: ["abc123"],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial release",
    date: "2026-01-01",
    effectiveAt: 500,
    summary: "First version",
    impact: ["Launch"],
    commits: ["def456"],
    reconstructed: true,
  },
];

describe("createMethodologyVersion", () => {
  const mv = createMethodologyVersion({
    currentVersion: "2.0",
    changelogPath: "/methodology/test-changelog/",
    changelog: TEST_CHANGELOG,
  });

  it("exposes currentVersion and versionLabel", () => {
    expect(mv.currentVersion).toBe("2.0");
    expect(mv.versionLabel).toBe("v2.0");
  });

  it("exposes changelogPath", () => {
    expect(mv.changelogPath).toBe("/methodology/test-changelog/");
  });

  it("resolves version at timestamp", () => {
    expect(mv.getVersionAt(499)).toBe("1.0");
    expect(mv.getVersionAt(500)).toBe("1.0");
    expect(mv.getVersionAt(999)).toBe("1.0");
    expect(mv.getVersionAt(1000)).toBe("2.0");
    expect(mv.getVersionAt(9999)).toBe("2.0");
  });

  it("returns currentVersion for non-finite timestamps", () => {
    expect(mv.getVersionAt(Number.NaN)).toBe("2.0");
    expect(mv.getVersionAt(Number.POSITIVE_INFINITY)).toBe("2.0");
    expect(mv.getVersionAt(Number.NEGATIVE_INFINITY)).toBe("2.0");
  });

  it("handles empty changelog", () => {
    const empty = createMethodologyVersion({
      currentVersion: "1.0",
      changelogPath: "/test/",
      changelog: [],
    });
    expect(empty.getVersionAt(999)).toBe("1.0");
  });
});

describe("toMethodologyVersionLabel", () => {
  it("prefixes version with v", () => {
    expect(toMethodologyVersionLabel("3.1")).toBe("v3.1");
  });
});
