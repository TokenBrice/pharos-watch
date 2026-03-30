"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import type { ToastType } from "@/hooks/use-toast";

interface ThemeToggleOptions {
  toast?: (message: string, type?: ToastType, duration?: number) => void;
}

export function useThemeToggle(options?: ThemeToggleOptions) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

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
