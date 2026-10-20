import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_ANNOTATIONS,
  getCuratedAnnotations,
} from "../curated-annotations";

const ANNOTATION_SOURCE_DIR = join(process.cwd(), "shared/data/annotations/coins");

function annotationSourceFiles() {
  return readdirSync(ANNOTATION_SOURCE_DIR)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
}

function timestampForSourceDate(date: string): number {
  return Date.parse(date.length === 10 ? `${date}T00:00:00.000Z` : date);
}

describe("curated-annotations", () => {
  it("loads every per-coin JSON source in file and entry order", () => {
    const sourceFiles = annotationSourceFiles();
    const sourceIds = sourceFiles.map((fileName) => fileName.slice(0, -".json".length));
    expect(sourceIds).toEqual(Object.keys(CURATED_ANNOTATIONS).sort());

    for (const fileName of sourceFiles) {
      const coinId = fileName.slice(0, -".json".length);
      const source = JSON.parse(
        readFileSync(join(ANNOTATION_SOURCE_DIR, fileName), "utf8"),
      ) as Array<Record<string, unknown>>;
      const loaded = CURATED_ANNOTATIONS[coinId];

      expect(loaded).toBeDefined();
      expect(loaded).toHaveLength(source.length);
      for (const [index, entry] of source.entries()) {
        const ts = timestampForSourceDate(String(entry.date));
        expect(Number.isFinite(ts), `${coinId}[${index}] date`).toBe(true);
        expect(loaded[index]).toMatchObject({
          ts,
          kind: entry.kind,
          label: entry.label,
        });
        expect(loaded[index]?.severity).toBe(entry.severity);
        expect(loaded[index]?.href).toBe(entry.href);
        if (entry.note !== undefined) {
          expect(String(entry.note).length, `${coinId}[${index}] note`).toBeGreaterThan(0);
        }
        expect(loaded[index]).not.toHaveProperty("note");
        if (entry.href !== undefined) {
          expect(String(entry.href)).toMatch(/^https?:\/\//);
        }
      }
    }
  });

  it("returns an empty array for prototype-reserved coin ids", () => {
    expect(getCuratedAnnotations("__proto__")).toEqual([]);
    expect(getCuratedAnnotations("constructor")).toEqual([]);
    expect(getCuratedAnnotations("toString")).toEqual([]);
  });

});

describe("curated annotation calendar admission", () => {
  afterEach(() => {
    vi.doUnmock("../coins/usdc-circle.json");
    vi.resetModules();
  });

  async function loadWithDate(date: unknown) {
    vi.resetModules();
    vi.doMock("../coins/usdc-circle.json", () => ({
      default: [{ date, kind: "depeg", label: "Calendar admission witness" }],
    }));
    return import("../curated-annotations");
  }

  it.each([
    "2023-02-29", "2024-02-30T00:00:00Z", "2023-02-29T12:00:00Z",
    "2024-04-31T23:59:59.123Z", "2024-02-29T24:00:00Z",
    "2024-02-29T12:60:00Z", "2024-02-29T12:00:60Z",
    "2024-02-29T12:00:00+00:00", 1_709_164_800_000,
  ])("rejects invalid timestamp %s with coin and entry context", async (date) => {
    await expect(loadWithDate(date)).rejects.toThrow(/Invalid curated annotation usdc-circle\[0\]: date/);
  });

  it.each([
    ["2024-02-29", 1_709_164_800_000],
    ["2024-02-29T12:34:56Z", 1_709_210_096_000],
    ["2024-02-29T12:34:56.1Z", 1_709_210_096_100],
    ["2024-02-29T12:34:56.123Z", 1_709_210_096_123],
  ])("preserves admitted milliseconds for %s", async (date, expectedTs) => {
    const loaded = await loadWithDate(date);
    expect(loaded.getCuratedAnnotations("usdc-circle")[0]?.ts).toBe(expectedTs);
  });
});
