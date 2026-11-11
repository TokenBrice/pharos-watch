"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { InlineDisclosureToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { cn } from "@/lib/utils";

/** Notes shorter than this fit the clamp at every width. */
const CLAMP_THRESHOLD_CHARS = 250;

/**
 * The editorial paragraph clamps to ~4 serif lines below `sm` and 3 lines
 * from `sm` up (owner decisions 2026-08-08 and 2026-10-06 D9): unclamped, the
 * note runs a whole phone screen and pushes the Safety Score below the fold
 * on desktop. The full text stays in the DOM. After mount the toggle hides
 * whenever the clamp is not actually cutting anything at the current width.
 */
export function AiSummaryProse({ textLength, children }: { textLength: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(true);
  const proseRef = useRef<HTMLParagraphElement>(null);
  const collapsible = textLength > CLAMP_THRESHOLD_CHARS;

  useEffect(() => {
    const node = proseRef.current;
    if (!collapsible || open || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [collapsible, open]);

  return (
    <>
      <p
        ref={proseRef}
        className={cn(
          "font-serif text-[1.05rem] leading-relaxed text-foreground/90 italic",
          collapsible && !open && "line-clamp-4 sm:line-clamp-3",
        )}
      >
        {children}
      </p>
      {collapsible && (open || overflowing) ? (
        <InlineDisclosureToggle
          open={open}
          onToggle={() => setOpen((value) => !value)}
          collapsedLabel="Read the full note"
          size="md"
          className="mt-2"
        />
      ) : null}
    </>
  );
}
