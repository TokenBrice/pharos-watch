"use client";

import { useSyncExternalStore } from "react";
import { getEffectiveReducedMotion, motionPreferenceStore } from "./use-motion-preference";

interface UsePrefersReducedMotionOptions {
  ssrDefault?: boolean;
}

function subscribeToMotionPreference(onChange: () => void) {
  return motionPreferenceStore.subscribe(onChange);
}

function getReducedMotionSnapshot() {
  return getEffectiveReducedMotion(motionPreferenceStore.getSnapshot(), false);
}

function getReducedMotionSnapshotWithSsrDefault() {
  return getEffectiveReducedMotion(motionPreferenceStore.getSnapshot(), true);
}

function getReducedMotionServerSnapshot() {
  return getEffectiveReducedMotion(motionPreferenceStore.getServerSnapshot(), false);
}

function getReducedMotionServerSnapshotWithSsrDefault() {
  return getEffectiveReducedMotion(motionPreferenceStore.getServerSnapshot(), true);
}

/**
 * Effective "should motion be reduced?" boolean. Derives from the shared
 * motion-preference store so an explicit user override (system/reduced/full)
 * is honored, falling back to the OS media query when set to "system". OS-level
 * changes also re-render so callers stay in sync without polling the media
 * query independently.
 */
export function usePrefersReducedMotion({ ssrDefault = false }: UsePrefersReducedMotionOptions = {}): boolean {
  const getSnapshot = ssrDefault ? getReducedMotionSnapshotWithSsrDefault : getReducedMotionSnapshot;
  const getServerSnapshot = ssrDefault ? getReducedMotionServerSnapshotWithSsrDefault : getReducedMotionServerSnapshot;

  return useSyncExternalStore(subscribeToMotionPreference, getSnapshot, getServerSnapshot);
}
