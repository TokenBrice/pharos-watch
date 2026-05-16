import { describe, expect, it } from "vitest";
import {
  INDEXABLE_DEPEG_EVENT_LIMIT,
  hasDedicatedDepegEventPage,
  selectIndexableDepegEvents,
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
});
