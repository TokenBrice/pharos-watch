import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency";
import { createDeferredPromise } from "./deferred.test-support";

describe("mapWithConcurrency", () => {
  it("never exceeds the configured in-flight cap", async () => {
    const cap = 3;
    const itemCount = 12;
    let inFlight = 0;
    let peak = 0;

    const gates = Array.from({ length: itemCount }, () => createDeferredPromise());
    const started = Array.from({ length: itemCount }, () => createDeferredPromise());
    const pending = mapWithConcurrency(Array.from({ length: itemCount }, (_, i) => i), cap, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started[n].resolve();
      await gates[n].promise;
      inFlight -= 1;
      return n * 2;
    });
    for (let offset = 0; offset < itemCount; offset += cap) {
      await Promise.all(started.slice(offset, offset + cap).map((gate) => gate.promise));
      expect(inFlight).toBe(cap);
      for (let index = offset + cap - 1; index >= offset; index--) gates[index].resolve();
    }
    const results = await pending;

    expect(peak).toBeLessThanOrEqual(cap);
    expect(peak).toBe(cap); // we created enough work to saturate the pool
    expect(results).toEqual(Array.from({ length: itemCount }, (_, i) => i * 2));
  });

  it("preserves input order in the results array", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const gates = items.map(() => createDeferredPromise());
    const completed: string[] = [];
    const pending = mapWithConcurrency(items, items.length, async (item, index) => {
      await gates[index].promise;
      completed.push(item);
      return item.toUpperCase();
    });
    for (let index = items.length - 1; index >= 0; index--) {
      gates[index].resolve();
      await gates[index].promise;
    }
    const results = await pending;
    expect(completed).toEqual(["e", "d", "c", "b", "a"]);
    expect(results).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns an empty array when there are no items", async () => {
    const results = await mapWithConcurrency([], 4, async () => "unused");
    expect(results).toEqual([]);
  });

  it.each([
    [new Error("boom"), "boom"],
    [undefined, "mapWithConcurrency task rejected"],
  ])("stops scheduling and settles started work after rejection %s", async (error, message) => {
    const started: number[] = [];
    const gate = createDeferredPromise();
    let completed = false;
    const pending = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      if (i === 1) throw error;
      await gate.promise;
      completed = true;
      return i;
    });
    const rejected = expect(pending).rejects.toThrow(message);
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gate.resolve();
    await rejected;
    expect(completed).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it("throws before work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("queue aborted"));
    let started = 0;

    await expect(
      mapWithConcurrency([1, 2], 1, async (n) => {
        started += 1;
        return n;
      }, { signal: controller.signal }),
    ).rejects.toThrow("queue aborted");
    expect(started).toBe(0);
  });

  it("stops scheduling new work once the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
        started.push(n);
        if (n === 0) controller.abort(new Error("mid-run abort"));
        return n;
      }, { signal: controller.signal }),
    ).rejects.toThrow("mid-run abort");
    expect(started).toEqual([0]);
  });

  it("rejects when maxInFlight is not a positive integer", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], Number.NaN, async (n) => n)).rejects.toThrow(RangeError);
  });
});
