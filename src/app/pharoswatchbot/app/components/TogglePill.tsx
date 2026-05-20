"use client";

import { cn } from "@/lib/utils";

export function TogglePill({ label, enabled, disabled, onToggle, ariaLabel }: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        enabled ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
      )}
    >
      <span>{label}</span>
      <span className={cn("h-2.5 w-2.5 rounded-full", enabled ? "bg-sky-500" : "bg-muted-foreground/35")} />
    </button>
  );
}
