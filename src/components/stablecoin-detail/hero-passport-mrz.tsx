"use client";

import { useEffect, useRef, useState } from "react";
import type { HeroPassportMrzViewModel } from "@/lib/stablecoin-detail-mrz";

const MRZ_LINE_CLASS =
  "block select-none whitespace-nowrap font-mono text-[10px] uppercase leading-snug tracking-[0.18em] text-muted-foreground sm:text-[11px]";

/**
 * Dossier machine-readable zone: the passport's TD3-style footer — two
 * 44-char OCR lines where every character re-encodes a fact already on the
 * card. The whole zone is one button that copies a human-readable research
 * citation; the glyph lines are decorative duplicates (aria-hidden), the
 * button's aria-label carries the meaning. Lines are never truncated.
 */
export function HeroPassportMrz({ mrz }: { mrz: HeroPassportMrzViewModel }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(mrz.copyText);
    } catch {
      // Clipboard unavailable (non-secure context) — keep the resting label.
      return;
    }
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={copySummary}
      aria-label={mrz.ariaLabel}
      className="pharos-focus-ring group flex w-full flex-wrap items-baseline gap-y-0.5 border-t border-border/30 px-4 py-2 text-left sm:px-5"
    >
      {/* Zero gap between the segments: where the width allows, they read as
          one continuous 88-char machine line; narrower viewports wrap back to
          the stacked TD3 pair at the segment boundary. */}
      <span aria-hidden="true" className={MRZ_LINE_CLASS}>
        {mrz.lines[0]}
      </span>
      <span aria-hidden="true" className={MRZ_LINE_CLASS}>
        {mrz.lines[1]}
      </span>
      {/* In-flow and right-aligned: the COPY SUMMARY ⇄ COPIED swap only moves
          its own left edge, so the glyph lines never shift. */}
      <span className="ml-auto shrink-0 pl-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? "Copied" : "Copy summary"}
      </span>
    </button>
  );
}
