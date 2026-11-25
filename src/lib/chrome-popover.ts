"use client";

export type ChromeOverlaySource =
  | "top-nav"
  | "appearance"
  | "regime-bar"
  | "command-palette"
  | "keyboard-shortcuts"
  | "nav-drawer";

export const CHROME_DISMISS_EVENT = "pharos:chrome-dismiss";
export const OPEN_KEYBOARD_SHORTCUTS_EVENT = "pharos:open-keyboard-shortcuts";

export interface ChromeDismissDetail {
  source: ChromeOverlaySource;
}

/**
 * Ask every global chrome overlay other than `source` to close so desktop
 * dropdowns, the expanded PSI regime strip, appearance popover, command
 * palette, and dialogs never overlap or fight over Escape/focus.
 */
export function dismissChromeOverlays(source: ChromeOverlaySource): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChromeDismissDetail>(CHROME_DISMISS_EVENT, { detail: { source } }));
}

export function subscribeChromeDismiss(
  self: ChromeOverlaySource,
  onDismiss: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ChromeDismissDetail>).detail;
    if (detail?.source === self) return;
    onDismiss();
  };
  window.addEventListener(CHROME_DISMISS_EVENT, handler);
  return () => window.removeEventListener(CHROME_DISMISS_EVENT, handler);
}

/** Open the keyboard shortcuts dialog from any chrome surface (including editorial routes). */
export function openKeyboardShortcuts(): void {
  if (typeof window === "undefined") return;
  dismissChromeOverlays("keyboard-shortcuts");
  window.dispatchEvent(new CustomEvent(OPEN_KEYBOARD_SHORTCUTS_EVENT));
}
