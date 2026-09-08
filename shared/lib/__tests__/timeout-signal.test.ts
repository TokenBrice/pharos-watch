import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, raceWithTimeout } from "@shared/lib/timeout-signal";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createTimeoutSignal", () => {
  it("aborts after the configured timeout and marks the timeout flag", async () => {
    vi.useFakeTimers();
    const handle = createTimeoutSignal({
      timeoutMs: 1_000,
      timeoutReason: "timed out",
    });

    try {
      expect(handle.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(handle.signal.aborted).toBe(true);
      expect(handle.isTimedOut()).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("propagates parent aborts without marking the timeout flag", () => {
    const parent = new AbortController();
    const handle = createTimeoutSignal({
      timeoutMs: 5_000,
      timeoutReason: "timed out",
      parentSignal: parent.signal,
    });

    try {
      parent.abort(new Error("parent-abort"));

      expect(handle.signal.aborted).toBe(true);
      expect(handle.isTimedOut()).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  it("disposes a pending deadline without aborting", async () => {
    vi.useFakeTimers();
    const handle = createTimeoutSignal({ timeoutMs: 1_000, timeoutReason: "deadline" });
    try {
      handle.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handle.signal.aborted).toBe(false);
      expect(handle.isTimedOut()).toBe(false);
    } finally {
      handle.dispose();
    }
  });
});

describe("raceWithTimeout", () => {
  it("rejects with the timeout reason when the operation does not finish in time", async () => {
    vi.useFakeTimers();
    const operation = new Promise<never>(() => {});
    const promise = raceWithTimeout(operation, 1_000, "timeout-reason");
    const assertion = expect(promise).rejects.toThrow("timeout-reason");

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });

  it("preserves an early fulfillment and clears its deadline", async () => {
    vi.useFakeTimers();
    const result = { value: 42 };
    await expect(raceWithTimeout(Promise.resolve(result), 1_000, "deadline")).resolves.toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an operation rejection and clears its deadline", async () => {
    vi.useFakeTimers();
    const error = new Error("operation failed");
    await expect(raceWithTimeout(Promise.reject(error), 1_000, "deadline")).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an Error deadline reason by identity", async () => {
    vi.useFakeTimers();
    const error = new Error("deadline");
    const assertion = expect(raceWithTimeout(new Promise<never>(() => {}), 1_000, error)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
