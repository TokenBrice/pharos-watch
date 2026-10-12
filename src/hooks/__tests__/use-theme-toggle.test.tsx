// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { useThemeToggle } from "../use-theme-toggle";

const { themeState, setTheme } = vi.hoisted(() => ({
  themeState: { theme: "system", resolvedTheme: "dark" },
  setTheme: vi.fn(),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ ...themeState, setTheme }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

afterEach(() => {
  cleanupFrontendTest();
  setTheme.mockClear();
  themeState.resolvedTheme = "dark";
});

describe("useThemeToggle", () => {
  it("toggles the rendered system-dark theme to light", () => {
    const { result } = renderHook(() => useThemeToggle());
    expect(result.current.mounted).toBe(true);
    expect(result.current.isDark).toBe(true);
    expect(result.current.label).toBe("Light mode");
    act(() => result.current.toggleTheme());
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(themeState.theme).toBe("system");
  });

  it("tracks OS preference changes while System remains selected", () => {
    themeState.resolvedTheme = "light";
    const { result, rerender } = renderHook(() => useThemeToggle());
    expect(result.current.isDark).toBe(false);
    act(() => result.current.toggleTheme());
    expect(setTheme).toHaveBeenLastCalledWith("dark");

    themeState.resolvedTheme = "dark";
    rerender();
    expect(result.current.isDark).toBe(true);
    act(() => result.current.toggleTheme());
    expect(setTheme).toHaveBeenLastCalledWith("light");
  });

  it("cross-fades the theme swap through a view transition unless motion is reduced", () => {
    themeState.resolvedTheme = "light";
    let reduced = false;
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return {};
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced, media: query }) as MediaQueryList);
    try {
      const { result } = renderHook(() => useThemeToggle());
      act(() => result.current.toggleTheme());
      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(setTheme).toHaveBeenLastCalledWith("dark");

      reduced = true;
      act(() => result.current.toggleTheme());
      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(setTheme).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
      vi.unstubAllGlobals();
    }
  });
});
