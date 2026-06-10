import { describe, expect, it } from "vitest";
import {
  INDEXABLE_DEPEG_EVENT_LIMIT,
  hasDedicatedDepegEventPage,
  selectIndexableDepegEvents,
  selectStaticDepegEventPages,
} from "./config";

describe("depeg event indexing policy", () => {
  it("selects the newest deterministic archive set", () => {
    const events = Array.from({ length: INDEXABLE_DEPEG_EVENT_LIMIT + 2 }, (_, index) => ({
      slug: `event-${String(index).padStart(2, "0")}`,
      startedAt: 1_700_000_000 + index,
    }));

    const selected = selectIndexableDepegEvents(events);

    expect(selected).toHaveLength(INDEXABLE_DEPEG_EVENT_LIMIT);
    expect(selected.map((event) => event.slug)).toEqual([
      "event-13",
      "event-12",
      "event-11",
      "event-10",
      "event-09",
      "event-08",
      "event-07",
      "event-06",
      "event-05",
      "event-04",
      "event-03",
      "event-02",
    ]);
  });

  it("keeps pinned events indexable when they fall outside the recency window", () => {
    const events = Array.from({ length: INDEXABLE_DEPEG_EVENT_LIMIT + 3 }, (_, index) => ({
      slug: `event-${String(index).padStart(2, "0")}`,
      startedAt: 1_700_000_000 + index,
    }));
    events.unshift({ slug: "usdc-2023-03-11", startedAt: 1_678_492_800 });

    const selected = selectIndexableDepegEvents(events);

    expect(selected).toHaveLength(INDEXABLE_DEPEG_EVENT_LIMIT + 1);
    expect(selected.map((event) => event.slug)).toContain("usdc-2023-03-11");
  });

  it("breaks same-second ties by slug", () => {
    const selected = selectIndexableDepegEvents([
      { slug: "z-last", startedAt: 1 },
      { slug: "a-first", startedAt: 1 },
    ]);

    expect(selected.map((event) => event.slug)).toEqual(["a-first", "z-last"]);
  });

  it("uses absolute deviation magnitude for dedicated page eligibility", () => {
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: 500 })).toBe(true);
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: -500 })).toBe(true);
    expect(hasDedicatedDepegEventPage({ peakDeviationBps: -499 })).toBe(false);
  });

  it("keeps static event pages bounded while preserving pinned editorials", () => {
    const events = Array.from({ length: INDEXABLE_DEPEG_EVENT_LIMIT + 3 }, (_, index) => ({
      slug: `event-${String(index).padStart(2, "0")}`,
      startedAt: 1_700_000_000 + index,
      peakDeviationBps: 500,
    }));
    events.unshift({
      slug: "usdc-2023-03-11",
      startedAt: 1_678_492_800,
      peakDeviationBps: 1300,
    });

    const selected = selectStaticDepegEventPages(events);

    expect(selected).toHaveLength(INDEXABLE_DEPEG_EVENT_LIMIT + 1);
    expect(selected.map((event) => event.slug)).toContain("usdc-2023-03-11");
    expect(selected.map((event) => event.slug)).not.toContain("event-00");
    expect(selected.map((event) => event.slug)).not.toContain("event-01");
    expect(selected.map((event) => event.slug)).not.toContain("event-02");
  });
});
