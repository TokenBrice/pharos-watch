"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { harborHash, parseHarborHash } from "@shared/lib/harbor-scene";

export type HarborSelectionSource = "hero" | "table" | "hash";

export interface HarborSelectionContextValue {
  /** Chain (or barge) whose record card is open. */
  pinnedId: string | null;
  /** Chain lit by hovering or focusing a leaderboard row; the harbor lights its berth (or barge). */
  hoverChainId: string | null;
  /** Leaderboard row highlighted by "Show in table". */
  revealedChainId: string | null;
  pin: (id: string | null, source: HarborSelectionSource) => void;
  setHoverChainId: (id: string | null) => void;
  /** Scrolls the leaderboard row into view and highlights it; the leaderboard owns scrolling and motion. */
  revealRow: (chainId: string) => void;
  registerRevealRow: (handler: (chainId: string) => void) => () => void;
}

const HarborSelectionContext = createContext<HarborSelectionContextValue | null>(null);

/**
 * Sole owner of `location.hash` on `/chains/`. `#chain-<id>` pins that chain on load and on `hashchange`; pinning a
 * chain writes its hash with `replaceState` (no history entry), unpinning clears it. Barges have no hash.
 */
export function HarborSelectionProvider({ chainIds, children }: { chainIds: readonly string[]; children: ReactNode }) {
  const known = useMemo(() => new Set(chainIds), [chainIds]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [hoverChainId, setHoverChainId] = useState<string | null>(null);
  const [revealedChainId, setRevealedChainId] = useState<string | null>(null);
  const revealHandler = useRef<((chainId: string) => void) | null>(null);
  const writtenHash = useRef<string | null>(null);

  const replaceHash = useCallback((fragment: string) => {
    if (window.location.hash === fragment) return;
    writtenHash.current = fragment;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${fragment}`);
  }, []);

  const pin = useCallback(
    (id: string | null, source: HarborSelectionSource) => {
      setPinnedId(id);
      if (source === "hash") return;
      replaceHash(id !== null && known.has(id) ? harborHash(id) : "");
    },
    [known, replaceHash],
  );

  useEffect(() => {
    if (known.size === 0) return;
    const apply = () => {
      const echoed = writtenHash.current !== null && window.location.hash === writtenHash.current;
      writtenHash.current = null;
      if (echoed) return;
      const id = parseHarborHash(window.location.hash, known);
      if (id) setPinnedId(id);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [known]);

  const revealRow = useCallback((chainId: string) => {
    setRevealedChainId(chainId);
    revealHandler.current?.(chainId);
  }, []);

  const registerRevealRow = useCallback((handler: (chainId: string) => void) => {
    revealHandler.current = handler;
    return () => {
      if (revealHandler.current === handler) revealHandler.current = null;
    };
  }, []);

  const value = useMemo<HarborSelectionContextValue>(
    () => ({ pinnedId, hoverChainId, revealedChainId, pin, setHoverChainId, revealRow, registerRevealRow }),
    [pinnedId, hoverChainId, revealedChainId, pin, revealRow, registerRevealRow],
  );
  return <HarborSelectionContext.Provider value={value}>{children}</HarborSelectionContext.Provider>;
}

export function useHarborSelection(): HarborSelectionContextValue {
  const context = useContext(HarborSelectionContext);
  if (!context) throw new Error("useHarborSelection must be used inside HarborSelectionProvider");
  return context;
}
