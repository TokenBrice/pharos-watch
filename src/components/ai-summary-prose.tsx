"use client";

import { useState, type ReactNode } from "react";
import { InlineDisclosureToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { cn } from "@/lib/utils";

/** Notes shorter than this lose nothing to a 4-line phone clamp. */
const CLAMP_THRESHOLD_CHARS = 350;

/**
 * The editorial paragraph clamps to ~4 serif lines below `sm` (owner decision
 * 2026-08-08) — on a phone the full note runs a whole screen. Tablet and
 * desktop always show the full paragraph; the full text stays in the DOM.
 */
export function AiSummaryProse({ textLength, children }: { textLength: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const collapsible = textLength > CLAMP_THRESHOLD_CHARS;

  return (
    <>
      <p
        className={cn(
          "font-serif text-[1.05rem] leading-relaxed text-foreground/90 italic",
          collapsible && !open && "line-clamp-4 sm:line-clamp-none",
        )}
      >
        {children}
      </p>
      {collapsible ? (
        <InlineDisclosureToggle
          open={open}
          onToggle={() => setOpen((value) => !value)}
          collapsedLabel="Read the full note"
          size="md"
          className="mt-2 sm:hidden"
        />
      ) : null}
    </>
  );
}
