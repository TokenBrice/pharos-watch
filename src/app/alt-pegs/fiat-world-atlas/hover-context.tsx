"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { PegCurrency } from "@shared/types/core";

interface HoverTarget {
  id: string;
  pegCurrency: PegCurrency;
}

interface HoverContextValue {
  hoveredCoinId: string | null;
  hoveredPeg: PegCurrency | null;
  selectedPeg: PegCurrency | null;
  setHoveredCoin: (target: HoverTarget | null) => void;
  isHovered: (coinId: string) => boolean;
  isSibling: (target: HoverTarget) => boolean;
  isSelectedPeg: (peg: PegCurrency) => boolean;
  isDimmed: (target: HoverTarget) => boolean;
}

const HoverContext = createContext<HoverContextValue | null>(null);
const HoverDispatchContext = createContext<HoverContextValue["setHoveredCoin"] | null>(null);

const FALLBACK: HoverContextValue = {
  hoveredCoinId: null,
  hoveredPeg: null,
  selectedPeg: null,
  setHoveredCoin: () => {},
  isHovered: () => false,
  isSibling: () => false,
  isSelectedPeg: () => false,
  isDimmed: () => false,
};

export function HoverProvider({
  children,
  selectedPeg = null,
}: {
  children: ReactNode;
  selectedPeg?: PegCurrency | null;
}) {
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

  const setHoveredCoin = useCallback((target: HoverTarget | null) => {
    setHovered((current) => {
      if (current?.id === target?.id && current?.pegCurrency === target?.pegCurrency) {
        return current;
      }
      return target;
    });
  }, []);

  const value = useMemo<HoverContextValue>(() => {
    const hoveredCoinId = hovered?.id ?? null;
    const hoveredPeg = hovered?.pegCurrency ?? null;
    const activeSpotlightPeg = hoveredPeg ?? selectedPeg;
    return {
      hoveredCoinId,
      hoveredPeg,
      selectedPeg,
      setHoveredCoin,
      isHovered: (id) => hoveredCoinId === id,
      isSibling: (t) =>
        hoveredPeg !== null && t.pegCurrency === hoveredPeg && t.id !== hoveredCoinId,
      isSelectedPeg: (peg) => selectedPeg !== null && peg === selectedPeg,
      isDimmed: (t) => activeSpotlightPeg !== null && t.pegCurrency !== activeSpotlightPeg,
    };
  }, [hovered, selectedPeg, setHoveredCoin]);

  return (
    <HoverDispatchContext.Provider value={setHoveredCoin}>
      <HoverContext.Provider value={value}>{children}</HoverContext.Provider>
    </HoverDispatchContext.Provider>
  );
}

export function useHoverState(): HoverContextValue {
  const ctx = useContext(HoverContext);
  return ctx ?? FALLBACK;
}

export function useHoverDispatch(): HoverContextValue["setHoveredCoin"] {
  return useContext(HoverDispatchContext) ?? FALLBACK.setHoveredCoin;
}
