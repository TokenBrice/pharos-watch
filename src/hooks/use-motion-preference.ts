"use client";

import { useCallback, useSyncExternalStore } from "react";
import { createBrowserStorageStore } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos-motion-preference-v1";

export type MotionPreference = "system" | "reduced" | "full";

const listeners = new Set<() => void>();
let currentPreference: MotionPreference = "system";

function isMotionPreference(value: unknown): value is MotionPreference {
  return value === "system" || value === "reduced" || value === "full";
}

const motionPreferenceStorage = createBrowserStorageStore<MotionPreference>({
  key: STORAGE_KEY,
  fallback: "system",
  decode: (raw) => (isMotionPreference(raw) ? raw : null),
});

function applyToBody(pref: MotionPreference) {
  if (typeof document === "undefined") return;
  const systemReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const effectiveReduced = pref === "reduced" || (pref === "system" && systemReduced);
  const motionValue = pref === "full" ? "full" : effectiveReduced ? "reduced" : null;
  const roots = [document.documentElement, document.body];

  for (const root of roots) {
    if (motionValue) {
      root.setAttribute("data-motion", motionValue);
    } else {
      root.removeAttribute("data-motion");
    }
  }
}

function notify() {
  for (const listener of listeners) listener();
}

// Hydrate the singleton once on module load (client only).
if (typeof window !== "undefined") {
  currentPreference = motionPreferenceStorage.read();
  applyToBody(currentPreference);
  // Re-evaluate body attribute when the OS-level preference flips while we're in
  // "system" mode. Components reading the React state stay accurate because they
  // re-subscribe via notify().
  try {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onSystemChange = () => {
      applyToBody(currentPreference);
      notify();
    };
    mql.addEventListener("change", onSystemChange);
  } catch {
    // matchMedia change events unavailable; the toggle still works on user input.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MotionPreference {
  return currentPreference;
}

function getServerSnapshot(): MotionPreference {
  return "system";
}

export interface MotionPreferenceApi {
  preference: MotionPreference;
  setPreference: (next: MotionPreference) => void;
}

/**
 * Site-level reduce-motion toggle (IDEA-11). Persists to localStorage and
 * mirrors the effective state onto the root/body `data-motion` attribute so
 * CSS can honor the explicit override in addition to the OS-level media query.
 */
export function useMotionPreference(): MotionPreferenceApi {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPreference = useCallback((next: MotionPreference) => {
    currentPreference = next;
    if (typeof window !== "undefined") {
      motionPreferenceStorage.write(next);
    }
    applyToBody(next);
    notify();
  }, []);

  return { preference, setPreference };
}
