"use client";

import { useTheme } from "next-themes";
import { useCallback, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { trackEvent } from "@/lib/analytics";
import type { ToastType } from "@/hooks/use-toast";

interface ThemeToggleOptions {
  toast?: (message: string, type?: ToastType, duration?: number) => void;
}

const getMountedServerSnapshot = () => false;

/**
 * Runs a next-themes `setTheme` call inside a view transition so the whole
 * viewport cross-fades (globals.css `::view-transition-*(root)`) and charts
 * swap together with the chrome. flushSync commits the theme class change
 * inside the snapshot callback. Instant swap without the API or under
 * reduced motion.
 */
export function applyThemeWithTransition(apply: () => void) {
  if (
    typeof document.startViewTransition !== "function"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    apply();
    return;
  }
  document.startViewTransition(() => flushSync(apply));
}

export function useThemeToggle(options?: ThemeToggleOptions) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mountStore] = useState(() => {
    let mounted = false;
    return {
      getSnapshot: () => mounted,
      subscribe: (listener: () => void) => {
        mounted = true;
        listener();
        return () => {};
      },
    };
  });
  const mounted = useSyncExternalStore(mountStore.subscribe, mountStore.getSnapshot, getMountedServerSnapshot)
    && (resolvedTheme === "dark" || resolvedTheme === "light");

  const isDark = mounted ? resolvedTheme === "dark" : false;
  const nextTheme = isDark ? "light" : "dark";
  const label = isDark ? "Light mode" : "Dark mode";

  const toggleTheme = useCallback(() => {
    trackEvent("theme_toggled", { theme: nextTheme });
    applyThemeWithTransition(() => setTheme(nextTheme));
    options?.toast?.(`Switched to ${nextTheme} mode`, "info");
  }, [nextTheme, options, setTheme]);

  return {
    mounted,
    isDark,
    label,
    nextTheme,
    toggleTheme,
  };
}
