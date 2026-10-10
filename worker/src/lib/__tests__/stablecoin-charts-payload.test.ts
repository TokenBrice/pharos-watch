import { describe, expect, it } from "vitest";
import { StablecoinChartResponseSchema } from "@shared/types/market";
import { normalizeStablecoinChartBuckets, normalizeStablecoinChartPoints } from "../stablecoin-charts-payload";

describe("stablecoin chart bucket availability", () => {
  it("preserves malformed observations as null through normalization and the public schema", () => {
    const normalized = normalizeStablecoinChartPoints([
      { date: 100, totalCirculatingUSD: { peggedEUR: 6_000_000, peggedJPY: 1_000_000 } },
      { date: 200, totalCirculatingUSD: { peggedEUR: "bad-read", peggedJPY: Infinity } },
      { date: 300, totalCirculatingUSD: { peggedEUR: 0, peggedJPY: "0" } },
    ]);
    expect(normalized).toEqual([
      { date: 100, totalCirculatingUSD: { peggedEUR: 6_000_000, peggedJPY: 1_000_000 } },
      { date: 200, totalCirculatingUSD: { peggedEUR: null, peggedJPY: null } },
      { date: 300, totalCirculatingUSD: { peggedEUR: 0, peggedJPY: 0 } },
    ]);
    expect(StablecoinChartResponseSchema.parse(normalized)).toEqual(normalized);
    expect(normalizeStablecoinChartPoints(normalized)).toEqual(normalized);
  });

  it("does not invent zero for absent, blank, negative, or rejected buckets", () => {
    expect(normalizeStablecoinChartBuckets({ peggedEUR: 1_000_000, peggedJPY: "bad-read" })).toEqual({ peggedEUR: 1_000_000, peggedJPY: null });
    expect(normalizeStablecoinChartBuckets({ blank: "", negative: -1, missing: null })).toEqual({ blank: null, negative: null, missing: null });
    expect(normalizeStablecoinChartBuckets({})).toBeNull();
    expect(normalizeStablecoinChartBuckets(undefined)).toBeNull();
    expect(StablecoinChartResponseSchema.safeParse([{ date: 100, totalCirculatingUSD: { invalid: -1 } }]).success).toBe(false);
  });

  it("preserves each point's provider census without importing buckets from another era", () => {
    expect(normalizeStablecoinChartPoints([
      { date: 100, totalCirculatingUSD: { peggedEUR: 1_000_000, peggedJPY: 1_000_000 } },
      { date: 200, totalCirculatingUSD: { peggedEUR: 1_000_000 } },
      { date: 300, totalCirculatingUSD: { peggedEUR: 1_000_000, peggedJPY: 0 } },
    ])).toEqual([
      { date: 100, totalCirculatingUSD: { peggedEUR: 1_000_000, peggedJPY: 1_000_000 } },
      { date: 200, totalCirculatingUSD: { peggedEUR: 1_000_000 } },
      { date: 300, totalCirculatingUSD: { peggedEUR: 1_000_000, peggedJPY: 0 } },
    ]);
  });
});
