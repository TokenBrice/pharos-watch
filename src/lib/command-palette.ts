"use client";

export const OPEN_COMMAND_PALETTE_EVENT = "open-command-palette";

export function openCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}
