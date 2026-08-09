import { describe, it, expect } from "vitest";
import {
  compareMethodologyVersions,
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-versions/base";

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

  it("sorts changelog versions using Pharos decimal methodology numbering", () => {
    const sorted = createMethodologyVersion({
      // currentVersion must match the latest changelog entry (drift guard).
      currentVersion: "2.91",
      changelogPath: "/methodology/test-changelog/",
      changelog: [
        {
          version: "2.9",
          title: "Older minor",
          date: "2026-03-01",
          effectiveAt: 900,
          summary: "Older version",
          impact: [],
          commits: [],
          reconstructed: false,
        },
        {
          version: "2.91",
          title: "Newer minor",
          date: "2026-03-02",
          effectiveAt: 1000,
          summary: "Newer version",
          impact: [],
          commits: [],
          reconstructed: false,
        },
        {
          version: "2.10",
          title: "Newest minor",
          date: "2026-03-03",
          effectiveAt: 1100,
          summary: "Newest version",
          impact: [],
          commits: [],
          reconstructed: false,
        },
      ],
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
