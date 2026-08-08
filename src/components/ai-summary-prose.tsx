"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
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
          collapsible && !open && "max-sm:line-clamp-4",
        )}
      >
        {children}
      </p>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="pharos-focus-ring mt-2 inline-flex min-h-7 items-center gap-1 rounded-sm text-xs font-medium text-frost-blue sm:hidden"
        >
          {open ? "Show less" : "Read the full note"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}
