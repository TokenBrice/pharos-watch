"use client";

import { useEffect } from "react";

/** Opens every `<details>` enclosing the element named by the hash; returns it when one was opened. */
export function openDisclosuresForHash(hash: string): HTMLElement | null {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return null;
  const target = document.getElementById(id);
  let opened = false;
  for (let details = target?.closest("details"); details; details = details.parentElement?.closest("details")) {
    if (!details.open) {
      details.open = true;
      opened = true;
    }
  }
  return opened ? target : null;
}

/**
 * Keeps deep links into folded `<details>` working: on load and on every hash
 * change, open the enclosing folds and scroll to the target (the browser's
 * own jump already ran against the closed fold).
 */
export function DisclosureHashReveal() {
  useEffect(() => {
    const reveal = () => openDisclosuresForHash(window.location.hash)?.scrollIntoView({ block: "start" });
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  return null;
}
