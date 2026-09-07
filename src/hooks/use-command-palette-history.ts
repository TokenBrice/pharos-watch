"use client";

import { useCallback, useSyncExternalStore } from "react";
import { createCachedJsonStorageStore } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos-command-palette-history";
const MAX_HISTORY = 5;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_HISTORY: HistoryItem[] = [];

interface HistoryItem {
  id: string;
  type: "stablecoin" | "page";
  label: string;
  sublabel?: string;
  href: string;
  timestamp: number;
}

function isHistoryItem(item: unknown): item is HistoryItem {
  if (item === null || typeof item !== "object") return false;

  const candidate = item as Partial<HistoryItem>;
  return (
    typeof candidate.id === "string" &&
    (candidate.type === "stablecoin" || candidate.type === "page") &&
    typeof candidate.label === "string" &&
    (candidate.sublabel === undefined || typeof candidate.sublabel === "string") &&
    typeof candidate.href === "string" &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  );
}

function normalizeHistory(items: unknown[]): HistoryItem[] {
  const weekAgo = Date.now() - HISTORY_RETENTION_MS;
  const filtered = items.filter((item): item is HistoryItem => isHistoryItem(item) && item.timestamp > weekAgo);
  return filtered.length > 0 ? filtered : EMPTY_HISTORY;
}

const historyStore = createCachedJsonStorageStore<HistoryItem[]>({
  key: STORAGE_KEY,
  fallback: EMPTY_HISTORY,
  decode: (parsed) => Array.isArray(parsed) ? normalizeHistory(parsed) : null,
  isEqual: (a, b) => a === b || (a.length === 0 && b.length === 0),
});

export function useCommandPaletteHistory() {
  const history = useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    historyStore.getServerSnapshot,
  );

  const addToHistory = useCallback((
    id: string,
    type: "stablecoin" | "page",
    label: string,
    sublabel: string | undefined,
    href: string
  ) => {
    const filtered = historyStore.getSnapshot().filter((item) => item.id !== id);
    const newItem: HistoryItem = {
      id,
      type,
      label,
      sublabel,
      href,
      timestamp: Date.now(),
    };
    const newHistory = [newItem, ...filtered].slice(0, MAX_HISTORY);

    try {
      historyStore.write(newHistory);
    } catch {
      // Ignore quota errors
    }
  }, []);

  const clearHistory = useCallback(() => {
    try {
      historyStore.remove();
    } catch {
      // Ignore
    }
  }, []);

  return {
    history,
    addToHistory,
    clearHistory,
  };
}
