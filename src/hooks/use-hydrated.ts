"use client";

import { useSyncExternalStore } from "react";

let hydrated = false;
let scheduled = false;
const listeners = new Set<() => void>();

function notifyHydrated() {
  hydrated = true;
  scheduled = false;
  for (const listener of listeners) {
    listener();
  }
}

function scheduleHydration() {
  if (hydrated || scheduled || typeof window === "undefined") return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(notifyHydrated);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  scheduleHydration();
  return () => {
    listeners.delete(listener);
  };
}

export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => hydrated,
    () => false,
  );
}
