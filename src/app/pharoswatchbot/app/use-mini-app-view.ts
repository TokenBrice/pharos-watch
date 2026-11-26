"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Inverse of `initialStackFromStartParam`: encode the visible screen as a
 * `?startapp=` payload so the stale-auth relaunch reopens where the user was.
 */
export function relaunchPayloadForScreen(screen: MiniAppScreen): string {
  if (screen.name === "coin") return formatCoinPayload(screen.coinId);
  if (screen.name === "settings") return MINI_APP_PAYLOAD_NAMES.settings;
  if (screen.name === "add-coins") return MINI_APP_PAYLOAD_NAMES.setup;
  if (screen.name === "add-group") return MINI_APP_PAYLOAD_NAMES.presets;
  return MINI_APP_PAYLOAD_NAMES.home;
}

export function initialStackFromStartParam(startParam: string | null): { stack: MiniAppScreen[] } {
  const payload = parseMiniAppPayload(startParam);
  if (!payload) return { stack: [HOME] };
  const intent = miniAppPayloadIntent(payload);
  if (payload.kind === "coin" || payload.kind === "why" || payload.kind === "coverage") {
    return { stack: [HOME, { name: "coin", coinId: payload.coinId }] };
  }
  if (intent === "presets") {
    return { stack: [HOME, { name: "add-group" }] };
  }
  if (
    intent === "settings"
    || intent === "quiet-hours"
    || intent === "forget"
    || intent === "health"
    || intent === "snooze"
  ) {
    return { stack: [HOME, { name: "settings" }] };
  }
  // "Choose my own coins": coin selection for everyone; Back returns to Home (setup for new users).
  if (intent === "setup") return { stack: [HOME, { name: "add-coins" }] };
  return { stack: [HOME] };
}

function sameScreen(left: MiniAppScreen, right: MiniAppScreen): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeScrollTo(top: number): void {
  if (typeof window === "undefined" || typeof window.scrollTo !== "function") return;
  if (/jsdom/i.test(window.navigator?.userAgent ?? "") && !("mock" in window.scrollTo)) return;
  window.scrollTo({ top, behavior: "auto" });
}

function focusScreenHeading(): void {
  if (typeof document === "undefined") return;
  const heading = document.querySelector<HTMLElement>(
    '.pharos-mini-app h1, .pharos-mini-app [role="heading"][aria-level="1"]',
  );
  heading?.focus({ preventScroll: true });
}

interface PendingNavigation {
  top: number;
  direction: "push" | "back";
  restoreTrigger: HTMLElement | null;
}

export function useMiniAppView() {
  const [stack, setStack] = useState<MiniAppScreen[]>([HOME]);
  const [homeCoinsExpanded, setHomeCoinsExpanded] = useState(false);
  const [presetMembersExpanded, setPresetMembersExpanded] = useState<Record<string, boolean>>({});
  const stackRef = useRef<MiniAppScreen[]>([HOME]);
  const scrollPositionsRef = useRef<number[]>([]);
  const triggerElementsRef = useRef<(HTMLElement | null)[]>([]);
  const pendingNavRef = useRef<PendingNavigation | null>(null);
  const initializedRef = useRef(false);

  const resetExpanded = useCallback(() => {
    setHomeCoinsExpanded(false);
    setPresetMembersExpanded({});
  }, []);

  const expandPresetMembers = useCallback((presetId: string) => {
    setPresetMembersExpanded((current) => (current[presetId] ? current : { ...current, [presetId]: true }));
  }, []);

  const initializeFromStartParam = useCallback((startParam: string | null) => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initial = initialStackFromStartParam(startParam);
    stackRef.current = initial.stack;
    scrollPositionsRef.current = [];
    triggerElementsRef.current = [];
    pendingNavRef.current = null;
    resetExpanded();
    setStack(initial.stack);
  }, [resetExpanded]);

  const push = useCallback((screen: MiniAppScreen) => {
    const current = stackRef.current;
    if (sameScreen(current[current.length - 1], screen)) return;
    scrollPositionsRef.current[current.length - 1] = typeof window === "undefined" ? 0 : window.scrollY;
    triggerElementsRef.current[current.length - 1] =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    pendingNavRef.current = { top: 0, direction: "push", restoreTrigger: null };
    const nextStack = [...current, screen];
    stackRef.current = nextStack;
    setStack(nextStack);
  }, []);

  const back = useCallback(() => {
    const current = stackRef.current;
    if (current.length <= 1) return;
    const targetIndex = current.length - 2;
    pendingNavRef.current = {
      top: scrollPositionsRef.current[targetIndex] ?? 0,
      direction: "back",
      restoreTrigger: triggerElementsRef.current[targetIndex] ?? null,
    };
    scrollPositionsRef.current.length = targetIndex;
    triggerElementsRef.current.length = targetIndex;
    const nextStack = current.slice(0, -1);
    stackRef.current = nextStack;
    setStack(nextStack);
  }, []);

  /** Replace the top screen (e.g. a followed group detail after following it). */
  const replace = useCallback((screen: MiniAppScreen) => {
    const nextStack = [...stackRef.current.slice(0, -1), screen];
    stackRef.current = nextStack;
    setStack(nextStack);
  }, []);

  useIsomorphicLayoutEffect(() => {
    const pending = pendingNavRef.current;
    if (!pending) return;
    pendingNavRef.current = null;
    safeScrollTo(pending.top);
    if (pending.direction === "push") {
      focusScreenHeading();
    } else if (pending.restoreTrigger && pending.restoreTrigger.isConnected) {
      pending.restoreTrigger.focus({ preventScroll: true });
    } else {
      focusScreenHeading();
    }
  }, [stack]);

  const showSettings = useCallback(() => push({ name: "settings" }), [push]);

  return {
    screen: stack[stack.length - 1],
    depth: stack.length,
    homeCoinsExpanded,
    setHomeCoinsExpanded,
    presetMembersExpanded,
    expandPresetMembers,
    resetExpanded,
    initializeFromStartParam,
    push,
    back,
    replace,
    showSettings,
  };
}
