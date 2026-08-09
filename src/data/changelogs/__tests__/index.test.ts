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
      expect(entry.dateRange.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.dateRange.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.summary.length).toBeGreaterThan(0);
      for (const item of entry.summary) {
        if (item.href != null) {
          expect(item.href).toMatch(/^\/(?!\/)/);
        }
      }
      expect(entry.stats.totalCommits).toBeGreaterThan(0);
      expect(entry.commits.length).toBeGreaterThan(0);
      // Authored commit lists are capped at the rendered 20; git is the archive.
      expect(entry.commits.length).toBeLessThanOrEqual(20);
      expect(entry.stats.totalCommits).toBeGreaterThanOrEqual(entry.commits.length);
    }
  });

  it("fieldNotes entries do not exceed 80 words", () => {
    for (const entry of changelogs) {
      if (entry.fieldNotes != null) {
        const wordCount = entry.fieldNotes.trim().split(/\s+/).length;
        expect(wordCount).toBeLessThanOrEqual(80);
      }
    }
  });

  it("registers every dated changelog file", () => {
    const datedFileCount = readdirSync(CHANGELOG_DIR)
      .filter((fileName) => CHANGELOG_ENTRY_FILE_RE.test(fileName))
      .length;

    expect(changelogs).toHaveLength(datedFileCount);
  });

  it("each file's dateRange.to matches its filename date", () => {
    const datedFiles = readdirSync(CHANGELOG_DIR).filter((fileName) =>
      CHANGELOG_ENTRY_FILE_RE.test(fileName),
    );
    const datesWithEntry = new Set(changelogs.map((entry) => entry.dateRange.to));

    for (const fileName of datedFiles) {
      const fileDate = fileName.replace(/\.ts$/, "");
      expect(datesWithEntry.has(fileDate)).toBe(true);
    }
  });
});
