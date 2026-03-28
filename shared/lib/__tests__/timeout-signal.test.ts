import { describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, raceWithTimeout } from "../timeout-signal";

describe("createTimeoutSignal", () => {
  it("aborts after the configured timeout and marks the timeout flag", async () => {
    vi.useFakeTimers();
    const handle = createTimeoutSignal({
      timeoutMs: 1_000,
      timeoutReason: "timed out",
    });

    expect(handle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.isTimedOut()).toBe(true);
    handle.dispose();
    vi.useRealTimers();
  });

  it("propagates parent aborts without marking the timeout flag", () => {
    const parent = new AbortController();
    const handle = createTimeoutSignal({
      timeoutMs: 5_000,
      timeoutReason: "timed out",
      parentSignal: parent.signal,
    });

    parent.abort(new Error("parent-abort"));

    expect(handle.signal.aborted).toBe(true);
    expect(handle.isTimedOut()).toBe(false);
    handle.dispose();
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
    vi.useRealTimers();
  });
});
