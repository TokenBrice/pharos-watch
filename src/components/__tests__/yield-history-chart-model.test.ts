import { describe, expect, it } from "vitest";
import {
  PRESET_DAYS,
  deriveYieldSourceSegments,
  getYieldHistorySourceDisplayLabel,
} from "@/components/yield-history-chart-model";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";

it("uses the shared public history window for the longest chart preset", () => {
  expect(PRESET_DAYS.at(-1)).toBe(YIELD_HISTORY_MAX_DAYS);
});

describe("yield history chart source display", () => {
  it("disambiguates duplicate source names with source identity", () => {
    const sources = [
      { sourceKey: "aave-v3:ethereum:usdc", yieldSource: "Aave V3" },
      { sourceKey: "aave-v3:base:usdc", yieldSource: "Aave V3" },
      { sourceKey: "compound-v3:base:usdc", yieldSource: "Compound V3" },
    ];

    expect(getYieldHistorySourceDisplayLabel(sources[0], sources)).toBe("Aave V3 (...thereum:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[1], sources)).toBe("Aave V3 (...v3:base:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[2], sources)).toBe("Compound V3");
  });
});

describe("deriveYieldSourceSegments", () => {
  it("returns a single segment spanning the full range when one source is present", () => {
    const segments = deriveYieldSourceSegments([
      { ts: 1_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 2_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 3_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startTs: 1_000,
      endTs: 3_000,
      sourceKey: "aave-v3",
      sourceLabel: "Aave V3",
      isOther: false,
    });
    expect(segments[0].color).toMatch(/^bg-/);
  });

  it("splits at each source switch and preserves boundaries", () => {
    const segments = deriveYieldSourceSegments([
      { ts: 1_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 2_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 3_000, sourceKey: "compound-v3", sourceLabel: "Compound V3" },
      { ts: 4_000, sourceKey: "compound-v3", sourceLabel: "Compound V3" },
      { ts: 5_000, sourceKey: "morpho", sourceLabel: "Morpho" },
      { ts: 6_000, sourceKey: "morpho", sourceLabel: "Morpho" },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ startTs: 1_000, endTs: 2_000, sourceKey: "aave-v3" });
    expect(segments[1]).toMatchObject({ startTs: 3_000, endTs: 4_000, sourceKey: "compound-v3" });
    expect(segments[2]).toMatchObject({ startTs: 5_000, endTs: 6_000, sourceKey: "morpho" });
  });

  it("collapses sources beyond the top-5 cap into an 'other' lane", () => {
    const history = [
      { ts: 1, sourceKey: "src-a", sourceLabel: "Source A" },
      { ts: 2, sourceKey: "src-b", sourceLabel: "Source B" },
      { ts: 3, sourceKey: "src-c", sourceLabel: "Source C" },
      { ts: 4, sourceKey: "src-d", sourceLabel: "Source D" },
      { ts: 5, sourceKey: "src-e", sourceLabel: "Source E" },
      { ts: 6, sourceKey: "src-f", sourceLabel: "Source F" },
      { ts: 7, sourceKey: "src-g", sourceLabel: "Source G" },
    ];
    const segments = deriveYieldSourceSegments(history);

    expect(segments).toHaveLength(7);
    const topKeys = segments.slice(0, 5).map((segment) => segment.sourceKey);
    expect(topKeys).toEqual(["src-a", "src-b", "src-c", "src-d", "src-e"]);
    expect(segments[5]).toMatchObject({ sourceKey: "other", sourceLabel: "other", isOther: true });
    expect(segments[6]).toMatchObject({ sourceKey: "other", sourceLabel: "other", isOther: true });
    expect(segments[5].color).toBe(segments[6].color);
  });
});
