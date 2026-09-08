import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES as merged, frozenToDeadShape } from "@shared/lib/cemetery-merged";
import { DEAD_STABLECOINS } from "../dead-stablecoins";
import { FROZEN_STABLECOINS } from "../stablecoins/registry";

describe("buildMergedCemetery", () => {
  it("contains every dead-stablecoins entry and every frozen-derived entry", () => {
    expect(merged.map((coin) => coin.id).sort()).toEqual(
      [...DEAD_STABLECOINS, ...FROZEN_STABLECOINS].map((coin) => coin.id).sort(),
    );
  });

  it("each entry has the DeadStablecoin shape", () => {
    for (const entry of merged) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("epitaph");
      expect(entry).toHaveProperty("deathDate");
      expect(entry).toHaveProperty("obituary");
      expect(entry).toHaveProperty("sourceUrl");
      expect(entry).toHaveProperty("sourceLabel");
    }
  });

  it("frozen-derived entries carry archivedDataAvailable: true", () => {
    const frozenIds = new Set(FROZEN_STABLECOINS.map((c) => c.id));
    for (const entry of merged) {
      if (frozenIds.has(entry.id)) {
        expect(entry.archivedDataAvailable).toBe(true);
      } else {
        expect(entry.archivedDataAvailable).toBeUndefined();
      }
    }
  });

  it("projects synthetic obituary content independently of the catalog", () => {
    const result = frozenToDeadShape({
      id: "synthetic-frozen", name: "Synthetic", symbol: "SYN",
      flags: { pegCurrency: "EUR" },
      obituary: {
        deathDate: "2026-01-01", epitaph: "Closed", obituary: "Redemptions ended.",
        causeOfDeath: "abandoned", peakMcap: 12345,
        sourceUrl: "https://example.com/closure", sourceLabel: "Closure notice",
      },
    } as Parameters<typeof frozenToDeadShape>[0]);
    expect(result).toMatchObject({
      id: "synthetic-frozen", name: "Synthetic", symbol: "SYN", pegCurrency: "EUR",
      deathDate: "2026-01-01", epitaph: "Closed", obituary: "Redemptions ended.",
      causeOfDeath: "abandoned", peakMcap: 12345,
      sourceUrl: "https://example.com/closure", sourceLabel: "Closure notice",
      archivedDataAvailable: true,
    });
  });

  it("rejects a frozen coin without obituary data", () => {
    expect(() => frozenToDeadShape({
      id: "synthetic-frozen", obituary: undefined,
    } as unknown as Parameters<typeof frozenToDeadShape>[0])).toThrow(/missing obituary/);
  });

  it("preserves registered tracked logos in the merged catalog", () => {
    expect(merged.find((coin) => coin.id === "eurr-stablr")?.logo).toBe("/logos/239-eurr.png");
    expect(merged.find((coin) => coin.id === "msy-main-street")?.logo).toBe("/logos/msy-main-street.png");
  });

  it("falls back to the legacy cemetery logo heuristic when no tracked logo is registered", () => {
    const result = frozenToDeadShape({
      id: "synthetic-frozen",
      name: "Synthetic",
      symbol: "SYN",
      llamaId: "123",
      flags: { pegCurrency: "USD" },
      contracts: undefined,
      obituary: {
        deathDate: "2026-01-01",
        epitaph: "Synthetic epitaph",
        obituary: "Synthetic obituary",
        causeOfDeath: "abandoned",
        sourceUrl: "https://example.com",
        sourceLabel: "Example",
      },
    } as unknown as Parameters<typeof frozenToDeadShape>[0]);

    expect(result.logo).toBe("/logos/123-syn.png");
  });
});
