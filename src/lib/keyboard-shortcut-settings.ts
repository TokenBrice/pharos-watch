"use client";

import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

// WCAG 2.2 SC 2.1.4: single-character shortcuts must be disableable.
// Read at keypress time so document-level handlers and the shortcuts dialog
// stay in sync.
// Stored value is the legacy "pharos-sidebar-shortcut-disabled" key so
// existing users' preference survives.
const SINGLE_KEY_SHORTCUT_DISABLED_STORAGE_KEY = "pharos-sidebar-shortcut-disabled";

export function isSingleKeyShortcutDisabled(): boolean {
  return safeStorageGetItem(getWindowStorage("local"), SINGLE_KEY_SHORTCUT_DISABLED_STORAGE_KEY) === "true";
}

export function setSingleKeyShortcutDisabled(disabled: boolean): void {
  safeStorageSetItem(getWindowStorage("local"), SINGLE_KEY_SHORTCUT_DISABLED_STORAGE_KEY, String(disabled));
}
