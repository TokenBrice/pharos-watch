"use client";

import { useSyncExternalStore } from "react";

export const OPEN_NAV_DRAWER_EVENT = "open-nav-drawer";

export function openNavDrawer(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_NAV_DRAWER_EVENT));
}

// The drawer's open state, published by its owner (Header) so an opener can
// expose aria-expanded.
let drawerOpen = false;
const drawerListeners = new Set<() => void>();

export function setNavDrawerOpen(open: boolean): void {
  if (drawerOpen === open) return;
  drawerOpen = open;
  drawerListeners.forEach((listener) => listener());
}

function subscribeNavDrawer(listener: () => void): () => void {
  drawerListeners.add(listener);
  return () => drawerListeners.delete(listener);
}

export function useNavDrawerOpen(): boolean {
  return useSyncExternalStore(subscribeNavDrawer, () => drawerOpen, () => false);
}
