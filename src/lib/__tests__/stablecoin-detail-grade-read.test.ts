import { describe, expect, it } from "vitest";
import { resolveDetailGradeRead } from "@/lib/stablecoin-detail-query-view-model";
import type { StablecoinDetailStaleQuery } from "@/lib/stablecoin-detail-view-model-types";

function reportCards(overrides: Partial<StablecoinDetailStaleQuery>): StablecoinDetailStaleQuery[] {
  return [{ preset: "reportCards", dataUpdatedAt: 0, error: null, hasData: false, meta: null, ...overrides }];
}

describe("resolveDetailGradeRead", () => {
  it("is settled whenever a card is present", () => {
    expect(resolveDetailGradeRead({ grade: "A" }, reportCards({ isLoading: true }))).toBe("settled");
  });

  it("is pending while the first report-card fetch is in flight", () => {
    expect(resolveDetailGradeRead(undefined, reportCards({ isLoading: true }))).toBe("pending");
  });

  it("is failed when the read errored without data", () => {
    expect(resolveDetailGradeRead(undefined, reportCards({ error: new Error("x"), isLoading: true }))).toBe("failed");
  });

  it("is settled when the response arrived without this coin (a real not-scored finding)", () => {
    expect(resolveDetailGradeRead(undefined, reportCards({ hasData: true }))).toBe("settled");
    expect(resolveDetailGradeRead(undefined, reportCards({ isLoading: false }))).toBe("settled");
  });
});
