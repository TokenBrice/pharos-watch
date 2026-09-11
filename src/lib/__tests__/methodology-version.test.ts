import { describe, it, expect } from "vitest";
import {
  compareMethodologyVersions,
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-versions/base";

function entry(version: string, effectiveAt: number, overrides: Partial<MethodologyChangelogEntry> = {}): MethodologyChangelogEntry {
  return {
    version, effectiveAt, title: "Release", date: "2026-01-01", summary: "Methodology update",
    impact: [], commits: [], reconstructed: false, ...overrides,
  };
}

const TEST_CHANGELOG = [entry("2.0", 1000), entry("1.0", 500, { reconstructed: true })];

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

  it("sorts changelog versions using Pharos decimal methodology numbering", () => {
    const sorted = createMethodologyVersion({
      // currentVersion must match the latest changelog entry (drift guard).
      currentVersion: "2.91",
      changelogPath: "/methodology/test-changelog/",
      changelog: [entry("2.9", 900), entry("2.91", 1000), entry("2.10", 800)],
    });

    expect(sorted.changelog.map((entry) => entry.version)).toEqual(["2.91", "2.9", "2.10"]);
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

describe("compareMethodologyVersions", () => {
  it("compares dotted methodology versions as decimal version numbers", () => {
    expect(compareMethodologyVersions("2.10", "2.9")).toBeLessThan(0);
    expect(compareMethodologyVersions("5.91", "5.9")).toBeGreaterThan(0);
    expect(compareMethodologyVersions("4.10", "4.1")).toBe(0);
    expect(() => compareMethodologyVersions("1.0", "1.0.0")).toThrow(/two-segment/i);
  });
});

describe("toMethodologyVersionLabel", () => {
  it("prefixes version with v", () => {
    expect(toMethodologyVersionLabel("3.1")).toBe("v3.1");
  });
});

describe("formatMethodologyDisplayDate", () => {
  it("formats changelog dates in UTC", () => {
    expect(formatMethodologyDisplayDate("2026-06-06")).toBe("Jun 6, 2026");
  });

  it("returns the source value for invalid dates", () => {
    expect(formatMethodologyDisplayDate("not-a-date")).toBe("not-a-date");
  });
});

describe("methodologyChangelogEntryId", () => {
  it("preserves historical changelog anchor ids", () => {
    expect(methodologyChangelogEntryId("3.01")).toBe("changelog-v-3-01");
  });
});
