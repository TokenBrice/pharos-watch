import { describe, expect, it } from "vitest";
import { buildMergedCemetery, frozenToDeadShape } from "../cemetery-merged";
import { DEAD_STABLECOINS } from "../dead-stablecoins";
import { FROZEN_STABLECOINS } from "../stablecoins";

describe("buildMergedCemetery", () => {
  it("contains every dead-stablecoins entry and every frozen-derived entry", () => {
    const merged = buildMergedCemetery();
    expect(merged.length).toBe(DEAD_STABLECOINS.length + FROZEN_STABLECOINS.length);
  });

  it("each entry has the DeadStablecoin shape", () => {
    for (const entry of buildMergedCemetery()) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("epitaph");
      expect(entry).toHaveProperty("deathDate");
      expect(entry).toHaveProperty("obituary");
      expect(entry).toHaveProperty("sourceUrl");
      expect(entry).toHaveProperty("sourceLabel");
    }
  });

  it("frozen-derived entries carry archivedDataAvailable: true", () => {
    const merged = buildMergedCemetery();
    const frozenIds = new Set(FROZEN_STABLECOINS.map((c) => c.id));
    for (const entry of merged) {
      if (frozenIds.has(entry.id)) {
        expect(entry.archivedDataAvailable).toBe(true);
      } else {
        expect(entry.archivedDataAvailable).toBeUndefined();
      }
    }
  });

  it("frozenToDeadShape projects obituary fields and flags archive availability", () => {
    const sample = FROZEN_STABLECOINS[0];
    if (!sample) {
      // No frozen coins yet — assert the function throws on a missing-obituary fixture.
      expect(() =>
        frozenToDeadShape({
          id: "synthetic-frozen",
          name: "Synthetic",
          symbol: "SYN",
          flags: { pegCurrency: "USD" },
          contracts: undefined,
          obituary: undefined,
        } as unknown as Parameters<typeof frozenToDeadShape>[0]),
      ).toThrow(/missing obituary/);
      return;
    }
    const result = frozenToDeadShape(sample);
    expect(result.id).toBe(sample.id);
    expect(result.archivedDataAvailable).toBe(true);
  });
});
