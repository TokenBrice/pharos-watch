"use client";

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

function readSystemReduced(ssrDefault = false): boolean {
  if (typeof window === "undefined") return ssrDefault;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? ssrDefault;
}

/**
 * Resolve a motion preference into the single boolean "should motion be reduced?"
 * that components honor. An explicit "full" override always wins over the OS
 * media query; "system" defers to the OS signal.
 */
export function getEffectiveReducedMotion(pref: MotionPreference, ssrDefault = false): boolean {
  if (pref === "full") return false;
  if (pref === "reduced") return true;
  return readSystemReduced(ssrDefault);
}

function applyToBody(pref: MotionPreference) {
  if (typeof document === "undefined") return;
  const effectiveReduced = getEffectiveReducedMotion(pref);
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

/**
 * Low-level store accessors so other hooks (e.g. usePrefersReducedMotion) can
 * derive their result from the same single source of truth instead of reading
 * the OS media query a second time and diverging from the user's override.
 */
export const motionPreferenceStore = {
  subscribe,
  getSnapshot,
  getServerSnapshot,
};
