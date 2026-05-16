"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { MethodologyHint } from "@/components/methodology-hint";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";
import { cn } from "@/lib/utils";

export type ScoreBadgeWrapperVariant = "suffix" | "tooltip-only";

interface ScoreBadgeWrapperProps {
  /** Methodology context key used for the version label and tooltip dispatch. */
  topic: MethodologyContextKey;
  /**
   * - `"suffix"` (default): renders the methodology version as a small monospace
   *   superscript next to the badge.
   * - `"tooltip-only"`: badge gets the methodology-aware tooltip but no
   *   inline version chip. Used in table cells where the column header
   *   already exposes the version.
   */
  variant?: ScoreBadgeWrapperVariant;
  /** The score badge being wrapped. Rendered as the tooltip/sheet trigger. */
  children: ReactNode;
  className?: string;
  /** Additional class for the suffix span. */
  suffixClassName?: string;
  /**
   * When false, renders the badge/version only and skips the methodology
   * trigger. Use inside link-wrapped cards to avoid nested interactive
   * controls.
   */
  interactive?: boolean;
}

const SUFFIX_CLASS =
  "ml-1 font-mono text-[10px] text-muted-foreground select-none";

const ScoreBadgeTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { topic: MethodologyContextKey }
>(function ScoreBadgeTrigger({ topic, children, className, onClick, onKeyDown, type = "button", ...props }, ref) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={`Explain ${item.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        onKeyDown?.(event);
      }}
      className={cn(
        "pharos-focus-ring inline-flex appearance-none items-center rounded-full border-0 bg-transparent p-0 text-inherit",
        className,
      )}
    >
      {children}
    </button>
  );
});

/**
 * Wraps a score badge with a methodology-aware tooltip (W1-C `<Term>` dispatch
 * via `MethodologyHint`) and, optionally, an inline `vX.Y` version suffix.
 *
 * The wrapper supplies the trigger as a real `<button>` so badge-shaped spans
 * remain keyboard and screen-reader safe when they open methodology context.
 */
export function ScoreBadgeWrapper({
  topic,
  variant = "suffix",
  children,
  className,
  suffixClassName,
  interactive = true,
}: ScoreBadgeWrapperProps) {
  const item = METHODOLOGY_CONTEXT[topic];
  const versionLabel = item?.versionLabel;
  const showSuffix = variant === "suffix" && !!versionLabel;
  const trigger = interactive ? (
    <MethodologyHint topic={topic} asChild>
      <ScoreBadgeTrigger topic={topic}>{children}</ScoreBadgeTrigger>
    </MethodologyHint>
  ) : (
    children
  );

  return (
    <span className={cn("inline-flex items-center", className)}>
      {trigger}
      {showSuffix ? (
        <sup
          aria-hidden="true"
          className={cn(SUFFIX_CLASS, suffixClassName)}
          data-score-badge-version={versionLabel}
        >
          {versionLabel}
        </sup>
      ) : null}
    </span>
  );
}
