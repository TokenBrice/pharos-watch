"use client";

import { useState } from "react";
import {
  InlineDisclosureToggle,
  type InlineDisclosureToggleSize,
} from "@/components/stablecoin-detail/disclosure-toggles";
import { buildProseLead, PROSE_COLLAPSE_THRESHOLD } from "@/components/stablecoin-detail/prose-lead";
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
}: {
  text: string;
  /** Paragraph type scale, e.g. `text-xs` or `whitespace-pre-line text-sm`. */
  className?: string;
  collapsedLabel?: string;
  /** Placement utilities for the toggle (margins). */
  toggleClassName?: string;
  size?: InlineDisclosureToggleSize;
}) {
  const [open, setOpen] = useState(false);
  const collapsible = text.length > PROSE_COLLAPSE_THRESHOLD;
  const showLead = collapsible && !open;

  return (
    <>
      {/* `className` merges first on purpose: `tailwind-merge` treats a later
          `text-{size}` as overriding `leading-*`, so a base-first merge would
          silently drop `leading-relaxed` for every caller that sets a size. */}
      <p className={cn(className, "leading-relaxed text-muted-foreground")}>
        {showLead ? buildProseLead(text) : text}
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
