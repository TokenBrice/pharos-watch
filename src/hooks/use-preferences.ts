"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Generic hook that persists a value to localStorage.
 * SSR-safe: returns defaultValue during hydration, syncs after mount.
 */
export function usePreference<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  // Persist to localStorage on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore quota errors
    }
  }, [key, value]);

  const reset = useCallback(() => {
    setValue(defaultValue);
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore
    }
  }, [key, defaultValue]);

  return [value, setValue, reset];
}

/* ─── Column Visibility Types ─────────────────────────────── */

export type ColumnId =
  | "rank"
  | "name"
  | "price"
  | "peg"
  | "mcap"
  | "change24h"
  | "change7d"
  | "grade"
  | "stability"
  | "liquidity"
  | "backing"
  | "type"
  | "flags";

interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Always visible — cannot be toggled off */
  locked?: boolean;
  /** Hidden by default on mobile */
  hiddenMobile?: boolean;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "rank", label: "#", locked: true },
  { id: "name", label: "Name", locked: true },
  { id: "price", label: "Price" },
  { id: "peg", label: "Peg", hiddenMobile: true },
  { id: "mcap", label: "Market Cap" },
  { id: "change24h", label: "24h" },
  { id: "change7d", label: "7d", hiddenMobile: true },
  { id: "grade", label: "Grade", hiddenMobile: true },
  { id: "stability", label: "Peg Score", hiddenMobile: true },
  { id: "liquidity", label: "Liq", hiddenMobile: true },
  { id: "backing", label: "Backing", hiddenMobile: true },
  { id: "type", label: "Type", hiddenMobile: true },
  { id: "flags", label: "Flags", hiddenMobile: true },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnId[] = ALL_COLUMNS.map((c) => c.id);
export const MOBILE_DEFAULT_COLUMNS: ColumnId[] = ALL_COLUMNS.filter((c) => !c.hiddenMobile).map((c) => c.id);

export const LOCKED_COLUMNS: Set<ColumnId> = new Set(
  ALL_COLUMNS.filter((c) => c.locked).map((c) => c.id)
);
