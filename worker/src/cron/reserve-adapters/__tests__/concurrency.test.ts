import { describe, expect, it } from "vitest";
import { createAdapterIoLimiter, runAdapterIo } from "../concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reserve adapter I/O limiter", () => {
  it("limits concurrent adapter I/O to the configured peak", async () => {
    const limiter = createAdapterIoLimiter(2);
    const started: number[] = [];
    const resolvers: Array<() => void> = [];
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 4 }, (_, index) =>
      runAdapterIo({ ioLimiter: limiter }, `task:${index}`, async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          resolvers[index] = resolve;
        });
        active -= 1;
        return index;
      }));

    await tick();
    expect(started).toEqual([0, 1]);
    expect(peak).toBe(2);

    resolvers[0]();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    resolvers[1]();
    resolvers[2]();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    resolvers[3]();

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
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
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    let active = 0;
    let peak = 0;

    const runTask = (label: string) =>
      runAdapterIo({ ioLimiter: limiter }, label, async () => {
        started.push(label);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          resolvers.set(label, resolve);
        });
        active -= 1;
        return label;
      });

    const first = runTask("first");
    const second = runTask("second");

    await tick();
    expect(started).toEqual(["first"]);

    resolvers.get("first")?.();
    let third: Promise<string> | undefined;
    queueMicrotask(() => {
      third = runTask("third");
    });

    await tick();
    expect(started).toEqual(["first", "second"]);
    expect(peak).toBe(1);

    resolvers.get("second")?.();
    await tick();
    expect(started).toEqual(["first", "second", "third"]);
    expect(peak).toBe(1);

    resolvers.get("third")?.();
    if (!third) {
      throw new Error("third task was not scheduled");
    }
    await expect(Promise.all([first, second, third])).resolves.toEqual(["first", "second", "third"]);
  });

  it("rejects queued work when the adapter attempt aborts", async () => {
    const limiter = createAdapterIoLimiter(1);
    const controller = new AbortController();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = runAdapterIo({ ioLimiter: limiter }, "first", async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    const second = runAdapterIo({ ioLimiter: limiter, abortSignal: controller.signal }, "second", async () => {
      order.push("second");
      return "second";
    });

    await tick();
    controller.abort(new Error("adapter-timeout"));

    await expect(second).rejects.toThrow("adapter-timeout");
    expect(order).toEqual(["first"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    expect(order).toEqual(["first"]);
  });
});
