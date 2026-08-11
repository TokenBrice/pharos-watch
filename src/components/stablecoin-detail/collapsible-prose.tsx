"use client";

import { useState } from "react";
import {
  InlineDisclosureToggle,
  type InlineDisclosureToggleSize,
} from "@/components/stablecoin-detail/disclosure-toggles";
import {
  buildProseLead,
  PROSE_COLLAPSE_THRESHOLD,
  PROSE_LEAD_CHARS,
  RAIL_PROSE_COLLAPSE_THRESHOLD,
  RAIL_PROSE_LEAD_CHARS,
} from "@/components/stablecoin-detail/prose-lead";
import { cn } from "@/lib/utils";

/**
 * Reviewed analyst prose folded by the shared `prose-lead` rule: long notes cut
 * to a lead in the string (never `line-clamp`, so the fold does not move with
 * the viewport) behind one inline toggle. Short notes render whole with no
 * control at all, so the affordance never appears as a no-op.
 */
export function CollapsibleProse({
  text,
  className,
  collapsedLabel = "Read more",
  toggleClassName,
  size,
  variant = "default",
}: {
  text: string;
  /** Paragraph type scale, e.g. `text-xs` or `whitespace-pre-line text-sm`. */
  className?: string;
  collapsedLabel?: string;
  /** Placement utilities for the toggle (margins). */
  toggleClassName?: string;
  size?: InlineDisclosureToggleSize;
  /**
   * `"rail"` folds to a ~3-line lead sized for the 22rem summary rail. The
   * default lead is measured for the main column and is about seven lines
   * there, which is why stacked rail prose modules read as a wall.
   */
  variant?: "default" | "rail";
}) {
  const [open, setOpen] = useState(false);
  const rail = variant === "rail";
  const threshold = rail ? RAIL_PROSE_COLLAPSE_THRESHOLD : PROSE_COLLAPSE_THRESHOLD;
  const leadChars = rail ? RAIL_PROSE_LEAD_CHARS : PROSE_LEAD_CHARS;
  const collapsible = text.length > threshold;
  const showLead = collapsible && !open;

  return (
    <>
      {/* `className` merges first on purpose: `tailwind-merge` treats a later
          `text-{size}` as overriding `leading-*`, so a base-first merge would
          silently drop `leading-relaxed` for every caller that sets a size. */}
      <p className={cn(className, "leading-relaxed text-muted-foreground")}>
        {showLead ? buildProseLead(text, leadChars) : text}
      </p>
      {collapsible ? (
        <InlineDisclosureToggle
          open={open}
          onToggle={() => setOpen((value) => !value)}
          collapsedLabel={collapsedLabel}
          size={size}
          className={toggleClassName}
        />
      ) : null}
    </>
  );
}
