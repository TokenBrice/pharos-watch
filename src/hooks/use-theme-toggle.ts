"use client";

import { useTheme } from "next-themes";
import { useCallback, useState, useSyncExternalStore } from "react";
import { trackEvent } from "@/lib/analytics";
import type { ToastType } from "@/hooks/use-toast";

interface ThemeToggleOptions {
  toast?: (message: string, type?: ToastType, duration?: number) => void;
}

const getMountedServerSnapshot = () => false;

export function useThemeToggle(options?: ThemeToggleOptions) {
  const { theme, setTheme } = useTheme();
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
  const mounted = useSyncExternalStore(mountStore.subscribe, mountStore.getSnapshot, getMountedServerSnapshot);

  const isDark = mounted ? theme === "dark" : false;
  const nextTheme = isDark ? "light" : "dark";
  const label = isDark ? "Light mode" : "Dark mode";

  const toggleTheme = useCallback(() => {
    trackEvent("theme_toggled", { theme: nextTheme });
    setTheme(nextTheme);
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
