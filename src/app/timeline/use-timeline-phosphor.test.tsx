// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, resetBrowserStorage } from "@/test-utils/frontend";
import { useTimelinePhosphor } from "./use-timeline-phosphor";

const { themeState } = vi.hoisted(() => ({ themeState: { theme: "system", resolvedTheme: "dark" as string | undefined } }));
vi.mock("next-themes", () => ({ useTheme: () => ({ ...themeState, setTheme: vi.fn() }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
const STORAGE_KEY = "pharos:timeline-phosphor";

beforeEach(() => {
  resetBrowserStorage();
  themeState.resolvedTheme = "dark";
  window.localStorage.setItem(STORAGE_KEY, "1");
});
afterEach(() => {
  cleanupFrontendTest();
  resetBrowserStorage();
});

describe("useTimelinePhosphor", () => {
  it("does not clear the preference before the rendered theme resolves", () => {
    themeState.resolvedTheme = undefined;
    const { result, rerender } = renderHook(() => useTimelinePhosphor());
    expect(result.current.phosphorToggleVisible).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
    themeState.resolvedTheme = "dark";
    rerender();
    expect(result.current.phosphorActive).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("preserves the saved phosphor preference when System resolves dark", () => {
    const { result } = renderHook(() => useTimelinePhosphor());
    expect(result.current.phosphorActive).toBe(true);
    expect(result.current.phosphorToggleVisible).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("clears phosphor only when the rendered system theme becomes light", () => {
    const { result, rerender } = renderHook(() => useTimelinePhosphor());
    themeState.resolvedTheme = "light";
    rerender();
    expect(result.current.phosphorActive).toBe(false);
    expect(result.current.phosphorToggleVisible).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    themeState.resolvedTheme = "dark";
    rerender();
    expect(result.current.phosphorActive).toBe(false);
    expect(result.current.phosphorToggleVisible).toBe(true);
  });

  it("clears a saved preference on an initially system-light page", () => {
    themeState.resolvedTheme = "light";
    const { result } = renderHook(() => useTimelinePhosphor());
    expect(result.current.phosphorActive).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
