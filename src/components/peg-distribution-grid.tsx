"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PegCurrency } from "@shared/types";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS } from "@/lib/peg-landing";

const PEG_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/70 bg-background/55 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground sm:min-h-9 sm:py-1";

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

const COLLAPSED_FIAT_PREVIEW_ORDER: PegCurrency[] = ["USD", "EUR", "CHF"];

function buildPegChip(
  peg: PegCurrency,
  countFn: (peg: (typeof ACTIVE_PEGS)[number]) => number,
): PegBrowseChip | null {
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
  const preview = COLLAPSED_FIAT_PREVIEW_ORDER.flatMap((peg) => (
    pegs.includes(peg) ? [buildPegChip(peg, countFn)].filter((chip): chip is PegBrowseChip => chip !== null) : []
  ));

  const fiatExceptUsdCount = pegs
    .filter((peg) => peg !== "USD")
    .reduce((sum, peg) => sum + countFn(peg), 0);

  if (fiatExceptUsdCount > 0) {
    preview.push({
      key: "fiat-except-usd",
      href: "/?peg=fiat-non-usd-peg#filter-bar",
      label: "Fiat Except USD",
      count: fiatExceptUsdCount,
    });
  }

  return preview;
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
  const fiatPreview = useMemo(
    () => buildCollapsedFiatPreview(groups.find((group) => group.label === "Fiat")?.pegs ?? [], countFn),
    [countFn, groups],
  );

  // Collapsed: selected fiat previews + an aggregate non-USD fiat lens.
  const hasFiatOverflow = (groups.find((group) => group.label === "Fiat")?.pegs.length ?? 0) > fiatPreview.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="pharos-kicker">Browse by peg</h3>
        {hasFiatOverflow && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="pharos-focus-ring text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Show fewer" : `+${(groups.find((group) => group.label === "Fiat")?.pegs.length ?? 0) - fiatPreview.length} more pegs`}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {groups.map((group) => {
          const visibleItems = !expanded && group.label === "Fiat"
            ? fiatPreview
            : group.pegs
                .map((peg) => buildPegChip(peg, countFn))
                .filter((chip): chip is PegBrowseChip => chip !== null);
          return (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mr-0.5">
                {group.label}
              </span>
              {visibleItems.map((item) => {
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={PEG_PILL_CLASS}
                  >
                    {item.label} ({item.count})
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
