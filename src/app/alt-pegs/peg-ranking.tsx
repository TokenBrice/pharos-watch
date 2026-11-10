"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import type { PegCurrency } from "@shared/types";
import type { AltPegDistributionRow } from "@/lib/alt-peg-market";
import { formatNonUsdShare } from "@shared/lib/alt-peg-snapshot";
import { formatCurrency } from "@shared/lib/format";

// The long tail folds below the leaders; it stays in the DOM (native details).
const PEG_RANKING_OPEN_ROWS = 8;

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_1.5rem] items-center gap-x-4 gap-y-1 md:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1.4fr)_6rem_4.5rem_minmax(0,1fr)_1.5rem]";

function PegRankingRow({
  row,
  rank,
  selected,
  onSelect,
}: {
  row: AltPegDistributionRow;
  rank: number | null;
  selected: boolean;
  onSelect: (peg: PegCurrency | null) => void;
}) {
  const coinLabel = `${row.coinCount} coin${row.coinCount === 1 ? "" : "s"}`;
  const partialRow = row.supplyUnavailableCount > 0 || row.supplyPartialCount > 0;
  return (
    <li
      className={`relative ${ROW_GRID} px-3 py-2.5 transition-colors hover:bg-muted/40 md:px-4 ${selected ? "bg-muted/60" : ""}`}
      // The selected peg filters the table: a rule in its hue marks the row, not a tint alone.
      style={selected ? { boxShadow: `inset 3px 0 0 ${row.colorHex}` } : undefined}
    >
      <span className="hidden pharos-numeric text-xs text-muted-foreground md:block">{rank ?? ""}</span>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : row.peg)}
        className="pharos-focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-sm text-left after:absolute after:inset-0 md:min-h-8"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.colorHex }} aria-hidden="true" />
        <span className={selected ? "truncate text-sm font-semibold text-foreground" : "truncate text-sm font-medium text-foreground"}>{row.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{coinLabel}</span>
        <span className="sr-only">{selected ? ", filtering the coin table" : ", filter the coin table"}</span>
      </button>
      <span className="hidden h-2 overflow-hidden rounded-full bg-muted/50 md:block" aria-hidden="true">
        {row.sharePct !== null ? (
          <span className="block h-full rounded-full" style={{ width: `${Math.max(row.sharePct, 0.5)}%`, backgroundColor: row.colorHex }} />
        ) : (
          <span className="block h-full w-full bg-muted-foreground/25 bg-[image:repeating-linear-gradient(135deg,var(--color-card)_0_2px,transparent_2px_6px)]" />
        )}
      </span>
      <span className="text-right">
        <span className="pharos-numeric text-sm font-semibold text-foreground">
          {row.marketCap === null ? "—" : formatCurrency(row.marketCap, 1)}
        </span>
        {partialRow ? (
          <span className="block text-2xs text-muted-foreground">
            {row.marketCap === null ? "supply unavailable" : `known · ${row.supplyObservedCount}/${row.coinCount} observed`}
          </span>
        ) : null}
        <span className="pharos-numeric block text-xs text-muted-foreground md:hidden">
          {formatNonUsdShare(row.sharePct)}
        </span>
      </span>
      <span className="hidden pharos-numeric text-right text-sm text-muted-foreground md:block">
        {formatNonUsdShare(row.sharePct)}
      </span>
      <span className="relative z-10 hidden min-w-0 truncate text-sm md:block">
        {row.supplyObservedCount > 0 ? (
          <Link href={row.leaderHref} className="pharos-focus-ring rounded-sm text-foreground hover:text-primary" title={row.leaderName}>
            {row.leaderSymbol}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <Link
        href={row.href}
        className="pharos-focus-ring relative z-10 inline-flex h-11 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground md:h-6"
        aria-label={`${row.label} stablecoins page`}
      >
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * Pegs ranked by observed market cap; a row is also the coin table's peg filter
 * (`?peg=`). Ranks are printed only when every coin reports supply: a known
 * subtotal is not a complete rank.
 */
export function PegRanking({
  rows,
  partial,
  selectedPeg,
  onSelect,
}: {
  rows: readonly AltPegDistributionRow[];
  partial: boolean;
  selectedPeg: PegCurrency | null;
  onSelect: (peg: PegCurrency | null) => void;
}) {
  const renderRows = (slice: readonly AltPegDistributionRow[], offset: number) =>
    slice.map((row, index) => (
      <PegRankingRow
        key={row.peg}
        row={row}
        rank={partial ? null : offset + index + 1}
        selected={selectedPeg === row.peg}
        onSelect={onSelect}
      />
    ));
  const selectedInTail = rows.slice(PEG_RANKING_OPEN_ROWS).some((row) => row.peg === selectedPeg);

  return (
    <section id="alt-peg-ranking" aria-labelledby="alt-peg-ranking-title" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="alt-peg-ranking-title" className="pharos-section-title">Pegs by market cap</h2>
          <p className="pharos-meta">Pick a peg to filter the coins below; the arrow opens its page.</p>
        </div>
        {selectedPeg ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="pharos-focus-ring min-h-9 rounded-sm text-sm text-muted-foreground hover:text-foreground"
          >
            Show all pegs
          </button>
        ) : null}
      </div>
      <div className="overflow-hidden border-y border-border/60">
        <div className={`${ROW_GRID} hidden border-b border-border/60 px-4 py-2 md:grid`} aria-hidden="true">
          <span className="pharos-label">#</span>
          <span className="pharos-label">Peg</span>
          <span className="pharos-label">Share of non-USD</span>
          <span className="pharos-label text-right">Market cap</span>
          <span className="pharos-label text-right">Share</span>
          <span className="pharos-label">Largest coin</span>
          <span />
        </div>
        <ul className="divide-y divide-border/40">{renderRows(rows.slice(0, PEG_RANKING_OPEN_ROWS), 0)}</ul>
        {rows.length > PEG_RANKING_OPEN_ROWS ? (
          <details className="group border-t border-border/40" open={selectedInTail || undefined}>
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">
                Show all <span className="pharos-numeric">{rows.length}</span> pegs
              </span>
              <span className="hidden group-open:inline">Show top {PEG_RANKING_OPEN_ROWS} only</span>
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <ul className="divide-y divide-border/40 border-t border-border/40">
              {renderRows(rows.slice(PEG_RANKING_OPEN_ROWS), PEG_RANKING_OPEN_ROWS)}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
