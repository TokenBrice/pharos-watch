import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("never exceeds the configured in-flight cap", async () => {
    const cap = 3;
    const itemCount = 12;
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency(Array.from({ length: itemCount }, (_, i) => i), cap, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Stagger completion so workers really overlap.
      await new Promise((resolve) => setTimeout(resolve, n % 3));
      inFlight -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(cap);
    expect(peak).toBe(cap); // we created enough work to saturate the pool
    expect(results).toEqual(Array.from({ length: itemCount }, (_, i) => i * 2));
  });

  it("preserves input order in the results array", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const results = await mapWithConcurrency(items, 2, async (item, index) => {
      // Reverse the natural completion order so unordered scheduling can't masquerade.
      await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 2));
      return item.toUpperCase();
    });
    expect(results).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns an empty array when there are no items", async () => {
    const results = await mapWithConcurrency([], 4, async () => "unused");
    expect(results).toEqual([]);
  });

  it("rejects with the first task error and stops scheduling new work", async () => {
    const started: number[] = [];
    const cap = 2;
    const items = [0, 1, 2, 3, 4, 5];

    await expect(
      mapWithConcurrency(items, cap, async (i) => {
        started.push(i);
        if (i === 1) throw new Error("boom");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return i;
      }),
    ).rejects.toThrow("boom");

    // Tasks 0 and 1 must have started (initial pool fill); later items should not all have run.
    expect(started).toContain(0);
    expect(started).toContain(1);
    expect(started.length).toBeLessThan(items.length);
  });

  it("rejects when maxInFlight is not a positive integer", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], Number.NaN, async (n) => n)).rejects.toThrow(RangeError);
  });
});
