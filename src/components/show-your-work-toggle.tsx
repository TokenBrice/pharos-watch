"use client";

import { useShowWorkMode } from "@/hooks/use-show-work-mode";

/**
 * Small "Show inputs" link rendered next to a score when Show Your Work is off.
 * Clicking it enables SYW mode and the adjacent <ShowYourWorkPanel> expands inline.
 */
export function ShowYourWorkToggle({ className }: { className?: string }) {
  const { enabled, enable } = useShowWorkMode();
  if (enabled) return null;
  return (
    <button
      type="button"
      onClick={enable}
      className={
        className ??
        "pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
      }
    >
      Show inputs
    </button>
  );
}
