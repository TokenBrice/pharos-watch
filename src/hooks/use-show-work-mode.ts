"use client";

import { useCallback, useSyncExternalStore } from "react";
import { createBrowserStorageStore } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos.show-work";
const URL_PARAM = "show-work";

const showWorkStorage = createBrowserStorageStore<boolean | null>({
  key: STORAGE_KEY,
  fallback: null,
  decode: (stored) => {
    if (stored === "true") return true;
    if (stored === "false") return false;
    return null;
  },
  encode: (value) => (value ? "true" : "false"),
});

function readUrlEnable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get(URL_PARAM) === "1";
  } catch {
    return false;
  }
}

function readStorageOverride(): boolean | null {
  return showWorkStorage.read();
}

function readClient(): boolean {
  const stored = readStorageOverride();
  if (stored !== null) return stored;
  return readUrlEnable();
}

function writeStored(value: boolean) {
  showWorkStorage.write(value);
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
    showWorkStorage.subscribe,
    readClient,
    () => false,
  );

  const toggle = useCallback(() => {
    const next = !readClient();
    writeStored(next);
    if (!next) removeUrlParam();
  }, []);

  const enable = useCallback(() => {
    writeStored(true);
  }, []);

  return { enabled, toggle, enable };
}
