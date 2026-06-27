"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos-sidebar-expanded";
const HOVER_DELAY = 200;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useSidebar() {
  const [pinned, setPinned] = useState(true);
  const [hovered, setHovered] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useBrowserLayoutEffect(() => {
    const storage = getWindowStorage("local");
    setPinned(safeStorageGetItem(storage, STORAGE_KEY) !== "false");
  }, []);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      safeStorageSetItem(getWindowStorage("local"), STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const onMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHovered(true), HOVER_DELAY);
  }, []);

  const onMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = null;
    setHovered(false);
  }, []);

  const expanded = pinned || hovered;

  return { expanded, pinned, togglePin, onMouseEnter, onMouseLeave };
}
