"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "pharos-command-palette-history";
const MAX_HISTORY = 5;
const HISTORY_EVENT = "pharos-command-palette-history-change";
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_HISTORY: HistoryItem[] = [];

let cachedRawHistory: string | null = null;
let cachedHistorySnapshot: HistoryItem[] = EMPTY_HISTORY;

interface HistoryItem {
  id: string;
  type: "stablecoin" | "page";
  label: string;
  sublabel?: string;
  href: string;
  timestamp: number;
}

function subscribeHistory(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(HISTORY_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(HISTORY_EVENT, onStoreChange);
  };
}

function normalizeHistory(items: HistoryItem[]): HistoryItem[] {
  const weekAgo = Date.now() - HISTORY_RETENTION_MS;
  const filtered = items.filter((item) => item.timestamp > weekAgo);
  return filtered.length > 0 ? filtered : EMPTY_HISTORY;
}

function cacheHistorySnapshot(rawHistory: string | null, history: HistoryItem[]) {
  cachedRawHistory = rawHistory;
  cachedHistorySnapshot = history.length > 0 ? history : EMPTY_HISTORY;
  return cachedHistorySnapshot;
}

function readHistorySnapshot(): HistoryItem[] {
  if (typeof window === "undefined") return EMPTY_HISTORY;

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === cachedRawHistory) {
    return cachedHistorySnapshot;
  }

  try {
    if (!stored) return cacheHistorySnapshot(null, EMPTY_HISTORY);

    const parsed = JSON.parse(stored) as HistoryItem[];
    return cacheHistorySnapshot(stored, normalizeHistory(parsed));
  } catch {
    return cacheHistorySnapshot(stored, EMPTY_HISTORY);
  }
}

function publishHistoryChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

function persistHistory(history: HistoryItem[]) {
  const snapshot = history.length > 0 ? history : EMPTY_HISTORY;
  const serialized = history.length > 0 ? JSON.stringify(history) : null;
  cacheHistorySnapshot(serialized, snapshot);

  if (serialized) {
    localStorage.setItem(STORAGE_KEY, serialized);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  publishHistoryChange();
}

export function useCommandPaletteHistory() {
  const history = useSyncExternalStore(
    subscribeHistory,
    readHistorySnapshot,
    () => EMPTY_HISTORY,
  );

  const addToHistory = useCallback((
    id: string,
    type: "stablecoin" | "page",
    label: string,
    sublabel: string | undefined,
    href: string
  ) => {
    const filtered = readHistorySnapshot().filter((item) => item.id !== id);
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
      persistHistory(newHistory);
    } catch {
      // Ignore quota errors
    }
  }, []);

  const clearHistory = useCallback(() => {
    try {
      persistHistory(EMPTY_HISTORY);
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
