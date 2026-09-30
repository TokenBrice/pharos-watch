import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES as merged, frozenToDeadShape, resolveCemeteryLogoUrl } from "@shared/lib/cemetery-merged";
import { DEAD_STABLECOINS } from "../dead-stablecoins";
import { FROZEN_STABLECOINS } from "../stablecoins/registry";
import { parseDeadStablecoinAssets, StablecoinMetaAssetSchema } from "../stablecoins/schema";
import { MECHANISM_ARCHETYPE_VALUES } from "../../types/stablecoin-taxonomy";
import { isValidIsoDateOnly } from "../../types/date-primitives";

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

  it("maps a frozen row's mechanism archetype and freeze date onto the entry", () => {
    const result = frozenToDeadShape({
      id: "synthetic-frozen", name: "Synthetic", symbol: "SYN",
      flags: { pegCurrency: "USD" },
      mechanismArchetype: "cdp",
      frozenAt: "2026-07-11",
      obituary: {
        deathDate: "2026-06", epitaph: "Closed", obituary: "Redemptions ended.",
        causeOfDeath: "abandoned",
        sourceUrl: "https://example.com/closure", sourceLabel: "Closure notice",
      },
    } as Parameters<typeof frozenToDeadShape>[0]);
    expect(result).toMatchObject({ mechanismArchetype: "cdp", recordedAt: "2026-07-11" });
  });

  it("leaves archetype and recordedAt absent when the frozen row has none, and rejects an invalid freeze date", () => {
    const base = {
      id: "synthetic-frozen", name: "Synthetic", symbol: "SYN",
      flags: { pegCurrency: "USD" },
      obituary: {
        deathDate: "2026-06", epitaph: "Closed", obituary: "Redemptions ended.",
        causeOfDeath: "abandoned",
        sourceUrl: "https://example.com/closure", sourceLabel: "Closure notice",
      },
    } as Parameters<typeof frozenToDeadShape>[0];
    const result = frozenToDeadShape(base);
    expect(result.mechanismArchetype).toBeUndefined();
    expect(result.recordedAt).toBeUndefined();
    expect(() => frozenToDeadShape({ ...base, frozenAt: "2026-02-30" })).toThrow(/invalid frozenAt/);
  });

  it("uses the explicit cemetery date before falling back to the freeze date", () => {
    const recordedAtById = new Map(FROZEN_STABLECOINS.map((coin) => [coin.id, coin.obituary?.recordedAt ?? coin.frozenAt]));
    const tracked = merged.filter((entry) => entry.archivedDataAvailable === true);
    expect(tracked).toHaveLength(FROZEN_STABLECOINS.length);
    for (const entry of tracked) {
      expect(entry.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.recordedAt).toBe(recordedAtById.get(entry.id));
    }
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

  it("requires a real recorded date for every curated asset and validates authored archetypes", () => {
    for (const entry of DEAD_STABLECOINS) {
      expect(isValidIsoDateOnly(entry.recordedAt ?? ""), entry.id).toBe(true);
      expect(MECHANISM_ARCHETYPE_VALUES, entry.id).toContain(entry.mechanismArchetype);
    }
    const { recordedAt: _date, ...withoutDate } = DEAD_STABLECOINS[0];
    expect(() => parseDeadStablecoinAssets([withoutDate], "fixture")).toThrow(/recordedAt/);
    expect(() => parseDeadStablecoinAssets([{ ...withoutDate, recordedAt: "2026-02-30" }], "fixture")).toThrow(/recordedAt/);
    expect(() => parseDeadStablecoinAssets([{ ...DEAD_STABLECOINS[0], mechanismArchetype: "unknown" }], "fixture")).toThrow(/mechanismArchetype/);
  });

  it("keeps every merged date valid and leaves only explicitly unclassified BUCK without an archetype", () => {
    for (const entry of merged) {
      expect(isValidIsoDateOnly(entry.recordedAt ?? ""), entry.id).toBe(true);
      if (entry.mechanismArchetype !== undefined) {
        expect(MECHANISM_ARCHETYPE_VALUES, entry.id).toContain(entry.mechanismArchetype);
      }
    }
    expect(merged.filter((entry) => entry.mechanismArchetype === undefined).map((entry) => entry.id)).toEqual(["buck-buck-assets"]);
  });

  it.each([
    ["dusd-fluid", "2026-09-04", "2024-04-22"],
    ["ist-agoric", "2026-06-21", "2025-06-26"],
  ])("separates %s cemetery entry date from the preserved freeze date", (id, recordedAt, frozenAt) => {
    expect(merged.find((entry) => entry.id === id)?.recordedAt).toBe(recordedAt);
    expect(FROZEN_STABLECOINS.find((coin) => coin.id === id)?.frozenAt).toBe(frozenAt);
  });

  it("rejects invalid or imprecise obituary entry dates at the registry boundary", () => {
    const coin = FROZEN_STABLECOINS.find((entry) => entry.id === "dusd-fluid")!;
    for (const recordedAt of ["2026-02-30", "2026-09", "2026-09-04T00:00:00Z"]) {
      const result = StablecoinMetaAssetSchema.safeParse({ ...coin, obituary: { ...coin.obituary, recordedAt } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "obituary.recordedAt")).toBe(true);
      }
    }
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["ust.png", "/logos/cemetery/ust.png"],
    ["/logos/10-mim.png", "/logos/10-mim.png"],
  ])("resolves cemetery logo %s to %s", (logo, expected) => {
    expect(resolveCemeteryLogoUrl(logo)).toBe(expected);
  });
});
