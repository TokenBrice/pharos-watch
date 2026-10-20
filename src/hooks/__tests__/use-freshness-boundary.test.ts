// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { deriveDataHealth } from "@/lib/data-health";

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const savedAt = Date.parse("2026-09-06T12:00:00Z");
const input = {
  label: "Prices", dataUpdatedAt: savedAt, staleTime: 1000, hasData: true,
  meta: { updatedAt: savedAt / 1000, ageSeconds: 0, status: "fresh" as const, freshBudgetSec: 1, degradedBudgetSec: 2 },
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useFreshnessBoundary", () => {
  it("keeps the first render clock-free and commits the browser clock from its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const { result, unmount } = renderHook(() => useFreshnessBoundary([input]));
    expect(result.current).toBeUndefined();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe(savedAt);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ages unchanged evidence at inclusive effective budgets without fetching and cleans up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { result, unmount } = renderHook(() => deriveDataHealth(input, useFreshnessBoundary([input])));
    expect(result.current.state).toBe("fresh");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.state).toBe("fresh");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.state).toBe("degraded");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.state).toBe("stale");
    expect(fetch).not.toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reanchors on a new producer generation and policy even with a stable receipt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const { result, rerender, unmount } = renderHook(({ value }) => deriveDataHealth(value, useFreshnessBoundary([value])), { initialProps: { value: input } });
    act(() => vi.advanceTimersByTime(900));
    rerender({ value: { ...input, meta: { ...input.meta, updatedAt: (savedAt + 900) / 1000, freshBudgetSec: 2 } } });
    act(() => vi.advanceTimersByTime(101));
    expect(result.current.state).toBe("fresh");
    act(() => vi.advanceTimersByTime(1900));
    expect(result.current.state).toBe("stale");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an outstanding crossing when disabled or unmounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const { rerender, unmount } = renderHook(({ enabled }) => useFreshnessBoundary([input], enabled), { initialProps: { enabled: true } });
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(1);
    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps missing clocks unavailable, server warning floors, and future clocks intact", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const missing = { ...input, meta: { updatedAt: null, ageSeconds: null, status: "unknown" as const, reason: "producer-timestamp-unavailable" } };
    const { result, unmount } = renderHook(() => deriveDataHealth(missing, useFreshnessBoundary([missing])));
    expect(result.current.state).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    const future = { ...input, meta: { ...input.meta, updatedAt: (savedAt + 5000) / 1000, warning: "source delayed" } };
    const mounted = renderHook(() => deriveDataHealth(future, useFreshnessBoundary([future])));
    expect(mounted.result.current.state).toBe("degraded");
    act(() => vi.advanceTimersByTime(7001));
    expect(mounted.result.current.state).toBe("stale");
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires catch-up totals at their own producer boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    const catchingUp = { ...input, meta: { ...input.meta, updatedAt: (savedAt - 5000) / 1000 }, catchUp: { observedAt: savedAt / 1000, sources: [{ label: "Backfill", lastSucceededAt: null }] } };
    const { result, unmount } = renderHook(() => deriveDataHealth(catchingUp, useFreshnessBoundary([catchingUp])));
    expect(result.current.degradationReason).toBe("catch-up");
    act(() => vi.advanceTimersByTime(1001));
    expect(result.current.state).toBe("stale");
    expect(result.current.catchUp).toBeUndefined();
    unmount();
  });
});
