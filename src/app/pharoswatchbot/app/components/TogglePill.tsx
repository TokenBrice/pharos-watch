"use client";

import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function TogglePill({ label, enabled, disabled, loading = false, onToggle, ariaLabel }: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  loading?: boolean;
  onToggle: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={onToggle}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        enabled ? "mini-selected" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
      )}
    >
      {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      <span>{label}</span>
      <span className={cn("h-2.5 w-2.5 rounded-full", enabled ? "mini-dot-on" : "bg-muted-foreground/35")} />
    </button>
  );
}
