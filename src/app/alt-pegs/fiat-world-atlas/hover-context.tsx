"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { PegCurrency } from "@shared/types";

interface HoverTarget {
  id: string;
  pegCurrency: PegCurrency;
}

interface HoverContextValue {
  hoveredCoinId: string | null;
  hoveredPeg: PegCurrency | null;
  setHoveredCoin: (target: HoverTarget | null) => void;
  isHovered: (coinId: string) => boolean;
  isSibling: (target: HoverTarget) => boolean;
  isDimmed: (target: HoverTarget) => boolean;
}

const HoverContext = createContext<HoverContextValue | null>(null);

const FALLBACK: HoverContextValue = {
  hoveredCoinId: null,
  hoveredPeg: null,
  setHoveredCoin: () => {},
  isHovered: () => false,
  isSibling: () => false,
  isDimmed: () => false,
};

export function HoverProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

  const setHoveredCoin = useCallback((target: HoverTarget | null) => {
    setHovered(target);
  }, []);

  const value = useMemo<HoverContextValue>(() => {
    const hoveredCoinId = hovered?.id ?? null;
    const hoveredPeg = hovered?.pegCurrency ?? null;
    return {
      hoveredCoinId,
      hoveredPeg,
      setHoveredCoin,
      isHovered: (id) => hoveredCoinId === id,
      isSibling: (t) =>
        hoveredPeg !== null && t.pegCurrency === hoveredPeg && t.id !== hoveredCoinId,
      isDimmed: (t) => hoveredPeg !== null && t.pegCurrency !== hoveredPeg,
    };
  }, [hovered, setHoveredCoin]);

  return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>;
}

export function useHoverState(): HoverContextValue {
  const ctx = useContext(HoverContext);
  return ctx ?? FALLBACK;
}
