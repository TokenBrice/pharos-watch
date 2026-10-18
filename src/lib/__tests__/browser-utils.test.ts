// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleIdle } from "@/lib/browser-utils";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("cancelIdleCallback", undefined);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16)));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((handle: number) => window.clearTimeout(handle)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scheduleIdle", () => {
  it("uses the idle timeout as a deadline, not a fixed delay, when rIC exists", () => {
    const requestIdleCallback = vi.fn((_callback: IdleRequestCallback, _options?: IdleRequestOptions) => 7);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const callback = vi.fn();

    const cancel = scheduleIdle(callback, { timeoutMs: 2_500, fallbackDelayMs: 150 });
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2_500 });
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    requestIdleCallback.mock.calls[0]![0]({ didTimeout: false, timeRemaining: () => 50 });
    expect(callback).toHaveBeenCalledOnce();
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("activates after two paints and the short fallback delay without rIC", () => {
    const callback = vi.fn();
    scheduleIdle(callback, { timeoutMs: 2_500, fallbackDelayMs: 150 });
    vi.advanceTimersByTime(181);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_500);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("keeps a separately requested long analytics fallback delay", () => {
    const callback = vi.fn();
    scheduleIdle(callback, { timeoutMs: 2_000, fallbackDelayMs: 2_000 });
    vi.advanceTimersByTime(2_031);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([0, 16, 40])("cancels before either paint or the fallback timer (%i ms)", (elapsed) => {
    const callback = vi.fn();
    const cancel = scheduleIdle(callback, { timeoutMs: 2_500, fallbackDelayMs: 150 });
    vi.advanceTimersByTime(elapsed);
    cancel();
    if (elapsed >= 32) expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not cancel consumed handles after the callback has run", () => {
    const callback = vi.fn();
    const cancel = scheduleIdle(callback, { timeoutMs: 2_500, fallbackDelayMs: 150 });
    vi.advanceTimersByTime(182);
    cancel();
    expect(callback).toHaveBeenCalledOnce();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("retains the matching frame cancellation API if browser globals change", () => {
    const cancelFrame = window.cancelAnimationFrame;
    const cancel = scheduleIdle(vi.fn(), { timeoutMs: 2_500, fallbackDelayMs: 150 });
    const replacementCancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", replacementCancelFrame);
    cancel();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(replacementCancelFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
  });
});
