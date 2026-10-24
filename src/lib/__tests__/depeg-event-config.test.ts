import { describe, expect, it } from "vitest";
import {
  buildNoindexDepegEventSlugs,
  DEPEG_ARCHIVE_EPOCH_SECONDS,
  hasDedicatedDepegEventPage,
  isLowConfidenceDepegEvent,
  selectIndexableDepegEvents,
  selectStaticDepegEventPages,
} from "@/lib/depeg-event-config";

const EPOCH = DEPEG_ARCHIVE_EPOCH_SECONDS;

describe("depeg event indexing policy", () => {
  it("keeps every post-epoch event — the archive is grow-only", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      slug: `event-${String(index).padStart(2, "0")}`,
      startedAt: EPOCH + index,
    }));

    const selected = selectIndexableDepegEvents(events);

    expect(selected).toHaveLength(40);
    expect(selected[0].slug).toBe("event-39");
    expect(selected[selected.length - 1].slug).toBe("event-00");
  });

  it("excludes pre-epoch events unless pinned", () => {
    const selected = selectIndexableDepegEvents([
      { slug: "ancient-2024-01-01", startedAt: EPOCH - 86_400 },
      { slug: "recent-2026-05-01", startedAt: EPOCH + 86_400 },
    ]);

    expect(selected.map((event) => event.slug)).toEqual(["recent-2026-05-01"]);
  });

  it("keeps pinned events indexable when they predate the archive epoch", () => {
    const selected = selectIndexableDepegEvents([
      { slug: "usdc-2023-03-11", startedAt: 1_678_492_800 },
      { slug: "recent-2026-05-01", startedAt: EPOCH + 86_400 },
    ]);

    expect(selected.map((event) => event.slug)).toEqual([
      "recent-2026-05-01",
      "usdc-2023-03-11",
    ]);
  });

  it("uses absolute deviation magnitude for dedicated page eligibility", () => {
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: 500 })).toBe(true);
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: -500 })).toBe(true);
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: -499 })).toBe(false);
  });

  it("gates static pages on severity while preserving pinned editorials", () => {
    const selected = selectStaticDepegEventPages([
      { slug: "usdc-2023-03-11", startedAt: 1_678_492_800, peakDeviationBps: 1300 },
      { slug: "big-2026-03-01", startedAt: EPOCH + 100, peakDeviationBps: 600 },
      { slug: "small-2026-03-02", startedAt: EPOCH + 200, peakDeviationBps: 120 },
      { slug: "ancient-2025-06-01", startedAt: EPOCH - 100, peakDeviationBps: 900 },
    ]);

    expect(selected.map((event) => event.slug)).toEqual([
      "big-2026-03-01",
      "usdc-2023-03-11",
    ]);
  });
});

describe("depeg event noindex tier", () => {
  const DAY = EPOCH + 30 * 86_400;
  const event = (slug: string, overrides: Partial<{ stablecoinId: string; startedAt: number; peakDeviationBps: number; pendingReason: string | null }> = {}) => ({
    slug,
    stablecoinId: "coin-a",
    startedAt: DAY,
    peakDeviationBps: -600,
    pendingReason: null,
    ...overrides,
  });

  it("recognises low-confidence holds inside compound pending reasons", () => {
    expect(isLowConfidenceDepegEvent({ pendingReason: "confirmation-window+low-confidence" })).toBe(true);
    expect(isLowConfidenceDepegEvent({ pendingReason: "low-confidence" })).toBe(true);
    expect(isLowConfidenceDepegEvent({ pendingReason: "extreme-move+native-origin" })).toBe(false);
    expect(isLowConfidenceDepegEvent({ pendingReason: null })).toBe(false);
  });

  it("keeps the largest-peak event of a same-coin, same-day cluster and noindexes the rest", () => {
    const noindex = buildNoindexDepegEventSlugs([
      event("a-1", { startedAt: DAY + 60, peakDeviationBps: -700 }),
      event("a-2", { startedAt: DAY + 3_600, peakDeviationBps: 1_200 }),
      event("a-3", { startedAt: DAY + 7_200, peakDeviationBps: -800 }),
      event("a-next-day", { startedAt: DAY + 86_400, peakDeviationBps: -550 }),
      event("b-1", { stablecoinId: "coin-b", startedAt: DAY + 60, peakDeviationBps: -550 }),
    ]);

    expect([...noindex].sort()).toEqual(["a-1", "a-3"]);
  });

  it("noindexes low-confidence events and never picks one as the cluster lead", () => {
    const noindex = buildNoindexDepegEventSlugs([
      event("solo-low", { stablecoinId: "coin-c", pendingReason: "low-confidence" }),
      event("big-low", { peakDeviationBps: -2_000, pendingReason: "confirmation-window+low-confidence" }),
      event("small-trusted", { startedAt: DAY + 60, peakDeviationBps: -600 }),
    ]);

    expect([...noindex].sort()).toEqual(["big-low", "solo-low"]);
  });

  it("never noindexes a page with recent search impressions", () => {
    const noindex = buildNoindexDepegEventSlugs([
      event("kag-2026-06-14", { pendingReason: "low-confidence" }),
      event("usdp-2026-05-06", { peakDeviationBps: -550 }),
      event("bigger-sibling", { peakDeviationBps: -900 }),
    ]);

    expect([...noindex]).toEqual([]);
  });
});
