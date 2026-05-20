import { describe, expect, it } from "vitest";
import {
  CURATED_ANNOTATIONS,
  getCuratedAnnotations,
} from "../curated-annotations";
import { CHART_ANNOTATION_KINDS } from "@shared/types/chart-annotation";

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

  it("returns an empty array for unknown coin ids (no throw)", () => {
    expect(getCuratedAnnotations("does-not-exist")).toEqual([]);
  });

  it("returns the same reference each call (stable EMPTY)", () => {
    const a = getCuratedAnnotations("does-not-exist");
    const b = getCuratedAnnotations("also-not-exist");
    expect(a).toBe(b);
  });
});
