"use client";

export const OPEN_NAV_DRAWER_EVENT = "open-nav-drawer";

export function openNavDrawer(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_NAV_DRAWER_EVENT));
}
