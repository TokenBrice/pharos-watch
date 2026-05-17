"use client";

import Link from "next/link";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/ui/table";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatCompactUsd } from "@shared/lib/format";
import { PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";
import type { ScreenerRow, ScreenerSortKey } from "@/app/screener/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";
import type { ReportCardGrade } from "@shared/types";

const COLUMNS: readonly DataTableColumn<ScreenerSortKey>[] = [
  { id: "name", label: "Name", sortKey: "name", className: "min-w-[160px]" },
  { id: "supply", label: "Supply", sortKey: "supply", className: "text-right" },
  {
    id: "pegScore",
    label: "Peg Score",
    sortKey: "pegScore",
    className: "text-right",
    title: "Peg Stability Score (0-100): peg-holding consistency over 30 days",
  },
  {
    id: "dewsScore",
    label: "DEWS",
    sortKey: "dewsScore",
    className: "text-right",
    title: "Depeg Early Warning System stress score (0-100)",
  },
  {
    id: "liquidityScore",
    label: "Liquidity",
    sortKey: "liquidityScore",
    className: "text-right",
    title: "DEX Liquidity Score (0-100): pool depth, volume, and diversity",
  },
  {
    id: "safetyScore",
    label: "Grade",
    sortKey: "safetyScore",
    className: "text-center",
    title: `Pharos Safety Grade (${SAFETY_SCORE_VERSION_LABEL})`,
  },
  { id: "mechanism", label: "Mechanism", className: "text-left" },
  { id: "peg", label: "Peg", className: "text-left" },
] as const;

interface ScreenerTableProps {
  rows: readonly ScreenerRow[];
  logos?: Record<string, string>;
  isLoading: boolean;
  onClearFilters?: () => void;
  hasActiveFilters: boolean;
  sort: DataTableSortControls<ScreenerSortKey>;
}

export function ScreenerTable({
  rows,
  logos,
  isLoading,
  onClearFilters,
  hasActiveFilters,
  sort,
}: ScreenerTableProps) {
  return (
    <DataTableShell<ScreenerSortKey>
      columns={COLUMNS}
      sort={sort}
      striped
    >
      {isLoading ? (
        <DataTableLoadingRows columns={COLUMNS} rowCount={8} />
      ) : rows.length === 0 ? (
        <DataTableEmptyRow colSpan={COLUMNS.length}>
          {hasActiveFilters ? (
            <div className="space-y-2">
              <p>No stablecoins match these filters.</p>
              {onClearFilters && (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80"
                >
                  Reset filters and try again.
                </button>
              )}
            </div>
          ) : (
            <p>Loading screener inputs…</p>
          )}
        </DataTableEmptyRow>
      ) : (
        rows.map((row) => <ScreenerRow key={row.id} row={row} logo={logos?.[row.id]} />)
      )}
    </DataTableShell>
  );
}

function ScreenerRow({ row, logo }: { row: ScreenerRow; logo?: string }) {
  return (
    <TableRow>
      <TableCell className="min-w-[160px]">
        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex min-w-0 items-center gap-2 rounded-sm"
        >
          <StablecoinLogo src={logo} name={row.name} size={24} />
          <span className="min-w-0">
            <span className="block font-semibold text-foreground">{row.symbol}</span>
            <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
          </span>
        </Link>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.supplyUsd > 0 ? formatCompactUsd(row.supplyUsd) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.pegScore != null ? row.pegScore.toFixed(0) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.dewsScore != null ? row.dewsScore.toFixed(0) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.liquidityScore != null ? row.liquidityScore.toFixed(0) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        {row.safetyGrade ? (
          <SafetyGradeBadge
            grade={row.safetyGrade as ReportCardGrade}
            score={row.safetyScore}
            size="sm"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-left text-muted-foreground">
        {row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : "—"}
      </TableCell>
      <TableCell className="text-left text-muted-foreground">
        {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
      </TableCell>
    </TableRow>
  );
}
