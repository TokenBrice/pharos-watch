"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "pharos.show-work";
const URL_PARAM = "show-work";

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function readUrlEnable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get(URL_PARAM) === "1";
  } catch {
    return false;
  }
}

function readStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function readClient(): boolean {
  return readUrlEnable() || readStorage();
}

function writeStored(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ShowWorkMode {
  enabled: boolean;
  toggle: () => void;
  enable: () => void;
}

/**
 * Reads `?show-work=1` on mount and persists `pharos.show-work` in localStorage.
 * Server-rendered fallback returns enabled=false.
 */
export function useShowWorkMode(): ShowWorkMode {
  const enabled = useSyncExternalStore(
    subscribe,
    readClient,
    () => false,
  );

  const toggle = useCallback(() => {
    // Persistence is the source of truth for the toggle. Reading the URL
    // here would let `?show-work=1` shadow a "Hide inputs" click and silently
    // no-op. Storage flip + notify means the next read short-circuits to
    // localStorage=false even while the URL param is still present.
    writeStored(!readStorage());
    notify();
  }, []);

  const enable = useCallback(() => {
    writeStored(true);
    notify();
  }, []);

  return { enabled, toggle, enable };
}
