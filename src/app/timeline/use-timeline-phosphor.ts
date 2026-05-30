"use client";

import { useCallback, useEffect, useState } from "react";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { getWindowStorage, safeStorageGetItem, safeStorageRemoveItem, safeStorageSetItem } from "@/lib/browser-storage";

const PHOSPHOR_STORAGE_KEY = "pharos:timeline-phosphor";

export function useTimelinePhosphor() {
  // Phosphor mode is opt-in, dark-mode-only. Persisted in localStorage and
  // applied only while the site is in dark mode — the green-on-black palette is
  // illegible against a light background.
  const { mounted: themeMounted, isDark } = useThemeToggle();
  const [phosphorStorageVersion, setPhosphorStorageVersion] = useState(0);

  const persistedPhosphor = safeStorageGetItem(getWindowStorage("local"), PHOSPHOR_STORAGE_KEY) === "1";

  useEffect(() => {
    if (!themeMounted || isDark) return;
    safeStorageRemoveItem(getWindowStorage("local"), PHOSPHOR_STORAGE_KEY);
  }, [themeMounted, isDark, phosphorStorageVersion]);

  const togglePhosphor = useCallback(() => {
    const next = !persistedPhosphor;
    if (next) {
      safeStorageSetItem(getWindowStorage("local"), PHOSPHOR_STORAGE_KEY, "1");
    } else {
      safeStorageRemoveItem(getWindowStorage("local"), PHOSPHOR_STORAGE_KEY);
    }
    setPhosphorStorageVersion((value) => value + 1);
  }, [persistedPhosphor]);

  return {
    phosphorActive: persistedPhosphor && isDark,
    phosphorToggleVisible: themeMounted && isDark,
    togglePhosphor,
  };
}
