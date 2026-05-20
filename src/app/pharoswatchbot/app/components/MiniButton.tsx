"use client";

import { cn } from "@/lib/utils";

export function MiniButton({ ariaLabel, children, disabled, onClick, variant = "primary" }: {
  ariaLabel?: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" ? "bg-[var(--telegram-button,var(--brand-accent))] text-[var(--telegram-button-text,white)] hover:opacity-90" : "",
        variant === "secondary" ? "border border-border/65 bg-background/70 text-foreground hover:bg-muted/45" : "",
        variant === "danger" ? "border border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300" : "",
      )}
    >
      {children}
    </button>
  );
}
