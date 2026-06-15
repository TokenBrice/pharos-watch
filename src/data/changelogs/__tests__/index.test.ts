import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changelogs } from "../index";

const CHANGELOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_ENTRY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.ts$/;

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
      for (const item of entry.summary) {
        if (item.href != null) {
          expect(item.href).toMatch(/^\/(?!\/)/);
        }
      }
      expect(entry.stats.totalCommits).toBeGreaterThan(0);
      expect(entry.commits.length).toBeGreaterThan(0);
    }
  });

  it("registers every dated changelog file", () => {
    const datedFileCount = readdirSync(CHANGELOG_DIR)
      .filter((fileName) => CHANGELOG_ENTRY_FILE_RE.test(fileName))
      .length;

    expect(changelogs).toHaveLength(datedFileCount);
  });
});
