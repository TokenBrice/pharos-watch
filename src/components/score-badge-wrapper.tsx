"use client";

import type { ReactNode } from "react";
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
}

const SUFFIX_CLASS =
  "ml-1 font-mono text-[10px] text-muted-foreground select-none";

/**
 * Wraps a score badge with a methodology-aware tooltip (W1-C `<Term>` dispatch
 * via `MethodologyHint`) and, optionally, an inline `vX.Y` version suffix.
 *
 * The wrapper is intentionally thin: it stays out of the badge's visual layout
 * and renders the trigger as-is. Tailwind classes are static strings per
 * `CLAUDE.md`.
 */
export function ScoreBadgeWrapper({
  topic,
  variant = "suffix",
  children,
  className,
  suffixClassName,
}: ScoreBadgeWrapperProps) {
  const item = METHODOLOGY_CONTEXT[topic];
  const versionLabel = item?.versionLabel;
  const showSuffix = variant === "suffix" && !!versionLabel;

  return (
    <span className={cn("inline-flex items-center", className)}>
      <MethodologyHint topic={topic} asChild>
        {children}
      </MethodologyHint>
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
