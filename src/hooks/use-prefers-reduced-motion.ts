"use client";

import { useSyncExternalStore } from "react";
import { createBrowserStorageStore } from "@/lib/browser-storage";

interface UsePrefersReducedMotionOptions {
  ssrDefault?: boolean;
}

type MotionPreference = "system" | "reduced" | "full";

const listeners = new Set<() => void>();
let currentPreference: MotionPreference = "system";
const motionPreferenceStorage = createBrowserStorageStore<MotionPreference>({
  key: "pharos-motion-preference-v1",
  fallback: "system",
  decode: (raw) => raw === "system" || raw === "reduced" || raw === "full" ? raw : null,
});

function getEffectiveReducedMotion(pref: MotionPreference, ssrDefault = false): boolean {
  if (pref === "full") return false;
  if (pref === "reduced") return true;
  if (typeof window === "undefined") return ssrDefault;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? ssrDefault;
}

function applyToBody(pref: MotionPreference) {
  if (typeof document === "undefined") return;
  const effectiveReduced = getEffectiveReducedMotion(pref);
  const motionValue = pref === "full" ? "full" : effectiveReduced ? "reduced" : null;

  for (const root of [document.documentElement, document.body]) {
    if (motionValue) root.setAttribute("data-motion", motionValue);
    else root.removeAttribute("data-motion");
  }
}

function notify() {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  currentPreference = motionPreferenceStorage.read();
  applyToBody(currentPreference);
  try {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => {
      applyToBody(currentPreference);
      notify();
    });
  } catch {
    // matchMedia change events unavailable; the persisted preference still applies.
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getReducedMotionSnapshot() {
  return getEffectiveReducedMotion(currentPreference, false);
}

function getReducedMotionSnapshotWithSsrDefault() {
  return getEffectiveReducedMotion(currentPreference, true);
}

// Server snapshots are also used for the client's hydration render, so they
// must ignore window/matchMedia and the stored override; reading them here made
// reduced-motion visitors hydrate against different markup (React #418).
function getReducedMotionServerSnapshot() {
  return false;
}

function getReducedMotionServerSnapshotWithSsrDefault() {
  return true;
}

/**
 * Effective "should motion be reduced?" boolean. Honors the persisted override,
 * falling back to the OS media query when set to "system".
 */
export function usePrefersReducedMotion({ ssrDefault = false }: UsePrefersReducedMotionOptions = {}): boolean {
  const getSnapshot = ssrDefault ? getReducedMotionSnapshotWithSsrDefault : getReducedMotionSnapshot;
  const getServerSnapshot = ssrDefault ? getReducedMotionServerSnapshotWithSsrDefault : getReducedMotionServerSnapshot;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
