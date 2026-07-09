import { describe, expect, it } from "vitest";
import {
  DEPEG_ARCHIVE_EPOCH_SECONDS,
  hasDedicatedDepegEventPage,
  selectIndexableDepegEvents,
  selectStaticDepegEventPages,
} from "./config";

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

  it("breaks same-second ties by slug", () => {
    const selected = selectIndexableDepegEvents([
      { slug: "z-last", startedAt: EPOCH + 1 },
      { slug: "a-first", startedAt: EPOCH + 1 },
    ]);

    expect(selected.map((event) => event.slug)).toEqual(["a-first", "z-last"]);
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
