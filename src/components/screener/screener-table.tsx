"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/ui/table";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { useSort } from "@/hooks/use-sort";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatCompactUsd } from "@shared/lib/format";
import { PEG_METADATA, getMechanismArchetypeLabel } from "@shared/lib/classification";
import type { ScreenerRow } from "@/app/screener/screener-filters";
import type { ReportCardGrade } from "@shared/types";

type ScreenerSortKey =
  | "name"
  | "supply"
  | "pegScore"
  | "dewsScore"
  | "liquidityScore"
  | "safetyScore";

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
    title: "Pharos Safety Grade",
  },
  { id: "mechanism", label: "Mechanism", className: "text-left" },
  { id: "peg", label: "Peg", className: "text-left" },
] as const;

function compareValues(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: "asc" | "desc",
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  // Always push null values to the bottom regardless of sort direction.
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return direction === "asc" ? a - b : b - a;
}

function compareStrings(a: string, b: string, direction: "asc" | "desc"): number {
  const cmp = a.localeCompare(b);
  return direction === "asc" ? cmp : -cmp;
}

interface ScreenerTableProps {
  rows: readonly ScreenerRow[];
  isLoading: boolean;
  onClearFilters?: () => void;
  hasActiveFilters: boolean;
}

export function ScreenerTable({
  rows,
  isLoading,
  onClearFilters,
  hasActiveFilters,
}: ScreenerTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ScreenerSortKey>(
    "safetyScore",
    "desc",
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return compareStrings(a.symbol || a.name, b.symbol || b.name, sortDirection);
        case "supply":
          return compareValues(a.supplyUsd, b.supplyUsd, sortDirection);
        case "pegScore":
          return compareValues(a.pegScore, b.pegScore, sortDirection);
        case "dewsScore":
          return compareValues(a.dewsScore, b.dewsScore, sortDirection);
        case "liquidityScore":
          return compareValues(a.liquidityScore, b.liquidityScore, sortDirection);
        case "safetyScore":
          return compareValues(a.safetyScore, b.safetyScore, sortDirection);
        default:
          return 0;
      }
    });
    return copy;
  }, [rows, sortKey, sortDirection]);

  return (
    <DataTableShell<ScreenerSortKey>
      columns={COLUMNS}
      sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
      striped
    >
      {isLoading ? (
        <DataTableLoadingRows columns={COLUMNS} rowCount={8} />
      ) : sorted.length === 0 ? (
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
        sorted.map((row) => <ScreenerRow key={row.id} row={row} />)
      )}
    </DataTableShell>
  );
}

function ScreenerRow({ row }: { row: ScreenerRow }) {
  return (
    <TableRow>
      <TableCell className="min-w-[160px]">
        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex flex-col rounded-sm"
        >
          <span className="font-semibold text-foreground">{row.symbol}</span>
          <span className="truncate text-xs text-muted-foreground">{row.name}</span>
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
