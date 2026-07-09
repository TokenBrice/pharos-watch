"use client";

import type { ReactNode } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { MethodologyHint } from "@/components/methodology-hint";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TableHead, TableHeader, TableRow } from "@/components/table";
import { Button } from "@/components/ui/button";
import type { StablecoinTableSortKey } from "@/components/stablecoin-table-logic";
import type { ColumnId } from "@/hooks/use-preferences";
import type { TableDensity } from "@/hooks/use-table-density";

export type StablecoinTableVisualVariant = "default" | "figmaOverview";

export const STABLECOIN_FRAME_SHARED = {
  tableId: "stablecoin-overview",
  testId: "stablecoin-overview-table",
  viewportClassName:
    "max-h-[50vh] overscroll-y-auto px-0 pb-[calc(var(--mobile-utility-safe-offset,0px)+0.75rem)] pr-2 sm:max-h-[70vh] sm:pb-2 sm:pr-0",
  mobileScrollHint: "Swipe sideways for more columns. Risk cues stay visible in each row.",
  tableClassName: "min-w-[420px] table-fixed",
} as const;

export const STABLECOIN_TABLE_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  ["stablecoins"],
  ["peg-summary"],
  ["report-cards"],
  ["dex-liquidity"],
];

export const OVERSCAN = 32;
export const PINNED_COLUMN_MIN_WIDTH_PX = 56;
export const OVERVIEW_PAGE_SIZE = 20;
export const MOBILE_COLUMNS_MIN_ROW_HEIGHT_PX = 68;
export const OVERVIEW_ICON_SIZE_PX = 18;
export const VIRTUAL_ROW_HEIGHT_ESTIMATE_PX: Record<TableDensity, number> = { compact: 52, spacious: 75 };
export const OVERVIEW_ROW_HEIGHT_ESTIMATE_PX: Record<TableDensity, number> = { compact: 42, spacious: 56 };

const TABLE_BASE_MIN_WIDTH_PX = 420;
const COLUMN_MIN_WIDTH_PX: Record<ColumnId, number> = {
  rank: 40,
  name: 168,
  price: 116,
  peg: 92,
  mcap: 144,
  change24h: 92,
  change7d: 144,
  grade: 124,
  stability: 156,
  liquidity: 104,
  blacklistable: 124,
  mintAuthority: 160,
  backing: 92,
  type: 92,
  flags: 72,
};
const OVERVIEW_COLUMN_MIN_WIDTH_PX: Record<ColumnId, number> = {
  rank: 44,
  name: 190,
  price: 104,
  peg: 84,
  mcap: 100,
  change24h: 84,
  change7d: 112,
  grade: 88,
  stability: 112,
  liquidity: 72,
  blacklistable: 96,
  mintAuthority: 112,
  backing: 84,
  type: 80,
  flags: 72,
};

export const SKELETON_WIDTH_BY_COLUMN: Partial<Record<ColumnId, string>> = {
  rank: "h-4 w-8",
  name: "h-5 w-28",
  price: "h-4 w-16",
  peg: "h-4 w-14",
  mcap: "h-4 w-20",
  change24h: "h-4 w-14",
  change7d: "h-4 w-14",
  grade: "h-4 w-12",
  stability: "h-4 w-16",
  liquidity: "h-4 w-14",
  blacklistable: "h-4 w-20",
  mintAuthority: "h-4 w-20",
  backing: "h-4 w-16",
  type: "h-4 w-14",
  flags: "h-4 w-12",
};

export function sameColumnSet(left: readonly ColumnId[], right: readonly ColumnId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function getColumnMinWidthPx(id: ColumnId, variant: StablecoinTableVisualVariant): number {
  return variant === "figmaOverview" ? OVERVIEW_COLUMN_MIN_WIDTH_PX[id] : COLUMN_MIN_WIDTH_PX[id];
}

export function getTableMinWidthPx(
  visibleColumns: readonly ColumnId[],
  showPinnedControls: boolean,
  variant: StablecoinTableVisualVariant,
): number {
  const selectedWidth = visibleColumns.reduce(
    (total, id) => total + getColumnMinWidthPx(id, variant),
    showPinnedControls ? (variant === "figmaOverview" ? 48 : PINNED_COLUMN_MIN_WIDTH_PX) : 0,
  );
  return Math.max(TABLE_BASE_MIN_WIDTH_PX, selectedWidth);
}

export interface StablecoinHeaderDef {
  id: ColumnId;
  label: string;
  sortLabel?: string;
  headerAdornment?: ReactNode;
  className?: string;
  title?: string;
  sortKey?: StablecoinTableSortKey;
}

export const STABLECOIN_HEADER_DEFS: readonly StablecoinHeaderDef[] = [
  { id: "rank", label: "#", className: "w-[40px] text-right" },
  { id: "name", label: "Name", sortKey: "name", className: "w-[168px] max-w-[168px] lg:w-[150px] lg:max-w-[150px]" },
  { id: "price", label: "Price", sortKey: "price", className: "w-[104px] text-right lg:w-[116px]" },
  {
    id: "peg",
    label: "Peg",
    sortKey: "peg",
    className: "w-[92px] text-right",
    title: "Sort by peg deviation — ascending shows tightest pegs first, descending shows worst depegs first",
  },
  { id: "mcap", label: "Market Cap", sortKey: "mcap", className: "w-[144px] text-right" },
  { id: "change24h", label: "24h", sortKey: "change24h", className: "w-[92px] text-right", title: "24-hour market cap change" },
  { id: "change7d", label: "7d", sortKey: "change7d", className: "w-[144px] text-right", title: "7-day market cap change" },
  {
    id: "grade",
    label: "Grade",
    headerAdornment: <MethodologyHint topic="safetyScore" />,
    sortKey: "grade",
    className: "w-[124px] text-center",
    title: "Pharos Grade: overall safety score across peg stability, liquidity, resilience, decentralization, and dependency risk",
  },
  {
    id: "stability",
    label: "Peg Score",
    headerAdornment: <MethodologyHint topic="pegScore" />,
    sortKey: "stability",
    className: "w-[156px] text-right",
    title: "Peg Stability Score (0-100): measures peg-holding consistency over 30 days",
  },
  {
    id: "liquidity",
    label: "Liq",
    headerAdornment: <MethodologyHint topic="liquidityScore" />,
    sortKey: "liquidity",
    className: "w-[104px] text-right",
    title: "DEX Liquidity Score: measures pool depth, volume, and diversity across decentralized exchanges",
  },
  { id: "blacklistable", label: "Blacklist", sortKey: "blacklistable", className: "w-[124px] text-center", title: "Issuer blacklist/freeze control risk, including inherited dependency exposure where applicable" },
  {
    id: "mintAuthority",
    label: "Mint Score",
    headerAdornment: <MethodologyHint topic="mintAuthorityScore" />,
    sortKey: "mintAuthority",
    className: "w-[160px] text-center",
    title: "Mint Authority Score (0-100): privileged-mint risk score that can drag Safety Score v8 Decentralization.",
  },
  { id: "backing", label: "Backing", className: "w-[92px] text-center", title: "Collateral backing type" },
  { id: "type", label: "Type", className: "w-[92px] text-center", title: "Stablecoin mechanism type" },
  { id: "flags", label: "Flags", className: "w-[72px] text-center" },
];

const OVERVIEW_HEADER_LABELS: Partial<Record<ColumnId, string>> = { mcap: "MC" };
const OVERVIEW_HEADER_CLASS_NAMES: Partial<Record<ColumnId, string>> = {
  rank: "w-[44px] text-right",
  name: "w-[190px] max-w-[190px]",
  price: "w-[104px] text-right",
  peg: "w-[84px] text-right",
  mcap: "w-[100px] text-right",
  change24h: "w-[84px] text-right",
  change7d: "w-[112px] text-right",
  grade: "w-[88px] text-center",
  stability: "w-[112px] text-right",
  liquidity: "w-[72px] text-right",
  blacklistable: "w-[96px] text-center",
  mintAuthority: "w-[112px] text-center",
  backing: "w-[84px] text-center",
  type: "w-[80px] text-center",
  flags: "w-[72px] text-center",
};

function getHeaderLabel(column: StablecoinHeaderDef, variant: StablecoinTableVisualVariant): string {
  return variant === "figmaOverview" ? OVERVIEW_HEADER_LABELS[column.id] ?? column.label : column.label;
}

function getHeaderClassName(column: StablecoinHeaderDef, variant: StablecoinTableVisualVariant): string | undefined {
  return variant === "figmaOverview" ? OVERVIEW_HEADER_CLASS_NAMES[column.id] ?? column.className : column.className;
}

interface StablecoinTableHeaderSortProps {
  sortKey: StablecoinTableSortKey;
  sortDirection: "asc" | "desc";
  toggleSort: (key: StablecoinTableSortKey) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  showHeaderMethodologyHints: boolean;
}

export function StablecoinTableHeader({
  showPinnedControls,
  isVisible,
  sort,
  sticky,
  variant = "default",
}: {
  showPinnedControls: boolean;
  isVisible: (id: ColumnId) => boolean;
  sort?: StablecoinTableHeaderSortProps;
  sticky?: boolean;
  variant?: StablecoinTableVisualVariant;
}) {
  return (
    <TableHeader className={`${sticky ? "sticky top-0 z-10 bg-muted" : "bg-muted"} ${variant === "figmaOverview" ? "pharos-overview-table-header" : ""}`}>
      <TableRow rowIntent={sort ? undefined : "static"}>
        {showPinnedControls ? (
          <TableHead scope="col" className={variant === "figmaOverview" ? "w-[48px] text-center" : "w-[44px] text-center lg:w-[36px]"}>
            <span className="sr-only">Starred</span>
          </TableHead>
        ) : null}
        {STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) =>
          sort && column.sortKey ? (
            <SortableTableHead
              key={column.id}
              sortKey={column.sortKey}
              currentSortKey={sort.sortKey}
              sortDirection={sort.sortDirection}
              label={column.sortLabel ?? getHeaderLabel(column, variant)}
              toggleSort={sort.toggleSort}
              getAriaSortValue={sort.getAriaSortValue}
              adornment={sort.showHeaderMethodologyHints ? column.headerAdornment : undefined}
              className={getHeaderClassName(column, variant)}
              title={column.title}
            />
          ) : (
            <TableHead key={column.id} scope="col" className={getHeaderClassName(column, variant)} title={column.title}>
              {getHeaderLabel(column, variant)}
            </TableHead>
          ),
        )}
      </TableRow>
    </TableHeader>
  );
}

export function ColumnFitToggle({
  fitToWidth,
  hiddenCount,
  compact,
  onToggle,
}: {
  fitToWidth: boolean;
  hiddenCount: number;
  compact: boolean;
  onToggle: () => void;
}) {
  const plural = hiddenCount === 1 ? "" : "s";
  return (
    <Button
      variant="outline"
      size="sm"
      className={compact ? "h-8 min-h-8 rounded-lg px-2 sm:px-3" : "rounded-lg min-h-11 sm:min-h-8"}
      onClick={onToggle}
      title={fitToWidth
        ? `${hiddenCount} column${plural} hidden to fit the width — show all with horizontal scroll`
        : "Hide overflow columns so the table fits without horizontal scroll"}
    >
      {fitToWidth ? `+${hiddenCount} column${plural}` : "Fit columns"}
    </Button>
  );
}
