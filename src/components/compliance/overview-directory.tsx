"use client";

import { useCallback, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { ReferenceTable } from "@/components/reference-table";
import { TableCell, TableHead, TableRow } from "@/components/table";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { PEG_METADATA } from "@shared/lib/classification";
import type { GeniusAuthorizationStatus, MicaStatus } from "@shared/types";
import {
  GENIUS_STATUS_DISPLAY_ORDER,
  MICA_STATUS_DISPLAY_ORDER,
  type ComplianceOverviewRow,
} from "@/lib/compliance-model";
import { CoinLink, EmptyCell, complianceStatusMeta } from "./compliance-row-primitives";

type OverviewSortColumn = "mica" | "genius";
interface OverviewSort {
  column: OverviewSortColumn;
  direction: "asc" | "desc";
}

/** `?sort=mica-asc` etc.; anything else is the default directory order. */
function parseOverviewSort(raw: string): OverviewSort | null {
  const match = /^(mica|genius)-(asc|desc)$/.exec(raw);
  return match ? { column: match[1] as OverviewSortColumn, direction: match[2] as "asc" | "desc" } : null;
}

function OverviewSortHeaderButton({
  column,
  label,
  sort,
  onToggle,
}: {
  column: OverviewSortColumn;
  label: string;
  sort: OverviewSort | null;
  onToggle: (column: OverviewSortColumn) => void;
}) {
  const isActive = sort?.column === column;
  return (
    <button
      type="button"
      onClick={() => onToggle(column)}
      aria-label={`Sort by ${label} status`}
      className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm hover:text-foreground"
    >
      {label}
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "h-3 w-3 transition-transform",
          !isActive && "opacity-40",
          isActive && sort?.direction === "desc" && "rotate-180",
        )}
      />
    </button>
  );
}

export function OverviewDirectory({
  rows,
  logos,
  onStatusClick,
  filterKey,
}: {
  rows: ComplianceOverviewRow[];
  logos: Record<string, string> | undefined;
  onStatusClick: (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => void;
  /** Peg/search signature from the workbench; a change returns the directory to page 1. */
  filterKey: string;
}) {
  const { getParam, setParam } = useUrlFilters();
  const sortParam = getParam("sort");
  const sort = useMemo(() => parseOverviewSort(sortParam), [sortParam]);

  const toggleSort = useCallback((column: OverviewSortColumn) => {
    const next: OverviewSort | null =
      sort?.column !== column
        ? { column, direction: "asc" }
        : sort.direction === "asc"
          ? { column, direction: "desc" }
          : null;
    trackEvent("filter_applied", {
      page: "compliance",
      filter_type: "overview_sort",
      filter_value: next ? `${next.column}:${next.direction}` : "default",
    });
    setParam("sort", next ? `${next.column}-${next.direction}` : "");
  }, [setParam, sort]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const order: readonly string[] = sort.column === "mica" ? MICA_STATUS_DISPLAY_ORDER : GENIUS_STATUS_DISPLAY_ORDER;
    const statusOf = (row: ComplianceOverviewRow) =>
      sort.column === "mica" ? row.mica?.status : row.genius?.status;
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const statusA = statusOf(a);
      const statusB = statusOf(b);
      // Unassessed rows stay last in either direction.
      if (!statusA || !statusB) {
        if (statusA) return -1;
        if (statusB) return 1;
        return a.symbol.localeCompare(b.symbol);
      }
      const delta = (order.indexOf(statusA) - order.indexOf(statusB)) * direction;
      if (delta !== 0) return delta;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [rows, sort]);

  const ariaSortFor = (column: OverviewSortColumn): "ascending" | "descending" | "none" =>
    sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="pharos-label">Stablecoin directory</p>
          <p className="text-xs text-muted-foreground">One row per tracked coin with its assessed regime statuses.</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="pharos-empty-note px-4 py-10 text-center text-sm text-muted-foreground">
          No stablecoins match these filters.
        </div>
      ) : (
        <ReferenceTable
          tableId="compliance-overview"
          testId="compliance-overview-table"
          rows={sortedRows}
          getRowKey={(row) => row.id}
          noun="coins"
          resetKey={`${filterKey}:${sort ? `${sort.column}-${sort.direction}` : ""}`}
          tableClassName="table-fixed"
          tableProps={{ "aria-label": "Compliance overview directory" }}
          head={
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[38%] px-1.5 sm:px-3">Coin</TableHead>
              <TableHead className="w-[14%] px-1.5 sm:px-3">Peg</TableHead>
              <TableHead className="w-[24%] px-1.5 text-center sm:px-3" aria-sort={ariaSortFor("mica")}>
                <OverviewSortHeaderButton column="mica" label="MiCA" sort={sort} onToggle={toggleSort} />
              </TableHead>
              <TableHead className="w-[24%] px-1.5 text-center sm:px-3" aria-sort={ariaSortFor("genius")}>
                <OverviewSortHeaderButton column="genius" label="GENIUS" sort={sort} onToggle={toggleSort} />
              </TableHead>
            </TableRow>
          }
          renderRow={(row) => (
            <TableRow>
              <TableCell className="px-1.5 sm:px-3">
                <CoinLink row={row} logo={logos?.[row.id]} />
              </TableCell>
              <TableCell className="px-1.5 text-xs text-muted-foreground sm:px-3">
                {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
              </TableCell>
              <TableCell className="px-1.5 text-center sm:px-3">
                {row.mica ? (
                  <OverviewStatusButton
                    regime="mica"
                    status={row.mica.status}
                    coinSymbol={row.symbol}
                    onClick={onStatusClick}
                  />
                ) : (
                  <EmptyCell />
                )}
              </TableCell>
              <TableCell className="px-1.5 text-center sm:px-3">
                {row.genius ? (
                  <OverviewStatusButton
                    regime="genius"
                    status={row.genius.status}
                    coinSymbol={row.symbol}
                    inWatch={row.genius.inWatch}
                    onClick={onStatusClick}
                  />
                ) : (
                  <EmptyCell />
                )}
              </TableCell>
            </TableRow>
          )}
        />
      )}
    </div>
  );
}

function OverviewStatusButton({
  regime,
  status,
  coinSymbol,
  inWatch = false,
  onClick,
}: {
  regime: "mica" | "genius";
  status: MicaStatus | GeniusAuthorizationStatus;
  coinSymbol: string;
  inWatch?: boolean;
  onClick: (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => void;
}) {
  const { badge, description } = complianceStatusMeta(regime, status);

  return (
    <button
      type="button"
      title={inWatch ? `${description} Implementation Watch.` : description}
      aria-label={`Show ${regime === "mica" ? "MiCA" : "GENIUS"} ${badge.label} stablecoins; selected from ${coinSymbol}`}
      onClick={() => onClick(regime, status)}
      className={cn(
        "pharos-focus-ring inline-flex max-w-full items-center justify-center whitespace-normal rounded-full border px-1.5 py-1 text-center text-3xs font-semibold leading-tight sm:px-3 sm:text-xs",
        badge.cls,
      )}
    >
      {badge.label}
    </button>
  );
}
