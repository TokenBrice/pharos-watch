"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pharos-command-palette-history";
const MAX_HISTORY = 5;

interface HistoryItem {
  id: string;
  type: "stablecoin" | "page";
  label: string;
  sublabel?: string;
  href: string;
  timestamp: number;
}

export function useCommandPaletteHistory() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as HistoryItem[];
        // Filter out items older than 7 days
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        setHistory(parsed.filter((item) => item.timestamp > weekAgo));
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  const addToHistory = useCallback((
    id: string,
    type: "stablecoin" | "page",
    label: string,
    sublabel: string | undefined,
    href: string
  ) => {
    setHistory((prev) => {
      // Remove existing entry if present
      const filtered = prev.filter((item) => item.id !== id);
      // Add new entry at beginning
      const newItem: HistoryItem = {
        id,
        type,
        label,
        sublabel,
        href,
        timestamp: Date.now(),
      };
      const newHistory = [newItem, ...filtered].slice(0, MAX_HISTORY);
      
      // Persist to localStorage
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
      } catch {
        // Ignore quota errors
      }
      
      return newHistory;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }, []);

  return {
    history: mounted ? history : [],
    addToHistory,
    clearHistory,
  };
}
