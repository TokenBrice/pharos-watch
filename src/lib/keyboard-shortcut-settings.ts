"use client";

import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

// WCAG 2.2 SC 2.1.4: single-character shortcuts must be disableable.
// Read at keypress time so the sidebar handler and the shortcuts dialog
// stay in sync without extra event wiring.
const SIDEBAR_SHORTCUT_DISABLED_STORAGE_KEY = "pharos-sidebar-shortcut-disabled";

export function isSidebarShortcutDisabled(): boolean {
  return safeStorageGetItem(getWindowStorage("local"), SIDEBAR_SHORTCUT_DISABLED_STORAGE_KEY) === "true";
}

export function setSidebarShortcutDisabled(disabled: boolean): void {
  safeStorageSetItem(getWindowStorage("local"), SIDEBAR_SHORTCUT_DISABLED_STORAGE_KEY, String(disabled));
}
