import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURATED_ANNOTATIONS,
  getCuratedAnnotations,
} from "../curated-annotations";
import { CHART_ANNOTATION_KINDS } from "@shared/types/chart-annotation";

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");
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
  it("uses only the public ChartAnnotationKind enum", () => {
    const allowed = new Set(CHART_ANNOTATION_KINDS);
    for (const [coinId, list] of Object.entries(CURATED_ANNOTATIONS)) {
      for (const a of list) {
        expect(allowed.has(a.kind), `${coinId} → ${a.label}`).toBe(true);
      }
    }
  });

  it("has labels ≤80 chars", () => {
    for (const [coinId, list] of Object.entries(CURATED_ANNOTATIONS)) {
      for (const a of list) {
        expect(a.label.length, `${coinId} → ${a.label}`).toBeLessThanOrEqual(80);
      }
    }
  });

  it("uses plausible historical timestamps (>= 2017-01-01, <= now)", () => {
    const min = Date.UTC(2017, 0, 1);
    const max = Date.now();
    for (const [coinId, list] of Object.entries(CURATED_ANNOTATIONS)) {
      for (const a of list) {
        expect(a.ts, `${coinId} → ${a.label}`).toBeGreaterThanOrEqual(min);
        expect(a.ts, `${coinId} → ${a.label}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("hits the top-4 coverage gate (≥10 annotations across USDC/USDT/DAI/USDe)", () => {
    const top4 = ["usdc-circle", "usdt-tether", "dai-makerdao", "usde-ethena"];
    const total = top4.reduce(
      (sum, id) => sum + (CURATED_ANNOTATIONS[id]?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(10);
  });

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

  it("only keys annotations to coins that exist in the stablecoin registry", () => {
    const coinIds = new Set(
      readdirSync(COIN_SOURCE_DIR)
        .filter((fileName) => fileName.endsWith(".json"))
        .map((fileName) => fileName.slice(0, -".json".length)),
    );
    const orphaned = Object.keys(CURATED_ANNOTATIONS).filter(
      (coinId) => !coinIds.has(coinId),
    );
    expect(orphaned, `orphaned annotation keys: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("returns an empty array for unknown coin ids (no throw)", () => {
    expect(getCuratedAnnotations("does-not-exist")).toEqual([]);
  });

  it("returns an empty array for prototype-reserved coin ids", () => {
    expect(getCuratedAnnotations("__proto__")).toEqual([]);
    expect(getCuratedAnnotations("constructor")).toEqual([]);
    expect(getCuratedAnnotations("toString")).toEqual([]);
  });

  it("returns the same reference each call (stable EMPTY)", () => {
    const a = getCuratedAnnotations("does-not-exist");
    const b = getCuratedAnnotations("also-not-exist");
    expect(a).toBe(b);
  });
});
