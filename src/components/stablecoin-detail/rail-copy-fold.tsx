"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { revealAnchorTarget } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";

export interface RailCopyFoldChip {
  label: string;
  toneClass: string;
}

/**
 * Below-`xl` accordion for the shared rail-module in-flow copies. At `xl+` the
 * eight shared modules are a glanceable sidebar; below `xl` they used to stack
 * fully expanded into the main column — a ~2.3k px wall of identically shaped
 * review cards on phones. This wrapper keeps the scan-level signal (title +
 * status chip) in a collapsed card band and folds the card body.
 *
 * Native `<details>` keeps the folded card in the DOM — crawlable, and
 * Chromium auto-expands it on find-in-page. Most wrapped cards carry no anchor
 * ids (rail and in-flow copies coexist); the one that does — Mechanism review,
 * `#mechanism-review` — passes `id` here so the fold band itself is the anchor
 * target and opens on hash navigation. The rail instance at `xl+` renders the
 * bare card and is untouched; this wrapper only ever appears inside the
 * `xl:hidden` mounts.
 */
export function RailCopyFold({
  title,
  chip,
  id,
  children,
}: {
  title: string;
  /** Scan-level status chip mirrored from the card's own header badge. */
  chip?: RailCopyFoldChip | null;
  /** Anchor id on the <details> so hash navigation can reveal + open it. */
  id?: string;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // Deep links arrive both on load (before lazy sections settle, which is why
  // `DetailContent` also sweeps once on mount) and while the page is already
  // open, when only `hashchange` fires.
  useEffect(() => {
    if (!id) return;
    const openOnHashMatch = () => {
      const targetId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (targetId === id) revealAnchorTarget(detailsRef.current);
    };
    openOnHashMatch();
    window.addEventListener("hashchange", openOnHashMatch);
    return () => window.removeEventListener("hashchange", openOnHashMatch);
  }, [id]);
  // The band IS the card shell: children mount frameless (body-only, no second
  // shell/header) so opening extends the same box instead of revealing a
  // nested card that repeats the title and chip.
  return (
    <details
      ref={detailsRef}
      id={id}
      className={cn("group pharos-card-shell overflow-hidden", id ? SECTION_SCROLL_MT : undefined)}
    >
      <summary
        className={cn(
          "pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3",
          "px-4 py-3.5 [&::-webkit-details-marker]:hidden",
        )}
      >
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>{title}</h2>
        <span className="flex shrink-0 items-center gap-2">
          {chip ? (
            <Badge variant="outline" className={cn("text-[11px] font-medium", chip.toneClass)}>
              {chip.label}
            </Badge>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </span>
      </summary>
      {children}
    </details>
  );
}
