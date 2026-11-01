"use client";

import { useSyncExternalStore } from "react";
import { DAY_MS } from "@/lib/constants";

const clockListeners = new Set<() => void>();
let clockNowMs: number | null = null;
let clockTimer: number | undefined;

function updateClock() {
  window.clearTimeout(clockTimer);
  clockNowMs = Date.now();
  // Day-scoped labels expire at a UTC midnight; waking daily also re-anchors a
  // restored background tab whose timers were throttled.
  const nextDayMs = (Math.floor(clockNowMs / DAY_MS) + 1) * DAY_MS;
  clockTimer = window.setTimeout(updateClock, nextDayMs - clockNowMs);
  for (const listener of clockListeners) listener();
}

function resumeClock() {
  if (document.visibilityState === "visible") updateClock();
}

function subscribeToClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    document.addEventListener("visibilitychange", resumeClock);
    updateClock();
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      window.clearTimeout(clockTimer);
      document.removeEventListener("visibilitychange", resumeClock);
      clockNowMs = null;
    }
  };
}

const getClockSnapshot = () => clockNowMs;
const getServerClockSnapshot = () => null;

/**
 * One visitor-clock snapshot and UTC-boundary timer for day-scoped labels.
 * Server and first hydration retain null, never the build date.
 */
export function useUtcDayNowMs(): number | null {
  return useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
}
