import { afterEach, describe, expect, it, vi } from "vitest";
import { abortError, sleepWithSignal, throwIfAborted } from "../abort";

describe("abort helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds abort errors from error, string, and default reasons", () => {
    const errorController = new AbortController();
    errorController.abort(new Error("boom"));
    expect(abortError(errorController.signal).message).toBe("boom");

    const stringController = new AbortController();
    stringController.abort("stopped");
    expect(abortError(stringController.signal).message).toBe("stopped");

    expect(abortError().message).toBe("Operation aborted");
  });

  it("throws only when the signal is aborted", () => {
    expect(() => throwIfAborted()).not.toThrow();

    const controller = new AbortController();
    controller.abort("nope");
    expect(() => throwIfAborted(controller.signal)).toThrow("nope");
  });

  it("returns immediately for non-positive sleeps and resolves timed waits", async () => {
    await expect(sleepWithSignal(0)).resolves.toBeUndefined();

    vi.useFakeTimers();
    const promise = sleepWithSignal(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects a pending sleep when the signal aborts", async () => {
    const controller = new AbortController();
    const promise = sleepWithSignal(1_000, controller.signal);
    controller.abort("cancelled");

    await expect(promise).rejects.toThrow("cancelled");
  });
});
