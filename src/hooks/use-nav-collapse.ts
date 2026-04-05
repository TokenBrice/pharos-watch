"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { NAV_GROUPS, ABOUT_NAV_GROUP, DEFAULT_EXPANDED } from "@/lib/nav-config";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";
import { isRouteActive } from "@/lib/navigation";

export const STORAGE_KEY = "pharos-nav-groups";

/* ── Pure helpers (exported for testing) ──────────────────────── */

export function getExpandedState(): Record<string, boolean> {
  const storage = getWindowStorage("local");
  const raw = safeStorageGetItem(storage, STORAGE_KEY);
  let persisted: Record<string, boolean> = {};
  if (raw) {
    try {
      persisted = JSON.parse(raw);
    } catch {
      // corrupted — ignore
    }
  }
  return { ...DEFAULT_EXPANDED, ...persisted };
}

export function setExpandedState(state: Record<string, boolean>): void {
  safeStorageSetItem(getWindowStorage("local"), STORAGE_KEY, JSON.stringify(state));
}

/* ── Route → group key resolver ──────────────────────────────── */

function findGroupKeyForRoute(pathname: string): string | null {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => isRouteActive(pathname, item.href))) return group.key;
  }
  if (isRouteActive(pathname, ABOUT_NAV_GROUP.href) || ABOUT_NAV_GROUP.children.some((item) => isRouteActive(pathname, item.href))) {
    return "about";
  }
  return null;
}

/* ── React hook ──────────────────────────────────────────────── */

export function useNavCollapse() {
  const pathname = usePathname();
  const [state, setState] = useState(getExpandedState);
  // Groups the user has explicitly collapsed while the active page is inside them
  const [manualOverrides, setManualOverrides] = useState<Record<string, boolean>>({});

  const activeGroupKey = useMemo(() => findGroupKeyForRoute(pathname), [pathname]);

  const isExpanded = useCallback(
    (key: string): boolean => {
      // If user explicitly collapsed the active group, respect that
      if (key === activeGroupKey && manualOverrides[key] === false) return false;
      // Otherwise, active group auto-expands
      if (key === activeGroupKey) return true;
      return state[key] ?? DEFAULT_EXPANDED[key] ?? false;
    },
    [state, activeGroupKey, manualOverrides],
  );

  const toggle = useCallback(
    (key: string) => {
      const currentlyExpanded = isExpanded(key);
      // Track manual override when collapsing the active group
      if (key === activeGroupKey) {
        setManualOverrides((prev) => ({ ...prev, [key]: !currentlyExpanded }));
      }
      setState((prev) => {
        const next = { ...prev, [key]: !currentlyExpanded };
        setExpandedState(next);
        return next;
      });
    },
    [isExpanded, activeGroupKey],
  );

  return { isExpanded, toggle, activeGroupKey };
}
