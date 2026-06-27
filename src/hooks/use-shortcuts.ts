"use client";

import { useCallback } from "react";
import { usePreference } from "@/hooks/use-preferences";

export const SHORTCUTS_STORAGE_KEY = "pharos-shortcuts";

// Default saved shortcuts, identified by their `nav-config` href. Resolution to
// label/icon happens in the consuming component so this hook stays data-only and
// any href that no longer maps to a nav destination is dropped at render time.
export const DEFAULT_SHORTCUT_HREFS: string[] = [
  "/chains/",
  "/upcoming/",
  "/portfolio/",
  "/alt-pegs/",
  "/cemetery/",
  "https://pharosville.pharos.watch/",
  "/yield/",
  "/liquidity/",
  "/screener/",
  "/compare/",
  "/dependency-map/",
  "/timeline/",
];

const LEGACY_DEFAULT_SHORTCUT_HREFS: string[][] = [
  [
    "/chains/",
    "/upcoming/",
    "/portfolio/",
    "/alt-pegs/",
    "/cemetery/",
    "https://pharosville.pharos.watch/",
  ],
  [
    "/chains/",
    "/portfolio/",
    "/upcoming/",
    "/alt-pegs/",
    "/cemetery/",
    "https://pharosville.pharos.watch/",
  ],
];

function shortcutListsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((href, index) => href === b[index]);
}

// Dedupe + drop non-string entries on read; an empty array is a valid (user
// cleared everything) state and is preserved, only malformed payloads fall back
// to the defaults. Exact legacy defaults migrate to the expanded default set.
export function decodeShortcuts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SHORTCUT_HREFS];
  const seen = new Set<string>();
  const hrefs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    hrefs.push(entry);
  }
  if (LEGACY_DEFAULT_SHORTCUT_HREFS.some((legacy) => shortcutListsMatch(hrefs, legacy))) {
    return [...DEFAULT_SHORTCUT_HREFS];
  }
  return hrefs;
}

export interface ShortcutsState {
  hrefs: string[];
  add: (href: string) => void;
  remove: (href: string) => void;
  /** Swap a shortcut with its neighbour (-1 = earlier, 1 = later). */
  move: (href: string, direction: -1 | 1) => void;
  reset: () => void;
}

// localStorage-backed shortcut order. Built on `usePreference`, so it is
// SSR-safe: the default set renders during hydration and the stored set syncs in
// after mount (no window access during render).
export function useShortcuts(): ShortcutsState {
  const [hrefs, setHrefs, reset] = usePreference<string[]>(
    SHORTCUTS_STORAGE_KEY,
    DEFAULT_SHORTCUT_HREFS,
    { decode: decodeShortcuts },
  );

  const add = useCallback(
    (href: string) => {
      setHrefs((prev) => (prev.includes(href) ? prev : [...prev, href]));
    },
    [setHrefs],
  );

  const remove = useCallback(
    (href: string) => {
      setHrefs((prev) => prev.filter((entry) => entry !== href));
    },
    [setHrefs],
  );

  const move = useCallback(
    (href: string, direction: -1 | 1) => {
      setHrefs((prev) => {
        const index = prev.indexOf(href);
        const target = index + direction;
        if (index === -1 || target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [setHrefs],
  );

  return { hrefs, add, remove, move, reset };
}
