"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos-sidebar-expanded";
const HOVER_DELAY = 200;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface SidebarState {
  expanded: boolean;
  pinned: boolean;
  togglePin: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider>");
  return ctx;
}

function useExpanded(): SidebarState {
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

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const value = useExpanded();
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function SidebarSpacer() {
  const { pinned } = useSidebar();
  return (
    <div
      className={`hidden lg:block shrink-0 transition-all duration-200 ${
        pinned ? "w-[var(--sidebar-width-expanded)]" : "w-[var(--sidebar-width-collapsed)]"
      }`}
    />
  );
}
