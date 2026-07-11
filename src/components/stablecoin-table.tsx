"use client";

import { useMemo, useCallback, useRef, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import type { Virtualizer } from "@tanstack/react-virtual";
import { TableToolbar } from "./table-toolbar";
import type { StablecoinData, FilterTag, PegSummaryCoin, DexLiquidityMap, ReportCard } from "@shared/types";
import { buildStablecoinUrl } from "@/lib/urls";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import type { ColumnId } from "@/hooks/use-preferences";
import { useRowCursor } from "@/hooks/use-row-cursor";
import { useSortColumnEvent } from "@/hooks/use-sort-column-event";
import { useWatchlist } from "@/hooks/use-watchlist";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import type { StablecoinTableSortKey } from "@/components/stablecoin-table-logic";
import { ColumnFitToggle } from "@/components/stablecoin-table-columns";
import { useStablecoinTableColumns, useStablecoinTableRows } from "@/components/stablecoin-table-model";
import { StablecoinTableView } from "@/components/stablecoin-table-view";

const EMPTY_PINNED_STABLECOIN_IDS: readonly string[] = [];

interface StablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  activeFilters: readonly FilterTag[];
  toolbarActions?: ReactNode;
  filterPanel?: ReactNode;
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
  const tableRef = useRef<HTMLDivElement>(null);
  const isFigmaOverview = toolbarVariant === "figmaOverview";
  const showPinnedControls = typeof onTogglePinnedStablecoin === "function";
  const columns = useStablecoinTableColumns({
    initialVisibleColumns,
    columnPreferenceNamespace,
    variant: toolbarVariant,
    showPinnedControls,
  });

  const rows = useStablecoinTableRows({
    data,
    activeFilters,
    reportCards,
    searchQuery,
    sort,
    renderedSet: columns.renderedSet,
    pegRates,
    pegScores,
    dexLiquidity,
    pinnedStablecoinIds,
    isOverview: isFigmaOverview,
    isMobileColumns: columns.isMobileColumns,
    density: columns.density,
    densityConfig: columns.densityConfig,
    scrollRef: columns.scrollRef,
  });

  const fitControl = columns.showFitControl ? (
    <ColumnFitToggle
      fitToWidth={columns.fitToWidth}
      hiddenCount={columns.hiddenByFit.length}
      compact={isFigmaOverview}
      onToggle={() => columns.setFitToWidth(!columns.fitToWidth)}
    />
  ) : null;

  const tableToolbar = (
    <TableToolbar
      density={columns.density}
      onDensityChange={columns.setDensity}
      visibleColumns={columns.visibleColumns}
      onVisibleColumnsChange={columns.setVisibleColumns}
      onResetColumns={columns.resetColumns}
      defaultColumns={columns.deviceDefault}
      onExport={rows.handleCsvExport}
      exportDisabled={rows.displayed.length === 0}
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
    typeof rows.virtualizer.scrollToIndex === "function"
      ? (rows.virtualizer as unknown as Virtualizer<HTMLElement, Element>)
      : null;
  const { activateCursorAtIndex, activeCursorIndex } = useRowCursor<StablecoinData>({
    rows: rows.displayedRows,
    virtualizer: cursorVirtualizer,
    getRowId: (coin) => coin.id,
    onOpen: (coin) => router.push(buildStablecoinUrl(coin.id)),
    onToggleStar: (coin) => watchlist.toggle(coin.id),
    onAddToCompare: (coin) => router.push(buildLiveCompareUrl([coin.id])),
    scopeRef: tableRef as RefObject<HTMLElement>,
  });

  // P8 — numeric column sort: providers broadcast the Nth visible column on
  // keys 1-9; map it to the matching sortable header and toggle its sort.
  useSortColumnEvent(columns.visibleSortColumns, toggleSort);

  return (
    <StablecoinTableView
      isLoading={isLoading}
      variant={toolbarVariant}
      density={columns.density}
      tableMinWidthPx={columns.tableMinWidthPx}
      viewportRef={columns.viewportRef}
      surfaceRef={tableRef}
      showPinnedControls={showPinnedControls}
      isVisible={columns.isVisible}
      skeletonColumns={columns.skeletonColumns}
      tableToolbar={tableToolbar}
      filterPanel={filterPanel}
      displayed={rows.displayed}
      displayedRows={rows.displayedRows}
      overviewPageIndex={rows.overviewPageIndex}
      overviewPageCount={rows.overviewPageCount}
      overviewPageStart={rows.overviewPageStart}
      overviewPageEnd={rows.overviewPageEnd}
      onPreviousOverviewPage={rows.onPreviousOverviewPage}
      onNextOverviewPage={rows.onNextOverviewPage}
      sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue, showHeaderMethodologyHints }}
      virtualItems={rows.virtualItems}
      paddingTop={rows.paddingTop}
      paddingBottom={rows.paddingBottom}
      visibleColumnCount={columns.visibleColumnCount}
      sortedRankById={rows.sortedRankById}
      densityConfig={rows.virtualDensityConfig}
      logos={logos}
      pegRates={pegRates}
      pegScores={pegScores}
      dexLiquidity={dexLiquidity}
      reportCards={reportCards}
      pinnedStablecoinSet={rows.pinnedStablecoinSet}
      onTogglePinnedStablecoin={onTogglePinnedStablecoin}
      activeCursorIndex={activeCursorIndex}
      activateCursorAtIndex={activateCursorAtIndex}
      onNavigate={handleNavigate}
      onPrefetch={prefetch}
      measureVirtualRow={rows.measureVirtualRow}
      searchQuery={searchQuery}
      activeFilters={activeFilters}
      data={data}
      onClearFilters={onClearFilters}
      onClearSearch={onClearSearch}
    />
  );
}
