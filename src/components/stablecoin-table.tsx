"use client";

import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { QueryKey } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
  VirtualTableFrame,
  type TableSkeletonColumn,
} from "@/components/table";
import { TableToolbar } from "./table-toolbar";
import { useTableDensity, DENSITY_CONFIGS, type TableDensity } from "@/hooks/use-table-density";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useElementWidth } from "@/hooks/use-element-width";
import { fitColumnsToWidth } from "@/lib/stablecoin-table-fit";
import { Button } from "@/components/ui/button";
import type { StablecoinData, FilterTag, PegSummaryCoin, DexLiquidityMap, ReportCard } from "@shared/types";
import { buildStablecoinUrl } from "@/lib/urls";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import {
  usePreference,
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
  type ColumnId,
} from "@/hooks/use-preferences";
import { MethodologyHint } from "@/components/methodology-hint";
import { TableBackgroundRefreshingBar } from "@/components/data-table-shell";
import { StablecoinTableEmptyState } from "@/components/stablecoin-table-empty-state";
import { StablecoinVirtualRow } from "@/components/stablecoin-table-row";
import { useRowCursor } from "@/hooks/use-row-cursor";
import { useSortColumnEvent } from "@/hooks/use-sort-column-event";
import { useWatchlist } from "@/hooks/use-watchlist";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  filterStablecoins,
  prioritizePinnedStablecoins,
  resolveEffectiveSortKey,
  sortStablecoins,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";

const SKELETON_ROWS = Array.from({ length: 10 }, (_, i) => i);
const OVERSCAN = 32;
const EMPTY_PINNED_STABLECOIN_IDS: readonly string[] = [];
type StablecoinTableVisualVariant = "default" | "figmaOverview";
const STABLECOIN_FRAME_SHARED = {
  tableId: "stablecoin-overview",
  testId: "stablecoin-overview-table",
  viewportClassName:
    "max-h-[50vh] overscroll-y-auto px-0 pb-[calc(var(--mobile-utility-safe-offset,0px)+0.75rem)] pr-2 sm:max-h-[70vh] sm:pb-2 sm:pr-0",
  mobileScrollHint: "Swipe sideways for more columns. Risk cues stay visible in each row.",
  tableClassName: "min-w-[420px] table-fixed",
} as const;
// M1: keys feeding the home table's columns (market data, peg, grade, liquidity).
// A background refetch surfaces the RefreshingBar while prior rows stay visible.
const STABLECOIN_TABLE_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  ["stablecoins"],
  ["peg-summary"],
  ["report-cards"],
  ["dex-liquidity"],
];
const TABLE_BASE_MIN_WIDTH_PX = 420;
const PINNED_COLUMN_MIN_WIDTH_PX = 56;
const VIRTUAL_ROW_HEIGHT_ESTIMATE_PX: Record<TableDensity, number> = {
  compact: 52,
  spacious: 75,
};
const OVERVIEW_ROW_HEIGHT_ESTIMATE_PX: Record<TableDensity, number> = {
  compact: 42,
  spacious: 56,
};
const OVERVIEW_PAGE_SIZE = 20;
// Mobile column layout stacks symbol + secondary lines, so its rows need a taller
// floor than the density config's desktop rowHeight estimate.
const MOBILE_COLUMNS_MIN_ROW_HEIGHT_PX = 68;
// The Figma overview uses a tighter logo than the density config's icon size.
const OVERVIEW_ICON_SIZE_PX = 18;
// Per-column content minimums. The table runs `table-fixed`; summing these for
// the visible set yields the inline min-width at every tier, so the viewport
// scrolls horizontally instead of squeezing cell content into neighbors.
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
  price: 88,
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
const SKELETON_WIDTH_BY_COLUMN: Partial<Record<ColumnId, string>> = {
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

function sameColumnSet(left: readonly ColumnId[], right: readonly ColumnId[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function getColumnMinWidthPx(id: ColumnId, variant: StablecoinTableVisualVariant): number {
  return variant === "figmaOverview" ? OVERVIEW_COLUMN_MIN_WIDTH_PX[id] : COLUMN_MIN_WIDTH_PX[id];
}

function getTableMinWidthPx(
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

interface StablecoinHeaderDef {
  id: ColumnId;
  label: string;
  sortLabel?: string;
  headerAdornment?: React.ReactNode;
  className?: string;
  title?: string;
  sortKey?: StablecoinTableSortKey;
}

const STABLECOIN_HEADER_DEFS: readonly StablecoinHeaderDef[] = [
  { id: "rank", label: "#", className: "w-[40px] text-right" },
  {
    id: "name",
    label: "Name",
    sortKey: "name",
    className: "w-[168px] max-w-[168px] lg:w-[150px] lg:max-w-[150px]",
  },
  {
    id: "price",
    label: "Price",
    sortKey: "price",
    // Pinned to content width in the phone layout (<lg): fixed-layout leftover
    // sharing otherwise inflates the column past the 390px first viewport and
    // clips the fourth peg-price decimal at rest. From lg it pins wider so
    // four-digit prices (gold pegs, ~$4,030.1234) never overflow into Peg.
    className: "w-[88px] text-right lg:w-[116px]",
  },
  {
    id: "peg",
    label: "Peg",
    sortKey: "peg",
    className: "w-[92px] text-right",
    title: "Sort by peg deviation — ascending shows tightest pegs first, descending shows worst depegs first",
  },
  { id: "mcap", label: "Market Cap", sortKey: "mcap", className: "w-[144px] text-right" },
  { id: "change24h", label: "24h", sortKey: "change24h", className: "w-[92px] text-right", title: "24-hour market cap change" },
  {
    id: "change7d",
    label: "7d",
    sortKey: "change7d",
    className: "w-[144px] text-right",
    title: "7-day market cap change",
  },
  {
    id: "grade",
    label: "Grade",
    headerAdornment: <MethodologyHint topic="safetyScore" />,
    sortKey: "grade",
    className: "w-[124px] text-center",
    title:
      "Pharos Grade: overall safety score across peg stability, liquidity, resilience, decentralization, and dependency risk",
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
  {
    id: "blacklistable",
    label: "Blacklist",
    sortKey: "blacklistable",
    className: "w-[124px] text-center",
    title: "Issuer blacklist/freeze control risk, including inherited dependency exposure where applicable",
  },
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
] as const;

const OVERVIEW_HEADER_LABELS: Partial<Record<ColumnId, string>> = {
  mcap: "MC",
};

const OVERVIEW_HEADER_CLASS_NAMES: Partial<Record<ColumnId, string>> = {
  rank: "w-[44px] text-right",
  name: "w-[190px] max-w-[190px]",
  price: "w-[88px] text-right",
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
  if (variant === "figmaOverview") {
    return OVERVIEW_HEADER_LABELS[column.id] ?? column.label;
  }
  return column.label;
}

function getHeaderClassName(column: StablecoinHeaderDef, variant: StablecoinTableVisualVariant): string | undefined {
  if (variant === "figmaOverview") {
    return OVERVIEW_HEADER_CLASS_NAMES[column.id] ?? column.className;
  }
  return column.className;
}

interface StablecoinTableHeaderSortProps {
  sortKey: StablecoinTableSortKey;
  sortDirection: "asc" | "desc";
  toggleSort: (key: StablecoinTableSortKey) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  showHeaderMethodologyHints: boolean;
}

interface StablecoinTableHeaderProps {
  showPinnedControls: boolean;
  isVisible: (id: ColumnId) => boolean;
  /** When omitted the header renders in loading/static mode (plain TableHead, rowIntent="static"). */
  sort?: StablecoinTableHeaderSortProps;
  sticky?: boolean;
  variant?: StablecoinTableVisualVariant;
}

function StablecoinTableHeader({
  showPinnedControls,
  isVisible,
  sort,
  sticky,
  variant = "default",
}: StablecoinTableHeaderProps) {
  return (
    <TableHeader
      className={`${sticky ? "sticky top-0 z-10 bg-muted" : "bg-muted"} ${variant === "figmaOverview" ? "pharos-overview-table-header" : ""}`}
    >
      <TableRow rowIntent={sort ? undefined : "static"}>
        {showPinnedControls ? (
          <TableHead
            scope="col"
            className={variant === "figmaOverview" ? "w-[48px] text-center" : "w-[44px] text-center lg:w-[36px]"}
          >
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

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: readonly FilterTag[];
  toolbarActions?: React.ReactNode;
  filterPanel?: React.ReactNode;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  initialVisibleColumns?: readonly ColumnId[];
  columnPreferenceNamespace?: string;
  showHeaderMethodologyHints?: boolean;
  initialSort?: { key: StablecoinTableSortKey; direction: "asc" | "desc" };
  pinnedStablecoinIds?: readonly string[];
  onTogglePinnedStablecoin?: (stablecoinId: string) => void;
  onClearSearch?: () => void;
  onClearFilters?: () => void;
  toolbarEyebrow?: string;
  toolbarDescription?: string | null;
  toolbarTitleId?: string;
  toolbarMeta?: string;
  toolbarVariant?: "default" | "figmaOverview";
}

export function StablecoinTable({
  data,
  isLoading,
  activeFilters,
  toolbarActions,
  filterPanel,
  logos,
  pegRates = {},
  searchQuery,
  onSearchChange,
  pegScores,
  dexLiquidity,
  reportCards,
  initialVisibleColumns,
  columnPreferenceNamespace = "pharos-table",
  showHeaderMethodologyHints = true,
  initialSort,
  pinnedStablecoinIds = EMPTY_PINNED_STABLECOIN_IDS,
  onTogglePinnedStablecoin,
  onClearSearch,
  onClearFilters,
  toolbarEyebrow,
  toolbarDescription,
  toolbarTitleId,
  toolbarMeta,
  toolbarVariant = "default",
}: StablecoinTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<StablecoinTableSortKey>(
    initialSort?.key ?? "mcap",
    initialSort?.direction ?? "desc",
  );
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const handleNavigate = useCallback(
    (coinId: string) => {
      router.push(buildStablecoinUrl(coinId));
    },
    [router],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const isFigmaOverview = toolbarVariant === "figmaOverview";
  // Phone-layout boundary: the homepage overview flips at 768; the default
  // workbench flips at lg (1024) so tablets get the real table — auto-fit
  // (below) sheds low-priority columns instead of forcing horizontal scroll.
  const isMobileColumns = useIsMobile(isFigmaOverview ? 768 : 1024);
  const [measureViewportRef, viewportWidth] = useElementWidth<HTMLDivElement>();
  const setViewportNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      measureViewportRef(node);
    },
    [measureViewportRef],
  );

  // Density mode
  const [density, setDensity] = useTableDensity();
  const densityConfig = DENSITY_CONFIGS[density];

  // Column visibility — mobile gets a reduced default (hiddenMobile columns start off).
  // `initialVisibleColumns`, when provided, seeds the default for first-mount on this route
  // (e.g., compact homepage views ship a denser lens). Existing localStorage prefs still win on
  // subsequent loads — the prop only seeds the default branch.
  const deviceDefault = useMemo<ColumnId[]>(() => {
    if (isFigmaOverview && initialVisibleColumns && initialVisibleColumns.length > 0) {
      return [...initialVisibleColumns];
    }
    if (isMobileColumns) {
      return [...MOBILE_DEFAULT_COLUMNS];
    }
    if (initialVisibleColumns && initialVisibleColumns.length > 0) {
      return [...initialVisibleColumns];
    }
    return [...DEFAULT_VISIBLE_COLUMNS];
  }, [initialVisibleColumns, isFigmaOverview, isMobileColumns]);
  const columnPreferenceKey = isMobileColumns
    ? `${columnPreferenceNamespace}-columns-mobile`
    : `${columnPreferenceNamespace}-columns`;
  const [visibleColumns, setVisibleColumns, resetColumns] = usePreference<ColumnId[]>(
    columnPreferenceKey,
    deviceDefault,
    {
      decode: (raw) => normalizeVisibleColumns(raw, deviceDefault),
    },
  );
  const previousDefaultColumnsRef = useRef<readonly ColumnId[]>(deviceDefault);
  useEffect(() => {
    setVisibleColumns((current) => {
      const previousDefault = previousDefaultColumnsRef.current;
      previousDefaultColumnsRef.current = deviceDefault;
      return sameColumnSet(current, previousDefault) ? [...deviceDefault] : current;
    });
  }, [deviceDefault, setVisibleColumns]);
  const showPinnedControls = typeof onTogglePinnedStablecoin === "function";

  // Fit-to-width (≥lg): shed low-priority columns until the user's chosen set
  // fits the measured container, instead of forcing horizontal scroll. The
  // Columns menu keeps managing intent; the "+N columns" toolbar control
  // toggles back to the scroll-everything behavior.
  const [fitToWidth, setFitToWidth] = usePreference<boolean>(
    `${columnPreferenceNamespace}-fit-columns`,
    true,
    { decode: (raw) => raw !== false },
  );
  const pinnedControlsWidth = showPinnedControls ? (isFigmaOverview ? 48 : PINNED_COLUMN_MIN_WIDTH_PX) : 0;
  const fitActive = fitToWidth && !isMobileColumns;
  const { rendered: renderedColumns, hiddenByFit } = useMemo(() => {
    if (!fitActive) {
      return { rendered: [...visibleColumns], hiddenByFit: [] as ColumnId[] };
    }
    return fitColumnsToWidth({
      intent: visibleColumns,
      containerWidth: viewportWidth,
      getColumnWidth: (id) => getColumnMinWidthPx(id, toolbarVariant),
      fixedWidth: pinnedControlsWidth,
    });
  }, [fitActive, visibleColumns, viewportWidth, toolbarVariant, pinnedControlsWidth]);

  const renderedSet = useMemo(() => new Set(renderedColumns), [renderedColumns]);
  const visibleSortColumns = useMemo(
    () => STABLECOIN_HEADER_DEFS.filter((column) => renderedSet.has(column.id)),
    [renderedSet],
  );
  const isVisible = useCallback((id: ColumnId) => renderedSet.has(id), [renderedSet]);
  const pinnedStablecoinSet = useMemo(() => new Set(pinnedStablecoinIds), [pinnedStablecoinIds]);
  const tableMinWidthPx = useMemo(
    () => getTableMinWidthPx(renderedColumns, showPinnedControls, toolbarVariant),
    [renderedColumns, showPinnedControls, toolbarVariant],
  );
  const intentMinWidthPx = useMemo(
    () => getTableMinWidthPx(visibleColumns, showPinnedControls, toolbarVariant),
    [showPinnedControls, toolbarVariant, visibleColumns],
  );
  const visibleColumnCount = renderedColumns.length + (showPinnedControls ? 1 : 0);
  const skeletonColumns = useMemo<TableSkeletonColumn[]>(
    () => [
      ...(showPinnedControls
        ? [
            {
              id: "pinned",
              cellClassName: "w-[44px] text-center lg:w-[36px]",
              skeletonClassName: "mx-auto h-4 w-4 rounded-full",
            },
          ]
        : []),
      ...STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) => ({
        id: column.id,
        cellClassName: column.className,
        skeletonClassName: SKELETON_WIDTH_BY_COLUMN[column.id] ?? "h-4 w-16",
      })),
    ],
    [isVisible, showPinnedControls],
  );

  const effectiveSortKey = useMemo(() => resolveEffectiveSortKey(sortKey, renderedSet), [sortKey, renderedSet]);

  const trackedIds = useMemo(() => buildTrackedIdSet(activeFilters, reportCards), [activeFilters, reportCards]);

  const filtered = useMemo(() => filterStablecoins(data, trackedIds, searchQuery), [data, trackedIds, searchQuery]);

  const sorted = useMemo(
    () =>
      sortStablecoins({
        filtered,
        sort,
        effectiveSortKey,
        pegRates,
        pegScores,
        dexLiquidity,
        reportCards,
      }),
    [filtered, sort, effectiveSortKey, pegRates, pegScores, dexLiquidity, reportCards],
  );

  const displayed = useMemo(
    () => prioritizePinnedStablecoins(sorted, pinnedStablecoinIds),
    [pinnedStablecoinIds, sorted],
  );
  const sortedRankById = useMemo(() => new Map(sorted.map((coin, index) => [coin.id, index + 1] as const)), [sorted]);
  const [overviewPageIndex, setOverviewPageIndex] = useState(0);
  const overviewPageCount = isFigmaOverview ? Math.max(1, Math.ceil(displayed.length / OVERVIEW_PAGE_SIZE)) : 1;

  useEffect(() => {
    setOverviewPageIndex((current) => Math.min(current, overviewPageCount - 1));
  }, [overviewPageCount]);

  const overviewPageStart = isFigmaOverview ? overviewPageIndex * OVERVIEW_PAGE_SIZE : 0;
  const overviewPageEnd = isFigmaOverview
    ? Math.min(displayed.length, overviewPageStart + OVERVIEW_PAGE_SIZE)
    : displayed.length;
  const displayedRows = useMemo(
    () => (isFigmaOverview ? displayed.slice(overviewPageStart, overviewPageEnd) : displayed),
    [displayed, isFigmaOverview, overviewPageEnd, overviewPageStart],
  );

  // Reset scroll when filters, search, sort, or starred row priority changes.
  const prevRef = useRef<{ rows: typeof displayed; sort: typeof sort } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    if (prev && (prev.rows !== displayed || prev.sort !== sort)) {
      scrollRef.current?.scrollTo({ top: 0 });
      if (isFigmaOverview) setOverviewPageIndex(0);
    }
    prevRef.current = { rows: displayed, sort };
  }, [displayed, isFigmaOverview, sort]);

  const virtualDensityConfig = useMemo(
    () => ({
      ...densityConfig,
      rowHeight: isFigmaOverview
        ? OVERVIEW_ROW_HEIGHT_ESTIMATE_PX[density]
        : isMobileColumns
          ? Math.max(densityConfig.rowHeight, MOBILE_COLUMNS_MIN_ROW_HEIGHT_PX)
          : Math.max(densityConfig.rowHeight, VIRTUAL_ROW_HEIGHT_ESTIMATE_PX[density]),
      iconSize: isFigmaOverview ? OVERVIEW_ICON_SIZE_PX : densityConfig.iconSize,
    }),
    [density, densityConfig, isFigmaOverview, isMobileColumns],
  );

  // Virtual scrolling with density-aware row height
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentional for large datasets.
  const virtualizer = useVirtualizer({
    count: displayedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualDensityConfig.rowHeight,
    measureElement: (element) => element?.getBoundingClientRect().height ?? virtualDensityConfig.rowHeight,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0;
  const measureVirtualRow = useCallback(
    (element: HTMLTableRowElement | null) => {
      if (!element || typeof virtualizer.measureElement !== "function") return;
      virtualizer.measureElement(element);
    },
    [virtualizer],
  );

  const handleCsvExport = useCallback(() => {
    exportStablecoinsCsv(displayed, pegScores, dexLiquidity, reportCards);
  }, [displayed, pegScores, dexLiquidity, reportCards]);

  const intentOverflows = viewportWidth > 0 && intentMinWidthPx > viewportWidth;
  const showFitControl = !isMobileColumns && (hiddenByFit.length > 0 || (!fitToWidth && intentOverflows));
  const fitControl = showFitControl ? (
    <Button
      variant="outline"
      size="sm"
      className={isFigmaOverview ? "h-8 min-h-8 rounded-lg px-2 sm:px-3" : "rounded-lg min-h-11 sm:min-h-8"}
      onClick={() => setFitToWidth(!fitToWidth)}
      title={
        fitToWidth
          ? `${hiddenByFit.length} column${hiddenByFit.length === 1 ? "" : "s"} hidden to fit the width — show all with horizontal scroll`
          : "Hide overflow columns so the table fits without horizontal scroll"
      }
    >
      {fitToWidth ? `+${hiddenByFit.length} column${hiddenByFit.length === 1 ? "" : "s"}` : "Fit columns"}
    </Button>
  ) : null;

  const tableToolbar = (
    <TableToolbar
      density={density}
      onDensityChange={setDensity}
      visibleColumns={visibleColumns}
      onVisibleColumnsChange={setVisibleColumns}
      onResetColumns={resetColumns}
      defaultColumns={deviceDefault}
      onExport={handleCsvExport}
      exportDisabled={displayed.length === 0}
      additionalActions={
        fitControl ? (
          <>
            {fitControl}
            {toolbarActions}
          </>
        ) : (
          toolbarActions
        )
      }
      searchValue={searchQuery}
      onSearchChange={onSearchChange}
      searchPlaceholder={isFigmaOverview ? "Search" : undefined}
      eyebrow={toolbarEyebrow}
      description={toolbarDescription}
      titleId={toolbarTitleId}
      meta={toolbarMeta}
      variant={toolbarVariant}
    />
  );

  // P6 — j/k row cursor over the visible (post-pin) rows, scoped to the table.
  // o/Enter opens the dossier, s toggles the watchlist, c adds to /compare.
  // Cursor scroll-into-view is handled inside the hook via the virtualizer; row
  // highlighting is rendered through `data-cursor` props on the virtual row.
  const watchlist = useWatchlist();
  // Only hand the virtualizer to the cursor when it exposes `scrollToIndex`
  // (the hook calls it to keep the cursor visible). Guards against virtualizer
  // stand-ins that omit it. The element-type generic mismatch (HTMLDivElement
  // vs HTMLElement) is benign, so we widen to the hook's type.
  const cursorVirtualizer =
    typeof virtualizer.scrollToIndex === "function"
      ? (virtualizer as unknown as Virtualizer<HTMLElement, Element>)
      : null;
  const { activateCursorAtIndex, activeCursorIndex } = useRowCursor<StablecoinData>({
    rows: displayedRows,
    virtualizer: cursorVirtualizer,
    getRowId: (coin) => coin.id,
    onOpen: (coin) => router.push(buildStablecoinUrl(coin.id)),
    onToggleStar: (coin) => watchlist.toggle(coin.id),
    onAddToCompare: (coin) => router.push(buildLiveCompareUrl([coin.id])),
    scopeRef: tableRef as React.RefObject<HTMLElement>,
  });

  // P8 — numeric column sort: providers broadcast the Nth visible column on
  // keys 1-9; map it to the matching sortable header and toggle its sort.
  useSortColumnEvent(visibleSortColumns, toggleSort);

  if (isLoading) {
    return (
      <VirtualTableFrame
        {...STABLECOIN_FRAME_SHARED}
        className={isFigmaOverview ? "pharos-overview-table-shell" : undefined}
        density={density}
        striped="indexed"
        mobileScrollHint={isFigmaOverview ? false : STABLECOIN_FRAME_SHARED.mobileScrollHint}
        viewportRef={setViewportNode}
        viewportClassName={
          isFigmaOverview ? "pharos-overview-table-viewport" : STABLECOIN_FRAME_SHARED.viewportClassName
        }
        tableProps={{
          style: { minWidth: tableMinWidthPx },
        }}
      >
        <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
        <StablecoinTableHeader showPinnedControls={showPinnedControls} isVisible={isVisible} variant={toolbarVariant} />
        <TableBody>
          <TableSkeletonRows columns={skeletonColumns} rowCount={SKELETON_ROWS.length} />
        </TableBody>
      </VirtualTableFrame>
    );
  }

  const defaultFooterSlot =
    displayed.length > 0 ? (
      <div className="flex flex-col gap-1 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <span className="text-sm text-muted-foreground">
          Showing{" "}
          <span className="font-mono tabular-nums text-foreground">{displayed.length.toLocaleString("en-US")}</span>{" "}
          active stablecoins — pre-launch and frozen excluded,{" "}
          <Link
            href="/screener/"
            className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
          >
            see Screener
          </Link>
        </span>
        <span className="pharos-meta sm:text-right">
          Rows open the detail dossier. Green and red deltas reflect supply expansion and contraction, not price return.
        </span>
      </div>
    ) : null;
  const overviewFooterSlot =
    displayed.length > 0 ? (
      <div className="pharos-overview-table-footer">
        <span>
          Showing{" "}
          <span className="tabular-nums">
            {displayed.length > 0 ? overviewPageStart + 1 : 0}-{overviewPageEnd}
          </span>{" "}
          of <span className="tabular-nums">{displayed.length.toLocaleString("en-US")}</span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="pharos-overview-pagination-button"
            disabled={overviewPageIndex === 0}
            onClick={() => {
              setOverviewPageIndex((current) => Math.max(0, current - 1));
              scrollRef.current?.scrollTo({ top: 0 });
            }}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </button>
          <button
            type="button"
            className="pharos-overview-pagination-button"
            disabled={overviewPageIndex >= overviewPageCount - 1}
            onClick={() => {
              setOverviewPageIndex((current) => Math.min(overviewPageCount - 1, current + 1));
              scrollRef.current?.scrollTo({ top: 0 });
            }}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    ) : null;

  const tableFrame = (
    <VirtualTableFrame
      {...STABLECOIN_FRAME_SHARED}
      surfaceRef={tableRef}
      className={
        isFigmaOverview
          ? "pharos-overview-table-shell animate-in fade-in duration-200"
          : "animate-in fade-in duration-200"
      }
      density={density}
      viewportRef={setViewportNode}
      mobileScrollHint={isFigmaOverview ? false : STABLECOIN_FRAME_SHARED.mobileScrollHint}
      viewportClassName={isFigmaOverview ? "pharos-overview-table-viewport" : STABLECOIN_FRAME_SHARED.viewportClassName}
      tableProps={{
        style: { minWidth: tableMinWidthPx },
      }}
      topSlot={
        <>
          {isFigmaOverview ? null : (
            <TableBackgroundRefreshingBar queryKeys={STABLECOIN_TABLE_REFRESH_QUERY_KEYS} isPending={isLoading} />
          )}
          {isFigmaOverview ? null : tableToolbar}
          {filterPanel}
        </>
      }
      footerSlot={isFigmaOverview ? overviewFooterSlot : defaultFooterSlot}
    >
      <TableCaption className="sr-only">Stablecoin data table</TableCaption>
      <StablecoinTableHeader
        showPinnedControls={showPinnedControls}
        isVisible={isVisible}
        sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue, showHeaderMethodologyHints }}
        sticky
        variant={toolbarVariant}
      />
      <TableBody>
        {paddingTop > 0 && (
          <tr>
            <td colSpan={visibleColumnCount} style={{ height: paddingTop, padding: 0 }} />
          </tr>
        )}
        {virtualItems.map((virtualRow) => {
          const coin = displayedRows[virtualRow.index];
          if (!coin) return null;
          const rowIndex = isFigmaOverview ? overviewPageStart + virtualRow.index : virtualRow.index;
          return (
            <StablecoinVirtualRow
              key={coin.id}
              coin={coin}
              rank={sortedRankById.get(coin.id) ?? rowIndex + 1}
              virtualIndex={virtualRow.index}
              isStriped={rowIndex % 2 === 1}
              densityConfig={virtualDensityConfig}
              density={density}
              variant={toolbarVariant}
              isVisible={isVisible}
              logos={logos}
              pegRates={pegRates}
              pegScores={pegScores}
              dexLiquidity={dexLiquidity}
              reportCards={reportCards}
              showPinnedControl={showPinnedControls}
              isPinned={pinnedStablecoinSet.has(coin.id)}
              onTogglePinned={onTogglePinnedStablecoin}
              isCursor={virtualRow.index === activeCursorIndex}
              onCursorMouseEnter={activateCursorAtIndex}
              onNavigate={handleNavigate}
              onPrefetch={prefetch}
              measureElement={measureVirtualRow}
            />
          );
        })}
        {paddingBottom > 0 && (
          <tr>
            <td colSpan={visibleColumnCount} style={{ height: paddingBottom, padding: 0 }} />
          </tr>
        )}
        {displayed.length === 0 && (
          <StablecoinTableEmptyState
            searchQuery={searchQuery}
            activeFilters={activeFilters}
            data={data}
            logos={logos}
            onClearFilters={onClearFilters}
            onClearSearch={onClearSearch}
          />
        )}
      </TableBody>
    </VirtualTableFrame>
  );

  return isFigmaOverview ? (
    <div className="space-y-3">
      {tableToolbar}
      {tableFrame}
    </div>
  ) : (
    tableFrame
  );
}
