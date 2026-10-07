import { afterEach, describe, expect, it, vi } from "vitest";
import { settleAfterAbort } from "../cron-abort-settlement";

describe("shared abort settlement", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("does not admit pre-aborted work", async () => {
    const ac = new AbortController(); ac.abort("parent-abort");
    const work = vi.fn();
    expect(await settleAfterAbort(work, ac.signal)).toEqual({ status: "aborted", reason: "parent-abort", settled: true });
    expect(work).not.toHaveBeenCalled();
  });
  it("returns ordinary fulfillment and rejection with listener cleanup", async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    expect(await settleAfterAbort(async () => 4, ac.signal)).toEqual({ status: "fulfilled", value: 4 });
    const error = new Error("failed");
    expect(await settleAfterAbort(async () => { throw error; }, ac.signal)).toEqual({ status: "rejected", error });
    expect(remove.mock.calls.map((call) => call[1])).toEqual(add.mock.calls.map((call) => call[1]));
  });
  it.each([999, 1000, 1001])("drains inner grace boundary at %s ms but never accepts post-abort success", async (delay) => {
    vi.useFakeTimers(); const ac = new AbortController();
    const promise = settleAfterAbort(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), delay)), ac.signal);
    await vi.advanceTimersByTimeAsync(0); ac.abort("lost");
    await vi.advanceTimersByTimeAsync(1001);
    expect(await promise).toEqual({ status: "aborted", reason: "lost", settled: delay <= 1000 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("derives the outer 250ms observation margin", async () => {
    vi.useFakeTimers(); const ac = new AbortController();
    const promise = settleAfterAbort(() => new Promise<void>((resolve) => setTimeout(resolve, 1200)), ac.signal, { observer: true });
    await vi.advanceTimersByTimeAsync(0); ac.abort("timeout");
    await vi.advanceTimersByTimeAsync(1200);
    expect(await promise).toEqual({ status: "aborted", reason: "timeout", settled: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds uncooperative work observation by the platform deadline and observes late rejection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const ac = new AbortController();
    let reject!: (error: unknown) => void;
    const promise = settleAfterAbort(() => new Promise<void>((_resolve, fail) => { reject = fail; }), ac.signal,
      { observer: true, platformDeadlineMs: 1100 });
    await vi.advanceTimersByTimeAsync(0); ac.abort("deadline");
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toEqual({ status: "aborted", reason: "deadline", settled: false });
    reject(new Error("late rejection")); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a rejected drain diagnostic without losing abort reason", async () => {
    const ac = new AbortController(); const error = new Error("drain failed");
    const promise = settleAfterAbort(async () => { ac.abort("observer-failed"); throw error; }, ac.signal);
    expect(await promise).toEqual({ status: "aborted", reason: "observer-failed", settled: true, error });
  });
});
