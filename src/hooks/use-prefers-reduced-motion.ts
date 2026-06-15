"use client";

import { useSyncExternalStore } from "react";
import {
  getEffectiveReducedMotion,
  motionPreferenceStore,
} from "./use-motion-preference";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface UsePrefersReducedMotionOptions {
  ssrDefault?: boolean;
}

/**
 * Effective "should motion be reduced?" boolean. Derives from the shared
 * motion-preference store so an explicit user override (system/reduced/full)
 * is honored, falling back to the OS media query when set to "system". OS-level
 * changes also re-render so callers stay in sync without polling the media
 * query independently.
 */
export function usePrefersReducedMotion({
  ssrDefault = false,
}: UsePrefersReducedMotionOptions = {}): boolean {
  const subscribe = (onChange: () => void) => {
    const unsubscribeStore = motionPreferenceStore.subscribe(onChange);
    const media = typeof window !== "undefined" ? window.matchMedia?.(REDUCED_MOTION_QUERY) : undefined;
    media?.addEventListener("change", onChange);
    return () => {
      unsubscribeStore();
      media?.removeEventListener("change", onChange);
    };
  };

  const getSnapshot = () =>
    getEffectiveReducedMotion(motionPreferenceStore.getSnapshot(), ssrDefault);

  const getServerSnapshot = () =>
    getEffectiveReducedMotion(motionPreferenceStore.getServerSnapshot(), ssrDefault);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
