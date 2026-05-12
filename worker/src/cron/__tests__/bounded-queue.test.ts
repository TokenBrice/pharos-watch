import { describe, expect, it } from "vitest";
import { runBoundedQueue } from "../shared/bounded-queue";

describe("runBoundedQueue", () => {
  it("preserves result ordering while bounding concurrency", async () => {
    let active = 0;
    let peak = 0;

    const results = await runBoundedQueue({
      items: [1, 2, 3, 4],
      concurrency: 2,
      worker: async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, item === 1 ? 10 : 0));
        active -= 1;
        return item * 10;
      },
    });

    expect(results).toEqual([10, 20, 30, 40]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("reports progress after each completed item", async () => {
    const progress: number[] = [];

    await runBoundedQueue({
      items: ["a", "b"],
      concurrency: 1,
      worker: async (item) => item,
      onProgress: ({ completed }) => {
        progress.push(completed);
      },
    });

    expect(progress).toEqual([1, 2]);
  });

  it("throws before work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("queue aborted"));

    await expect(
      runBoundedQueue({
        items: [1],
        concurrency: 1,
        signal: controller.signal,
        worker: async (item) => item,
      }),
    ).rejects.toThrow("queue aborted");
  });
});
