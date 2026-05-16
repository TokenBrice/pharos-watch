"use client";

import { useShowWorkMode } from "@/hooks/use-show-work-mode";

/**
 * Sitewide "Show inputs" / "Hide inputs" toggle. Pairs with
 * <ShowYourWorkPanel> instances on score cards: the toggle and the panel
 * swap visibility on the same `useShowWorkMode().enabled` flag.
 */
export function ShowYourWorkToggle({ className }: { className?: string }) {
  const { enabled, toggle } = useShowWorkMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      className={
        className ??
        "pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
      }
    >
      {enabled ? "Hide inputs" : "Show inputs"}
    </button>
  );
}
