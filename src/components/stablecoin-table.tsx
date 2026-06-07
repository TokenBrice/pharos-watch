"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { QueryKey } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCaption, TableHead, TableHeader, TableRow, VirtualTableFrame } from "@/components/table";
import { TableToolbar } from "./table-toolbar";
import { useTableDensity, DENSITY_CONFIGS, type TableDensity } from "@/hooks/use-table-density";
import { useIsMobile } from "@/hooks/use-is-mobile";
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
import { useWatchlist } from "@/hooks/use-watchlist";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { SORT_COLUMN_EVENT, type SortColumnEventDetail } from "@/components/providers";
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
// M1: keys feeding the home table's columns (market data, peg, grade, liquidity).
// A background refetch surfaces the RefreshingBar while prior rows stay visible.
const STABLECOIN_TABLE_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  ["stablecoins"],
  ["peg-summary"],
  ["report-cards"],
  ["dex-liquidity"],
];
const MOBILE_TABLE_BASE_MIN_WIDTH_PX = 420;
const PINNED_COLUMN_MIN_WIDTH_PX = 56;
const VIRTUAL_ROW_HEIGHT_ESTIMATE_PX: Record<TableDensity, number> = {
  list: 32,
  compact: 52,
  comfortable: 64,
  spacious: 75,
};
const MOBILE_COLUMN_MIN_WIDTH_PX: Record<ColumnId, number> = {
  rank: 40,
  name: 168,
  price: 88,
  peg: 92,
  mcap: 112,
  change24h: 92,
  change7d: 96,
  grade: 76,
  stability: 96,
  liquidity: 72,
  blacklistable: 108,
  mintAuthority: 108,
  backing: 92,
  type: 92,
  flags: 72,
};

function sameColumnSet(left: readonly ColumnId[], right: readonly ColumnId[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function getMobileTableMinWidthPx(visibleColumns: readonly ColumnId[], showPinnedControls: boolean): number {
  const selectedWidth = visibleColumns.reduce(
    (total, id) => total + MOBILE_COLUMN_MIN_WIDTH_PX[id],
    showPinnedControls ? PINNED_COLUMN_MIN_WIDTH_PX : 0,
  );
  return Math.max(MOBILE_TABLE_BASE_MIN_WIDTH_PX, selectedWidth);
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
    className: "w-[168px] max-w-[168px] xl:w-[150px] xl:max-w-[150px]",
  },
  { id: "price", label: "Price", sortKey: "price", className: "text-right" },
  {
    id: "peg",
    label: "Peg",
    sortKey: "peg",
    className: "text-right",
    title: "Sort by peg deviation — ascending shows tightest pegs first, descending shows worst depegs first",
  },
  { id: "mcap", label: "Market Cap", sortKey: "mcap", className: "text-right" },
  { id: "change24h", label: "24h", sortKey: "change24h", className: "text-right", title: "24-hour market cap change" },
  { id: "change7d", label: "7d", sortKey: "change7d", className: "text-right", title: "7-day market cap change" },
  {
    id: "grade",
    label: "Grade",
    headerAdornment: <MethodologyHint topic="safetyScore" />,
    sortKey: "grade",
    className: "text-center",
    title: "Pharos Grade: overall safety score across peg stability, liquidity, resilience, decentralization, and dependency risk",
  },
  {
    id: "stability",
    label: "Peg Score",
    headerAdornment: <MethodologyHint topic="pegScore" />,
    sortKey: "stability",
    className: "text-right",
    title: "Peg Stability Score (0-100): measures peg-holding consistency over 30 days",
  },
  {
    id: "liquidity",
    label: "Liq",
    headerAdornment: <MethodologyHint topic="liquidityScore" />,
    sortKey: "liquidity",
    className: "text-right",
    title: "DEX Liquidity Score: measures pool depth, volume, and diversity across decentralized exchanges",
  },
  {
    id: "blacklistable",
    label: "Blacklistable",
    sortKey: "blacklistable",
    className: "text-center",
    title: "Issuer blacklist/freeze control risk, including inherited dependency exposure where applicable",
  },
  {
    id: "mintAuthority",
    label: "Mint Auth",
    className: "text-center",
    title: "Curated mint-authority review: who can mint, authorize, bridge, or inherit durable supply control. Descriptive only; not scored.",
  },
  { id: "backing", label: "Backing", className: "text-center", title: "Collateral backing type" },
  { id: "type", label: "Type", className: "text-center", title: "Stablecoin mechanism type" },
  { id: "flags", label: "Flags", className: "text-center" },
] as const;

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: readonly FilterTag[];
  toolbarActions?: React.ReactNode;
  filterPanel?: React.ReactNode;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  searchQuery?: string;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  initialVisibleColumns?: readonly ColumnId[];
  columnPreferenceNamespace?: string;
  suppressDesktopHorizontalScroll?: boolean;
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
  pegScores,
  dexLiquidity,
  reportCards,
  initialVisibleColumns,
  columnPreferenceNamespace = "pharos-table",
  suppressDesktopHorizontalScroll = false,
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
}: StablecoinTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<StablecoinTableSortKey>(
    initialSort?.key ?? "mcap",
    initialSort?.direction ?? "desc",
  );
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const handleNavigate = useCallback((coinId: string) => {
    router.push(buildStablecoinUrl(coinId));
  }, [router]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const isMobileColumns = useIsMobile(1280);

  // Density mode
  const [density, setDensity] = useTableDensity();
  const densityConfig = DENSITY_CONFIGS[density];

  // Column visibility — mobile gets a reduced default (hiddenMobile columns start off).
  // `initialVisibleColumns`, when provided, seeds the default for first-mount on this route
  // (e.g., compact homepage views ship a denser lens). Existing localStorage prefs still win on
  // subsequent loads — the prop only seeds the default branch.
  const deviceDefault = useMemo<ColumnId[]>(
    () => {
      if (isMobileColumns) {
        return [...MOBILE_DEFAULT_COLUMNS];
      }
      if (initialVisibleColumns && initialVisibleColumns.length > 0) {
        return [...initialVisibleColumns];
      }
      return [...DEFAULT_VISIBLE_COLUMNS];
    },
    [initialVisibleColumns, isMobileColumns],
  );
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
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const showPinnedControls = typeof onTogglePinnedStablecoin === "function";
  const isVisible = useCallback((id: ColumnId) => visibleSet.has(id), [visibleSet]);
  const pinnedStablecoinSet = useMemo(() => new Set(pinnedStablecoinIds), [pinnedStablecoinIds]);
  const mobileTableMinWidthPx = useMemo(
    () => getMobileTableMinWidthPx(visibleColumns, showPinnedControls),
    [showPinnedControls, visibleColumns],
  );
  const visibleColumnCount = visibleColumns.length + (showPinnedControls ? 1 : 0);

  const effectiveSortKey = useMemo(() => resolveEffectiveSortKey(sortKey, visibleSet), [sortKey, visibleSet]);

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
  const sortedRankById = useMemo(
    () => new Map(sorted.map((coin, index) => [coin.id, index + 1] as const)),
    [sorted],
  );

  // Reset scroll when filters, search, sort, or starred row priority changes.
  const prevRef = useRef<{ rows: typeof displayed; sort: typeof sort } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    if (prev && (prev.rows !== displayed || prev.sort !== sort)) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    prevRef.current = { rows: displayed, sort };
  }, [displayed, sort]);

  const virtualDensityConfig = useMemo(
    () => ({
      ...densityConfig,
      rowHeight: isMobileColumns
        ? Math.max(densityConfig.rowHeight, 68)
        : Math.max(densityConfig.rowHeight, VIRTUAL_ROW_HEIGHT_ESTIMATE_PX[density]),
    }),
    [density, densityConfig, isMobileColumns],
  );

  // Virtual scrolling with density-aware row height
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentional for large datasets.
  const virtualizer = useVirtualizer({
    count: displayed.length,
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
  const { getRowProps } = useRowCursor<StablecoinData>({
    rows: displayed,
    virtualizer: cursorVirtualizer,
    getRowId: (coin) => coin.id,
    onOpen: (coin) => router.push(buildStablecoinUrl(coin.id)),
    onToggleStar: (coin) => watchlist.toggle(coin.id),
    onAddToCompare: (coin) => router.push(buildLiveCompareUrl([coin.id])),
    scopeRef: tableRef as React.RefObject<HTMLElement>,
  });

  // P8 — numeric column sort: providers broadcast the Nth visible column on
  // keys 1-9; map it to the matching sortable header and toggle its sort.
  useEffect(() => {
    function handleSortColumn(event: Event) {
      const detail = (event as CustomEvent<SortColumnEventDetail>).detail;
      const columnNumber = detail?.columnNumber;
      if (!columnNumber) return;
      const visibleDefs = STABLECOIN_HEADER_DEFS.filter((column) => visibleSet.has(column.id));
      const target = visibleDefs[columnNumber - 1];
      if (target?.sortKey) toggleSort(target.sortKey);
    }
    window.addEventListener(SORT_COLUMN_EVENT, handleSortColumn);
    return () => window.removeEventListener(SORT_COLUMN_EVENT, handleSortColumn);
  }, [visibleSet, toggleSort]);

  if (isLoading) {
    return (
      <div className="pharos-table-shell">
        <div className="bg-muted/50 h-10" />
        {SKELETON_ROWS.map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
            <Skeleton className="h-4 w-8 shrink-0" />
            <Skeleton className="h-6 w-6 rounded-full shrink-0" />
            <Skeleton className="h-4 w-28" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12 hidden xl:block" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-14 hidden xl:block" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <VirtualTableFrame
      surfaceRef={tableRef}
      tableId="stablecoin-overview"
      testId="stablecoin-overview-table"
      className="animate-in fade-in duration-300"
      density={density}
      viewportRef={scrollRef}
      viewportClassName={`max-h-[50vh] overscroll-y-auto px-0 pb-[calc(var(--mobile-utility-safe-offset,0px)+0.75rem)] pr-2 sm:max-h-[70vh] sm:pb-2 sm:pr-0 ${suppressDesktopHorizontalScroll ? "xl:overflow-x-hidden" : ""}`}
      mobileScrollHint="Swipe sideways for more columns. Risk cues stay visible in each row."
      tableClassName="min-w-[420px] xl:min-w-[820px] table-fixed"
      tableProps={{
        style: isMobileColumns ? { minWidth: mobileTableMinWidthPx } : undefined,
      }}
      topSlot={(
        <>
          <TableBackgroundRefreshingBar
            queryKeys={STABLECOIN_TABLE_REFRESH_QUERY_KEYS}
            isPending={isLoading}
          />
          <TableToolbar
            density={density}
            onDensityChange={setDensity}
            visibleColumns={visibleColumns}
            onVisibleColumnsChange={setVisibleColumns}
            onResetColumns={resetColumns}
            defaultColumns={deviceDefault}
            onExport={handleCsvExport}
            exportDisabled={displayed.length === 0}
            additionalActions={toolbarActions}
            eyebrow={toolbarEyebrow}
            description={toolbarDescription}
            titleId={toolbarTitleId}
            meta={toolbarMeta}
          />
          {filterPanel}
        </>
      )}
      footerSlot={displayed.length > 0 ? (
        <div className="flex flex-col gap-1 border-t px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
          <span className="text-sm text-muted-foreground">
            Showing <span className="font-mono tabular-nums">{displayed.length.toLocaleString()}</span> stablecoins
          </span>
          <span className="pharos-meta">
            Rows open the detail dossier. Green and red deltas reflect supply expansion and contraction, not price return.
          </span>
        </div>
      ) : null}
    >
          <TableCaption className="sr-only">Stablecoin data table</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              {showPinnedControls && (
                <TableHead scope="col" className="w-[44px] text-center xl:w-[26px]">
                  <span className="sr-only">Starred</span>
                </TableHead>
              )}
              {STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) =>
                column.sortKey ? (
                  <SortableTableHead
                    key={column.id}
                    sortKey={column.sortKey}
                    currentSortKey={sortKey}
                    sortDirection={sortDirection}
                    label={column.sortLabel ?? (typeof column.label === "string" ? column.label : "")}
                    toggleSort={toggleSort}
                    getAriaSortValue={getAriaSortValue}
                    adornment={showHeaderMethodologyHints ? column.headerAdornment : undefined}
                    className={column.className}
                    title={column.title}
                  />
                ) : (
                  <TableHead key={column.id} scope="col" className={column.className} title={column.title}>
                    {column.label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <tr>
                <td colSpan={visibleColumnCount} style={{ height: paddingTop, padding: 0 }} />
              </tr>
            )}
            {virtualItems.map((virtualRow) => {
              const coin = displayed[virtualRow.index];
              return (
                <StablecoinVirtualRow
                  key={coin.id}
                  coin={coin}
                  rank={sortedRankById.get(coin.id) ?? virtualRow.index + 1}
                  virtualIndex={virtualRow.index}
                  isStriped={virtualRow.index % 2 === 1}
                  densityConfig={virtualDensityConfig}
                  density={density}
                  isVisible={isVisible}
                  logos={logos}
                  pegRates={pegRates}
                  pegScores={pegScores}
                  dexLiquidity={dexLiquidity}
                  reportCards={reportCards}
                  showPinnedControl={showPinnedControls}
                  isPinned={pinnedStablecoinSet.has(coin.id)}
                  onTogglePinned={onTogglePinnedStablecoin}
                  rowProps={getRowProps(virtualRow.index, coin.id)}
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
}
