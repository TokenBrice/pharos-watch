import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changelogs } from "../index";

const CHANGELOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_ENTRY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

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

  it("each entry spans one Monday-to-Sunday week without overlapping the next", () => {
    for (const [i, entry] of changelogs.entries()) {
      const from = new Date(`${entry.dateRange.from}T00:00:00Z`);
      const to = new Date(`${entry.dateRange.to}T00:00:00Z`);
      expect(from.getUTCDay(), entry.dateRange.from).toBe(1);
      expect(to.getTime() - from.getTime(), entry.dateRange.to).toBe(6 * 86_400_000);
      const older = changelogs[i + 1];
      if (older) expect(older.dateRange.to < entry.dateRange.from, entry.dateRange.to).toBe(true);
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
      const fileDate = fileName.replace(/\.json$/, "");
      expect(datesWithEntry.has(fileDate)).toBe(true);
    }
  });
});
