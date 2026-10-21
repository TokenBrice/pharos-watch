"use client";

import { useCallback, useRef, useState } from "react";
import {
  MINI_APP_PAYLOAD_NAMES,
  formatCoinPayload,
  miniAppPayloadIntent,
  parseMiniAppPayload,
} from "@shared/lib/telegram-mini-app-payloads";
import type { TelegramPresetId } from "@shared/lib/telegram-presets";

/** One screen in the pushed-screen stack; Home is always the root. */
export type MiniAppScreen =
  | { name: "home" }
  | { name: "coin"; coinId: string }
  | { name: "group"; groupId: TelegramPresetId | "all" }
  | { name: "add-coins" }
  | { name: "add-group" }
  | { name: "settings" };

const HOME: MiniAppScreen = { name: "home" };

/**
 * Inverse of `initialStackFromStartParam`: encode the visible screen as a
 * `?startapp=` payload so the stale-auth relaunch reopens where the user was.
 */
export function relaunchPayloadForScreen(screen: MiniAppScreen): string {
  if (screen.name === "coin") return formatCoinPayload(screen.coinId);
  if (screen.name === "settings") return MINI_APP_PAYLOAD_NAMES.settings;
  if (screen.name === "add-coins") return MINI_APP_PAYLOAD_NAMES.setup;
  return MINI_APP_PAYLOAD_NAMES.home;
}

export function initialStackFromStartParam(startParam: string | null): { stack: MiniAppScreen[] } {
  const payload = parseMiniAppPayload(startParam);
  if (!payload) return { stack: [HOME] };
  const intent = miniAppPayloadIntent(payload);
  if (payload.kind === "coin" || payload.kind === "why" || payload.kind === "coverage") {
    return { stack: [HOME, { name: "coin", coinId: payload.coinId }] };
  }
  if (intent === "settings" || intent === "quiet-hours" || intent === "forget" || intent === "health") {
    return { stack: [HOME, { name: "settings" }] };
  }
  // "Choose my own coins": coin selection for everyone; Back returns to Home (setup for new users).
  if (intent === "setup") return { stack: [HOME, { name: "add-coins" }] };
  return { stack: [HOME] };
}

function sameScreen(left: MiniAppScreen, right: MiniAppScreen): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scrollToTop(top = 0) {
  if (typeof window === "undefined") return;
  // Wait for the next screen to render before restoring its scroll position.
  requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
}

export function useMiniAppView() {
  const [stack, setStack] = useState<MiniAppScreen[]>([HOME]);
  const scrollPositionsRef = useRef<number[]>([]);
  const initializedRef = useRef(false);

  const initializeFromStartParam = useCallback((startParam: string | null) => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initial = initialStackFromStartParam(startParam);
    setStack(initial.stack);
  }, []);

  const push = useCallback((screen: MiniAppScreen) => {
    setStack((current) => {
      if (sameScreen(current[current.length - 1], screen)) return current;
      scrollPositionsRef.current[current.length - 1] = typeof window === "undefined" ? 0 : window.scrollY;
      return [...current, screen];
    });
    scrollToTop();
  }, []);

  const back = useCallback(() => {
    setStack((current) => {
      if (current.length <= 1) return current;
      scrollToTop(scrollPositionsRef.current[current.length - 2] ?? 0);
      return current.slice(0, -1);
    });
  }, []);

  /** Replace the top screen (e.g. a followed group detail after following it). */
  const replace = useCallback((screen: MiniAppScreen) => {
    setStack((current) => [...current.slice(0, -1), screen]);
  }, []);

  const showSettings = useCallback(() => push({ name: "settings" }), [push]);

  return {
    screen: stack[stack.length - 1],
    depth: stack.length,
    initializeFromStartParam,
    push,
    back,
    replace,
    showSettings,
  };
}
