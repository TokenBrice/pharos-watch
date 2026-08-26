"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  TableFrame,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { PEG_METADATA } from "@shared/lib/classification";
import {
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
} from "@shared/lib/genius";
import {
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
} from "@shared/lib/mica";
import type { GeniusAuthorizationStatus, MicaStatus } from "@shared/types";
import {
  GENIUS_STATUS_DISPLAY_ORDER,
  MICA_STATUS_DISPLAY_ORDER,
  type ComplianceOverviewRow,
} from "@/lib/compliance-model";
import { CoinLink, EmptyCell } from "./compliance-row-primitives";

type OverviewSortColumn = "mica" | "genius";
interface OverviewSort {
  column: OverviewSortColumn;
  direction: "asc" | "desc";
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
}: {
  rows: ComplianceOverviewRow[];
  logos: Record<string, string> | undefined;
  onStatusClick: (regime: "mica" | "genius", status: MicaStatus | GeniusAuthorizationStatus) => void;
}) {
  const [sort, setSort] = useState<OverviewSort | null>(null);

  const toggleSort = useCallback((column: OverviewSortColumn) => {
    setSort((previous) => {
      const next: OverviewSort | null =
        previous?.column !== column
          ? { column, direction: "asc" }
          : previous.direction === "asc"
            ? { column, direction: "desc" }
            : null;
      trackEvent("filter_applied", {
        page: "compliance",
        filter_type: "overview_sort",
        filter_value: next ? `${next.column}:${next.direction}` : "default",
      });
      return next;
    });
  }, []);

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
          <p className="pharos-kicker">Stablecoin Directory</p>
          <p className="text-xs text-muted-foreground">One row per tracked coin with its assessed regime statuses.</p>
        </div>
        <span className="pharos-numeric text-xs text-muted-foreground">{rows.length.toLocaleString()} coins</span>
      </div>
      {rows.length === 0 ? (
        <div className="pharos-empty-note px-4 py-10 text-center text-sm text-muted-foreground">
          No stablecoins match these filters.
        </div>
      ) : (
        <TableFrame
          tableId="compliance-overview"
          testId="compliance-overview-table"
          chrome="bare"
          className="pharos-table-shell"
          tableClassName="table-fixed"
          tableProps={{ "aria-label": "Compliance overview directory" }}
          viewportClassName="relative w-full"
          viewportProps={{
            compactBottomPadding: false,
            horizontal: false,
            mobileScrollHint: false,
            overscrollX: false,
            scrollShadow: false,
          }}
        >
          <TableHeader>
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
          </TableHeader>
          <TableBody>
            {sortedRows.map((row) => (
              <TableRow key={row.id}>
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
            ))}
          </TableBody>
        </TableFrame>
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
  const badge = regime === "mica"
    ? MICA_STATUS_BADGE_STYLES[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status as GeniusAuthorizationStatus];
  const description = regime === "mica"
    ? MICA_STATUS_DESCRIPTIONS[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[status as GeniusAuthorizationStatus];

  return (
    <button
      type="button"
      title={inWatch ? `${description} Implementation Watch.` : description}
      aria-label={`Show ${regime === "mica" ? "MiCA" : "GENIUS"} ${badge.label} stablecoins; selected from ${coinSymbol}`}
      onClick={() => onClick(regime, status)}
      className={cn(
        "pharos-focus-ring inline-flex max-w-full items-center justify-center whitespace-normal rounded-full border px-1.5 py-1 text-center text-[10px] font-semibold leading-tight sm:px-3 sm:text-xs",
        badge.cls,
      )}
    >
      {badge.label}
    </button>
  );
}
