"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "pharos-command-palette-history";
const MAX_HISTORY = 5;
const HISTORY_EVENT = "pharos-command-palette-history-change";

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

function readHistorySnapshot(): HistoryItem[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored) as HistoryItem[];
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return parsed.filter((item) => item.timestamp > weekAgo);
  } catch {
    return [];
  }
}

function publishHistoryChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

export function useCommandPaletteHistory() {
  const history = useSyncExternalStore(
    subscribeHistory,
    readHistorySnapshot,
    () => [],
  );

  const addToHistory = useCallback((
    id: string,
    type: "stablecoin" | "page",
    label: string,
    sublabel: string | undefined,
    href: string
  ) => {
    const filtered = history.filter((item) => item.id !== id);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
      publishHistoryChange();
    } catch {
      // Ignore quota errors
    }
  }, [history]);

  const clearHistory = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      publishHistoryChange();
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
