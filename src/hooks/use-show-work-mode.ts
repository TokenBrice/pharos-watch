"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

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

function readStorageOverride(): boolean | null {
  const stored = safeStorageGetItem(getWindowStorage("local"), STORAGE_KEY);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return null;
}

function readClient(): boolean {
  const stored = readStorageOverride();
  if (stored !== null) return stored;
  return readUrlEnable();
}

function writeStored(value: boolean) {
  safeStorageSetItem(getWindowStorage("local"), STORAGE_KEY, value ? "true" : "false");
}

function removeUrlParam() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(URL_PARAM)) return;
    url.searchParams.delete(URL_PARAM);
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // ignore URL/history failures
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
 * Reads `?show-work=1` on mount, then lets an explicit `pharos.show-work`
 * localStorage preference override the URL flag.
 * Server-rendered fallback returns enabled=false.
 */
export function useShowWorkMode(): ShowWorkMode {
  const enabled = useSyncExternalStore(
    subscribe,
    readClient,
    () => false,
  );

  const toggle = useCallback(() => {
    const next = !readClient();
    writeStored(next);
    if (!next) removeUrlParam();
    notify();
  }, []);

  const enable = useCallback(() => {
    writeStored(true);
    notify();
  }, []);

  return { enabled, toggle, enable };
}
