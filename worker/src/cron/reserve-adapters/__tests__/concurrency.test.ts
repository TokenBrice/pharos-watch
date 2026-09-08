import { describe, expect, it } from "vitest";
import { createAdapterIoLimiter, runAdapterIo } from "../concurrency";

function taskGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}


async function waitForStart(promise: Promise<void>) {
  // Real watchdog: a scheduling regression must unwind finally and drain blocked work.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Queued adapter task did not start")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
describe("reserve adapter I/O limiter", () => {
  it("limits concurrent adapter I/O to the configured peak", async () => {
    const limiter = createAdapterIoLimiter(2);
    const controller = new AbortController();
    const started: number[] = [];
    const starts = Array.from({ length: 4 }, taskGate);
    const releases = Array.from({ length: 4 }, taskGate);
    let active = 0;
    let peak = 0;
    const tasks = releases.map((release, index) =>
      runAdapterIo({ ioLimiter: limiter, abortSignal: controller.signal }, `task:${index}`, async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        starts[index].resolve();
        await release.promise;
        active -= 1;
        return index;
      }));
    const settled = Promise.allSettled(tasks);
    try {
      await waitForStart(starts[1].promise);
      expect(started).toEqual([0, 1]);
      expect(peak).toBe(2);
      releases[0].resolve();
      await waitForStart(starts[2].promise);
      expect(started).toEqual([0, 1, 2]);
      releases[1].resolve();
      releases[2].resolve();
      await waitForStart(starts[3].promise);
      expect(started).toEqual([0, 1, 2, 3]);
      releases[3].resolve();
      await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
      expect(peak).toBe(2);
    } finally {
      controller.abort();
      releases.forEach((release) => release.resolve());
      await settled;
    }
  });

  it("releases queued work after a rejected request", async () => {
    const limiter = createAdapterIoLimiter(1);
    const order: string[] = [];
    const first = runAdapterIo({ ioLimiter: limiter }, "first", async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = runAdapterIo({ ioLimiter: limiter }, "second", async () => {
      order.push("second");
      return "ok";
    });
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("hands a released slot to the queued waiter before accepting later callers", async () => {
    const limiter = createAdapterIoLimiter(1);
    const controller = new AbortController();
    const order: number[] = [];
    const starts = Array.from({ length: 3 }, taskGate);
    const releases = Array.from({ length: 3 }, taskGate);
    const runTask = (index: number) => runAdapterIo(
      { ioLimiter: limiter, abortSignal: controller.signal }, `task:${index}`, async () => {
        order.push(index);
        starts[index].resolve();
        await releases[index].promise;
        return index;
      },
    );
    const tasks = [runTask(0), runTask(1)];
    const settled = tasks.map((task) => Promise.allSettled([task]));
    try {
      await waitForStart(starts[0].promise);
      expect(order).toEqual([0]);
      releases[0].resolve();
      await new Promise<void>((resolve) => queueMicrotask(() => {
        const third = runTask(2);
        tasks.push(third);
        settled.push(Promise.allSettled([third]));
        resolve();
      }));
      await waitForStart(starts[1].promise);
      expect(order).toEqual([0, 1]);
      releases[1].resolve();
      await waitForStart(starts[2].promise);
      expect(order).toEqual([0, 1, 2]);
      releases[2].resolve();
      await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2]);
    } finally {
      controller.abort();
      releases.forEach((release) => release.resolve());
      await Promise.all(settled);
    }
  });

  it("rejects queued work when the adapter attempt aborts", async () => {
    const limiter = createAdapterIoLimiter(1);
    const controller = new AbortController();
    const order: string[] = [];
    const start = taskGate();
    const release = taskGate();
    const first = runAdapterIo({ ioLimiter: limiter }, "first", async () => {
      order.push("first");
      start.resolve();
      await release.promise;
      return "first";
    });
    const second = runAdapterIo({ ioLimiter: limiter, abortSignal: controller.signal }, "second", async () => {
      order.push("second");
      return "second";
    });
    const settled = Promise.allSettled([first, second]);
    try {
      await waitForStart(start.promise);
      controller.abort(new Error("adapter-timeout"));
      await expect(second).rejects.toThrow("adapter-timeout");
      expect(order).toEqual(["first"]);
      release.resolve();
      await expect(first).resolves.toBe("first");
      expect(order).toEqual(["first"]);
    } finally {
      controller.abort();
      release.resolve();
      await settled;
    }
  });
});
