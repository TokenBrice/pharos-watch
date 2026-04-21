"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TableBody, TableHead, TableCaption, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { TableToolbar } from "./table-toolbar";
import { useTableDensity, DENSITY_CONFIGS } from "@/hooks/use-table-density";
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
import { MethodologyLabel } from "@/components/methodology-hint";
import { TablePagination } from "@/components/table-pagination";
import { StablecoinTableEmptyState } from "@/components/stablecoin-table-empty-state";
import { StablecoinVirtualRow } from "@/components/stablecoin-table-row";
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
const OVERSCAN = 12;

interface StablecoinHeaderDef {
  id: ColumnId;
  label: React.ReactNode;
  className?: string;
  title?: string;
  sortKey?: StablecoinTableSortKey;
}

const STABLECOIN_HEADER_DEFS: readonly StablecoinHeaderDef[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "name", label: "Name", sortKey: "name", className: "w-[90px] xl:w-[200px] max-w-[90px] xl:max-w-none" },
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
    label: <MethodologyLabel topic="safetyScore">Grade</MethodologyLabel>,
    sortKey: "grade",
    className: "text-center",
    title: "Pharos Grade: overall safety score across peg stability, liquidity, resilience, decentralization, and dependency risk",
  },
  {
    id: "stability",
    label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>,
    sortKey: "stability",
    className: "text-right",
    title: "Peg Stability Score (0-100): measures peg-holding consistency over 30 days",
  },
  {
    id: "liquidity",
    label: <MethodologyLabel topic="liquidityScore">Liq</MethodologyLabel>,
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
  { id: "backing", label: "Backing", className: "text-center", title: "Collateral backing type" },
  { id: "type", label: "Type", className: "text-center", title: "Stablecoin mechanism type" },
  { id: "flags", label: "Flags", className: "text-center" },
] as const;

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: FilterTag[];
  toolbarActions?: React.ReactNode;
  filterPanel?: React.ReactNode;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  searchQuery?: string;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  pinnedStablecoinIds?: readonly string[];
  onTogglePinnedStablecoin?: (stablecoinId: string) => void;
  onClearSearch?: () => void;
  onClearFilters?: () => void;
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
  pinnedStablecoinIds = [],
  onTogglePinnedStablecoin,
  onClearSearch,
  onClearFilters,
}: StablecoinTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<StablecoinTableSortKey>(
    "mcap",
    "desc",
  );
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const router = useRouter();
  const prefetch = usePrefetchStablecoin();
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Density mode
  const [density, setDensity] = useTableDensity();
  const densityConfig = DENSITY_CONFIGS[density];
  const isListDensity = density === "list";

  // Column visibility — mobile gets a reduced default (hiddenMobile columns start off)
  const deviceDefault = useMemo(
    () => (typeof window !== "undefined" && window.innerWidth < 640 ? MOBILE_DEFAULT_COLUMNS : DEFAULT_VISIBLE_COLUMNS),
    [],
  );
  const [visibleColumns, setVisibleColumns, resetColumns] = usePreference<ColumnId[]>(
    "pharos-table-columns",
    deviceDefault,
    {
      decode: (raw) => normalizeVisibleColumns(raw, deviceDefault),
    },
  );
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const showPinnedControls = typeof onTogglePinnedStablecoin === "function";
  const isVisible = useCallback((id: ColumnId) => visibleSet.has(id), [visibleSet]);
  const pinnedStablecoinSet = useMemo(() => new Set(pinnedStablecoinIds), [pinnedStablecoinIds]);

  // Keyboard shortcut: focus table
  useEffect(() => {
    function handleFocusTable() {
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      // Focus the first row if available
      const firstRow = tableRef.current?.querySelector<HTMLElement>('[role="link"]');
      firstRow?.focus();
    }

    window.addEventListener("focus-stablecoin-table", handleFocusTable);
    return () => window.removeEventListener("focus-stablecoin-table", handleFocusTable);
  }, []);

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

  // Reset scroll when filters, search, sort, or starred row priority changes.
  const prevRef = useRef<{ rows: typeof displayed; sort: typeof sort } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    if (prev && (prev.rows !== displayed || prev.sort !== sort)) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    prevRef.current = { rows: displayed, sort };
  }, [displayed, sort]);

  // Virtual scrolling with density-aware row height
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentional for large datasets.
  const virtualizer = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => densityConfig.rowHeight,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0;

  // Visible range for footer
  const rangeStart = virtualItems.length > 0 ? virtualItems[0].index + 1 : 0;
  const rangeEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index + 1 : 0;

  const handleCsvExport = useCallback(() => {
    exportStablecoinsCsv(displayed, pegScores, dexLiquidity, reportCards);
  }, [displayed, pegScores, dexLiquidity, reportCards]);

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
            <Skeleton className="h-4 w-12 hidden sm:block" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-14 hidden sm:block" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={tableRef} className="pharos-table-shell animate-in fade-in duration-300">
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
      />
      {filterPanel}

      {/* Scroll container — handles both horizontal and vertical overflow */}
      <div ref={scrollRef} className="scroll-shadow max-h-[50vh] overflow-y-auto overflow-x-auto px-0 pb-2 pr-2 sm:max-h-[70vh] sm:pr-0">
        <table className={`min-w-[420px] sm:min-w-[820px] w-full caption-bottom text-sm pharos-table-striped pharos-density-${density}`}>
          <TableCaption className="sr-only">Stablecoin data table</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              {showPinnedControls && (
                <TableHead scope="col" className="w-[36px] text-center">
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
                    label={typeof column.label === "string" ? column.label : ""}
                    toggleSort={toggleSort}
                    getAriaSortValue={getAriaSortValue}
                    handleSortKeyDown={handleSortKeyDown}
                    className={column.className}
                    title={column.title}
                  >
                    {column.label}
                  </SortableTableHead>
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
                <td style={{ height: paddingTop, padding: 0 }} />
              </tr>
            )}
            {virtualItems.map((virtualRow) => {
              const coin = displayed[virtualRow.index];
              return (
                <StablecoinVirtualRow
                  key={coin.id}
                  coin={coin}
                  index={virtualRow.index}
                  densityConfig={densityConfig}
                  isListDensity={isListDensity}
                  isVisible={isVisible}
                  logos={logos}
                  pegRates={pegRates}
                  pegScores={pegScores}
                  dexLiquidity={dexLiquidity}
                  reportCards={reportCards}
                  showPinnedControl={showPinnedControls}
                  isPinned={pinnedStablecoinSet.has(coin.id)}
                  onTogglePinned={onTogglePinnedStablecoin}
                  onNavigate={(coinId) => router.push(buildStablecoinUrl(coinId))}
                  onPrefetch={prefetch}
                />
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: paddingBottom, padding: 0 }} />
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
        </table>
      </div>

      {/* Scroll position footer */}
      {displayed.length > 0 && (
        <TablePagination
          page={0}
          totalPages={1}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={displayed.length}
          noun="stablecoins"
          showControls={false}
          supplementaryText="Rows open the detail dossier. Green and red deltas reflect supply expansion and contraction, not price return."
        />
      )}
    </div>
  );
}
