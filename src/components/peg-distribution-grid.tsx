"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import type { PegCurrency } from "@shared/types";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS } from "@/lib/peg-landing";

const PEG_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-md border border-border/70 bg-background/50 px-2 py-1 text-sm font-medium leading-none text-foreground/90 transition-[background-color,border-color,color] hover:border-border hover:bg-muted hover:text-foreground";

interface PegBrowseChip {
  key: string;
  href: string;
  label: string;
  count: number;
}

/** Group pegs into semantic categories for the browse strip. */
type PegGroup = { label: string; pegs: typeof ACTIVE_PEGS };
function groupPegs(pegs: typeof ACTIVE_PEGS): PegGroup[] {
  const fiat: typeof ACTIVE_PEGS = [];
  const commodity: typeof ACTIVE_PEGS = [];
  const other: typeof ACTIVE_PEGS = [];
  for (const peg of pegs) {
    if (peg === "GOLD" || peg === "SILVER") commodity.push(peg);
    else if (peg === "VAR" || peg === "OTHER") other.push(peg);
    else fiat.push(peg);
  }
  const groups: PegGroup[] = [];
  if (fiat.length > 0) groups.push({ label: "Fiat", pegs: fiat });
  if (commodity.length > 0) groups.push({ label: "Commodity", pegs: commodity });
  if (other.length > 0) groups.push({ label: "Other", pegs: other });
  return groups;
}

const COLLAPSED_FIAT_PREVIEW_ORDER: PegCurrency[] = ["USD", "EUR", "GBP", "BRL"];

function buildPegChip(peg: PegCurrency, countFn: (peg: (typeof ACTIVE_PEGS)[number]) => number): PegBrowseChip | null {
  const slug = PEG_SLUGS[peg];
  if (!slug) return null;

  return {
    key: peg,
    href: `/stablecoins/${slug}/`,
    label: PEG_LABELS_SHORT[peg],
    count: countFn(peg),
  };
}

function buildCollapsedFiatPreview(
  pegs: typeof ACTIVE_PEGS,
  countFn: (peg: (typeof ACTIVE_PEGS)[number]) => number,
): PegBrowseChip[] {
  return COLLAPSED_FIAT_PREVIEW_ORDER.flatMap((peg) =>
    pegs.includes(peg) ? [buildPegChip(peg, countFn)].filter((chip): chip is PegBrowseChip => chip !== null) : [],
  );
}

export function PegBrowseStrip({
  pegs,
  pegCoinCount: countFn,
}: {
  pegs: typeof ACTIVE_PEGS;
  pegCoinCount: (peg: (typeof ACTIVE_PEGS)[number]) => number;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupPegs(pegs), [pegs]);
  const fiatGroup = useMemo(() => groups.find((group) => group.label === "Fiat") ?? null, [groups]);
  const fiatPreview = useMemo(() => buildCollapsedFiatPreview(fiatGroup?.pegs ?? [], countFn), [countFn, fiatGroup]);

  // Collapsed: selected fiat previews + an aggregate non-USD fiat lens.
  const fiatPegCount = fiatGroup?.pegs.length ?? 0;
  const hasFiatOverflow = fiatPegCount > fiatPreview.length;

  return (
    <div className="pharos-peg-browse-shell">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
        <h3 className="text-sm font-medium text-muted-foreground">Browse By Peg</h3>
        {hasFiatOverflow && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-md border border-border/70 bg-background/45 px-2.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {expanded ? "View Less" : "View More"}
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={expanded ? "divide-y divide-border/55" : "flex flex-wrap items-center divide-x divide-border/55"}>
        {groups.map((group) => {
          const visibleItems =
            !expanded && group.label === "Fiat"
              ? fiatPreview
              : group.pegs
                  .map((peg) => buildPegChip(peg, countFn))
                  .filter((chip): chip is PegBrowseChip => chip !== null);
          return (
            <div
              key={group.label}
              className={
                expanded ? "grid grid-cols-[96px_minmax(0,1fr)]" : "flex min-h-11 items-center gap-2 px-3 py-2"
              }
            >
              <span
                className={
                  expanded
                    ? "border-r border-border/55 px-3 py-2 text-sm text-muted-foreground"
                    : "text-sm text-muted-foreground"
                }
              >
                {group.label}
              </span>
              <div
                className={
                  expanded ? "flex flex-wrap items-center gap-1.5 px-3 py-2" : "flex flex-wrap items-center gap-1.5"
                }
              >
                {visibleItems.map((item) => {
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      className={PEG_PILL_CLASS}
                      aria-label={`${item.label} (${item.count})`}
                    >
                      {item.label}
                      <span className="text-muted-foreground">·</span>
                      <span className="font-mono tabular-nums text-muted-foreground">{item.count}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
