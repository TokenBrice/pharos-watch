"use client";

import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function MiniButton({ ariaLabel, children, disabled, loading = false, onClick, variant = "primary" }: {
  ariaLabel?: string;
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" ? "bg-[var(--telegram-button,var(--brand-accent))] text-[var(--telegram-button-text,white)] hover:opacity-90" : "",
        variant === "secondary" ? "border border-border/65 bg-background/70 text-foreground hover:bg-muted/45" : "",
        variant === "danger" ? "border border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300" : "",
      )}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
