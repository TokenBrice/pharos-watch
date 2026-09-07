"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  encodePortfolioHoldings,
  isPortfolioHolding,
  migratePortfolioIds,
  normalizePortfolioHolding,
  parsePortfolioUrlParam,
  type PortfolioHolding,
} from "@/lib/portfolio-codec";
import { getWindowStorage } from "@/lib/browser-storage";
import {
  parseStringSearchParam,
  readJsonStorageValue,
  writeJsonStorageValue,
} from "@/lib/url-storage-codecs";

interface PortfolioState {
  initialized: boolean;
  holdings: PortfolioHolding[];
  totalUsd: number;
  isFromUrl: boolean;
  addCoin: (coinId: string, amount: number) => void;
  removeCoin: (coinId: string) => void;
  setAmount: (coinId: string, amount: number) => void;
  clearAll: () => void;
  shareUrl: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "pharos:portfolio";

function loadFromStorage(): PortfolioHolding[] {
  const storage = getWindowStorage("local");
  return readJsonStorageValue(
    storage,
    STORAGE_KEY,
    (parsed) => {
    if (!Array.isArray(parsed)) return [];
    const validated = parsed.filter(isPortfolioHolding);
    const migrated = migratePortfolioIds(validated);
    if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
      saveToStorage(migrated);
    }
    return migrated;
    },
    [],
    (error) => console.warn("[usePortfolio] Failed to parse stored portfolio, resetting:", error),
  );
}

function saveToStorage(holdings: PortfolioHolding[]): void {
  writeJsonStorageValue(getWindowStorage("local"), STORAGE_KEY, holdings);
}

function getInitialPortfolioState(initialUrlParam?: string): {
  holdings: PortfolioHolding[];
  isFromUrl: boolean;
  initialized: boolean;
} {
  if (typeof window === "undefined") {
    return { holdings: [], isFromUrl: false, initialized: false };
  }
  // Prefer a router-sourced param from the caller; fall back to the location
  // bar only when the caller does not supply one.
  const urlParam =
    initialUrlParam ?? parseStringSearchParam(window.location.search, "p");
  if (urlParam) {
    return {
      holdings: parsePortfolioUrlParam(urlParam),
      isFromUrl: true,
      initialized: true,
    };
  }
  return {
    holdings: loadFromStorage(),
    isFromUrl: false,
    initialized: true,
  };
}

export function usePortfolio(
  initialUrlParam?: string,
  urlReady = true,
): PortfolioState {
  // During hydration the caller has a server snapshot, not an empty shared URL.
  const [bootState] = useState(() => getInitialPortfolioState(urlReady ? initialUrlParam : undefined));
  const [holdings, setHoldings] = useState<PortfolioHolding[]>(bootState.holdings);
  const [isFromUrl] = useState(bootState.isFromUrl);
  const initialized = bootState.initialized && urlReady;

  // Persist to localStorage when holdings change (only if NOT from URL)
  useEffect(() => {
    if (initialized && !isFromUrl) {
      saveToStorage(holdings);
    }
  }, [holdings, isFromUrl, initialized]);

  // --- Actions ---

  const addCoin = useCallback((coinId: string, amount: number) => {
    const holding = normalizePortfolioHolding({ coinId, amount });
    if (!holding) return;

    setHoldings((prev) => {
      // Don't add duplicates
      if (prev.some((h) => h.coinId === holding.coinId)) return prev;
      return [...prev, holding];
    });
  }, []);

  const removeCoin = useCallback((coinId: string) => {
    setHoldings((prev) => prev.filter((h) => h.coinId !== coinId));
  }, []);

  const setAmount = useCallback((coinId: string, amount: number) => {
    const holding = normalizePortfolioHolding({ coinId, amount });
    if (!holding) return;

    setHoldings((prev) =>
      prev.map((h) => (h.coinId === holding.coinId ? { ...h, amount: holding.amount } : h)),
    );
  }, []);

  const clearAll = useCallback(() => {
    setHoldings([]);
  }, []);

  const shareUrl = useCallback((): string => {
    const encoded = encodePortfolioHoldings(holdings);
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    if (encoded) {
      url.searchParams.set("p", encoded);
    } else {
      url.searchParams.delete("p");
    }
    return url.toString();
  }, [holdings]);

  // --- Derived values ---

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + h.amount, 0),
    [holdings],
  );

  return {
    initialized,
    holdings: initialized ? holdings : [],
    totalUsd: initialized ? totalUsd : 0,
    isFromUrl: initialized && isFromUrl,
    addCoin,
    removeCoin,
    setAmount,
    clearAll,
    shareUrl,
  };
}
