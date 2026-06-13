"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { QueryKey } from "@tanstack/react-query";
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
  list: 32,
  compact: 52,
  comfortable: 64,
  spacious: 75,
};
// Per-column content minimums. The table runs `table-fixed`; summing these for
// the visible set yields the inline min-width at every tier, so the viewport
// scrolls horizontally instead of squeezing cell content into neighbors.
const COLUMN_MIN_WIDTH_PX: Record<ColumnId, number> = {
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
  mintAuthority: 116,
  backing: 92,
  type: 92,
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

function getTableMinWidthPx(visibleColumns: readonly ColumnId[], showPinnedControls: boolean): number {
  const selectedWidth = visibleColumns.reduce(
    (total, id) => total + COLUMN_MIN_WIDTH_PX[id],
    showPinnedControls ? PINNED_COLUMN_MIN_WIDTH_PX : 0,
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
    className: "w-[168px] max-w-[168px] xl:w-[150px] xl:max-w-[150px]",
  },
  {
    id: "price",
    label: "Price",
    sortKey: "price",
    // Pinned to content width below xl: fixed-layout leftover sharing otherwise
    // inflates the column past the 390px first viewport and clips the fourth
    // peg-price decimal at rest.
    className: "w-[88px] text-right xl:w-auto",
  },
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
    label: "Mint Score",
    headerAdornment: <MethodologyHint topic="mintAuthorityScore" />,
    sortKey: "mintAuthority",
    className: "text-center",
    title: "Mint Authority Score (0-100): privileged-mint risk score that can drag Safety Score v8 Decentralization.",
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
  const visibleSortColumns = useMemo(
    () => STABLECOIN_HEADER_DEFS.filter((column) => visibleSet.has(column.id)),
    [visibleSet],
  );
  const showPinnedControls = typeof onTogglePinnedStablecoin === "function";
  const isVisible = useCallback((id: ColumnId) => visibleSet.has(id), [visibleSet]);
  const pinnedStablecoinSet = useMemo(() => new Set(pinnedStablecoinIds), [pinnedStablecoinIds]);
  const tableMinWidthPx = useMemo(
    () => getTableMinWidthPx(visibleColumns, showPinnedControls),
    [showPinnedControls, visibleColumns],
  );
  const visibleColumnCount = visibleColumns.length + (showPinnedControls ? 1 : 0);
  const skeletonColumns = useMemo<TableSkeletonColumn[]>(
    () => [
      ...(showPinnedControls
        ? [{
          id: "pinned",
          cellClassName: "w-[44px] text-center xl:w-[36px]",
          skeletonClassName: "mx-auto h-4 w-4 rounded-full",
        }]
        : []),
      ...STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) => ({
        id: column.id,
        cellClassName: column.className,
        skeletonClassName: SKELETON_WIDTH_BY_COLUMN[column.id] ?? "h-4 w-16",
      })),
    ],
    [isVisible, showPinnedControls],
  );

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
  useSortColumnEvent(visibleSortColumns, toggleSort);

  if (isLoading) {
    return (
      <VirtualTableFrame
        tableId="stablecoin-overview"
        testId="stablecoin-overview-table"
        density={density}
        striped="indexed"
        viewportClassName="max-h-[50vh] overscroll-y-auto px-0 pb-[calc(var(--mobile-utility-safe-offset,0px)+0.75rem)] pr-2 sm:max-h-[70vh] sm:pb-2 sm:pr-0"
        mobileScrollHint="Swipe sideways for more columns. Risk cues stay visible in each row."
        tableClassName="min-w-[420px] table-fixed"
        tableProps={{
          style: { minWidth: tableMinWidthPx },
        }}
      >
        <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
        <TableHeader className="bg-muted">
          <TableRow rowIntent="static">
            {showPinnedControls ? (
              <TableHead scope="col" className="w-[44px] text-center xl:w-[36px]">
                <span className="sr-only">Starred</span>
              </TableHead>
            ) : null}
            {STABLECOIN_HEADER_DEFS.filter((column) => isVisible(column.id)).map((column) => (
              <TableHead key={column.id} scope="col" className={column.className} title={column.title}>
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeletonRows columns={skeletonColumns} rowCount={SKELETON_ROWS.length} />
        </TableBody>
      </VirtualTableFrame>
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
      viewportClassName="max-h-[50vh] overscroll-y-auto px-0 pb-[calc(var(--mobile-utility-safe-offset,0px)+0.75rem)] pr-2 sm:max-h-[70vh] sm:pb-2 sm:pr-0"
      mobileScrollHint="Swipe sideways for more columns. Risk cues stay visible in each row."
      tableClassName="min-w-[420px] table-fixed"
      tableProps={{
        style: { minWidth: tableMinWidthPx },
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
            Showing <span className="font-mono tabular-nums">{displayed.length.toLocaleString("en-US")}</span> active
            stablecoins — pre-launch and frozen excluded,{" "}
            <Link
              href="/screener/"
              className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
            >
              see Screener
            </Link>
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
                <TableHead scope="col" className="w-[44px] text-center xl:w-[36px]">
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
