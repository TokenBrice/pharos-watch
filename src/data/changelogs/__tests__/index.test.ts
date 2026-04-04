import { describe, expect, it } from "vitest";
import { changelogs } from "../index";

describe("changelogs barrel", () => {
  it("exports a non-empty array sorted newest-first", () => {
    expect(changelogs.length).toBeGreaterThan(0);
    for (let i = 1; i < changelogs.length; i++) {
      expect(changelogs[i - 1].dateRange.to >= changelogs[i].dateRange.to).toBe(true);
    }
  });

  it("each entry has required fields", () => {
    for (const entry of changelogs) {
      expect(entry.dateRange.from).toBeTruthy();
      expect(entry.dateRange.to).toBeTruthy();
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.stats.totalCommits).toBeGreaterThan(0);
      expect(entry.commits.length).toBeGreaterThan(0);
    }
  });
});
