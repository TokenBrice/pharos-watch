"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
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
 * Chromium auto-expands it on find-in-page. The wrapped cards carry no anchor
 * ids (rail and in-flow copies coexist), so no hash-navigation reveal is
 * needed. The rail instance at `xl+` renders the bare card and is untouched;
 * this wrapper only ever appears inside the `xl:hidden` mounts.
 */
export function RailCopyFold({
  title,
  chip,
  children,
}: {
  title: string;
  /** Scan-level status chip mirrored from the card's own header badge. */
  chip?: RailCopyFoldChip | null;
  children: ReactNode;
}) {
  return (
    <details className="group">
      <summary
        className={cn(
          "pharos-card-shell pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3",
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
      <div className="mt-3">{children}</div>
    </details>
  );
}
