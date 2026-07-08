"use client";

import type { ReactNode } from "react";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";

/**
 * Sitewide "Show inputs" / "Hide inputs" toggle. Pairs with
 * <ShowYourWorkPanel> instances on score cards: the toggle and the panel
 * swap visibility on the same `useShowWorkMode().enabled` flag.
 */
export function ShowYourWorkToggle({ className, children }: { className?: string; children?: ReactNode }) {
  const { enabled, toggle } = useShowWorkMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      className={
        className ??
        "pharos-focus-ring min-h-11 rounded-sm py-2 text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground sm:min-h-0 sm:py-0"
      }
    >
      {children ?? (enabled ? "Hide inputs" : "Show inputs")}
    </button>
  );
}
