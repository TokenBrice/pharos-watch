"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { miniAppPayloadIntent, parseMiniAppPayload } from "@shared/lib/telegram-mini-app-payloads";
import type { CoinInsightTarget, TelegramMiniAppState } from "./types";

export type ViewKey = "home" | "watchlist" | "presets" | "settings";

export function initialViewFromStartParam(startParam: string | null): {
  view: ViewKey;
  coinId: string | null;
  insight: CoinInsightTarget | null;
} {
  const payload = parseMiniAppPayload(startParam);
  if (!payload) return { view: "home", coinId: null, insight: null };
  const intent = miniAppPayloadIntent(payload);
  if (intent === "settings" || intent === "presets") return { view: intent, coinId: null, insight: null };
  if (intent === "quiet-hours" || intent === "forget") return { view: "settings", coinId: null, insight: null };
  if (intent === "coin") return { view: "watchlist", coinId: payload.kind === "coin" ? payload.coinId : null, insight: null };
  if (intent === "why" || intent === "coverage") {
    return {
      view: "watchlist",
      coinId: payload.kind === "why" || payload.kind === "coverage" ? payload.coinId : null,
      insight: payload.kind === "why" || payload.kind === "coverage" ? { kind: payload.kind, coinId: payload.coinId } : null,
    };
  }
  if (intent === "watchlist") return { view: "watchlist", coinId: null, insight: null };
  return { view: "home", coinId: null, insight: null };
}

export function useMiniAppView(state: TelegramMiniAppState | null) {
  const [view, setView] = useState<ViewKey>("home");
  const [coinTarget, setCoinTarget] = useState<string | null>(null);
  const [visibleCoinTarget, setVisibleCoinTarget] = useState<string | null>(null);
  const [coinInsightTarget, setCoinInsightTarget] = useState<CoinInsightTarget | null>(null);
  const [highlightedCoinId, setHighlightedCoinId] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const initializeFromStartParam = useCallback((startParam: string | null) => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initial = initialViewFromStartParam(startParam);
    setView(initial.view);
    setCoinTarget(initial.coinId);
    setVisibleCoinTarget(initial.insight ? null : initial.coinId);
    setCoinInsightTarget(initial.insight);
  }, []);

  const handleBack = useCallback(() => {
    if (coinInsightTarget) setCoinInsightTarget(null);
    else setView("home");
  }, [coinInsightTarget]);

  const activateView = useCallback((key: ViewKey) => {
    setView(key);
    if (key !== "watchlist") {
      setCoinInsightTarget(null);
      setCoinTarget(null);
      setHighlightedCoinId(null);
    }
  }, []);

  useEffect(() => {
    if (!coinTarget || view !== "watchlist" || !state) return;
    const exists = state.subscriptions.some((coin) => coin.stablecoinId === coinTarget)
      || state.catalog.searchableCoins.some((coin) => coin.stablecoinId === coinTarget)
      || visibleCoinTarget === coinTarget;
    if (!exists) return;
    const targetId = coinTarget;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the highlight must commit before the deferred scroll tick focuses the row.
    setHighlightedCoinId(targetId);
    const scrollTimer = setTimeout(() => {
      const node = typeof document === "undefined" ? null : document.getElementById(`coin-row-${targetId}`);
      const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    }, 0);
    const clearTimer = setTimeout(() => {
      setHighlightedCoinId((current) => (current === targetId ? null : current));
      setCoinTarget((current) => (current === targetId ? null : current));
    }, 2_000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
      setHighlightedCoinId((current) => (current === targetId ? null : current));
    };
  }, [coinTarget, state, view, visibleCoinTarget]);

  return {
    view,
    coinInsightTarget,
    highlightedCoinId,
    visibleCoinTarget,
    backButtonVisible: view !== "home" || coinInsightTarget != null,
    initializeFromStartParam,
    handleBack,
    showSettings: useCallback(() => setView("settings"), []),
    activateView,
    setCoinInsightTarget,
    setCoinTarget,
  };
}
