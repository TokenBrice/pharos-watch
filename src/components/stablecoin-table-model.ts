"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TableSkeletonColumn } from "@/components/table";
import {
  MOBILE_COLUMNS_MIN_ROW_HEIGHT_PX,
  OVERVIEW_ICON_SIZE_PX,
  OVERVIEW_PAGE_SIZE,
  OVERVIEW_ROW_HEIGHT_ESTIMATE_PX,
  OVERSCAN,
  PINNED_COLUMN_MIN_WIDTH_PX,
  SKELETON_WIDTH_BY_COLUMN,
  STABLECOIN_HEADER_DEFS,
  VIRTUAL_ROW_HEIGHT_ESTIMATE_PX,
  getColumnMinWidthPx,
  getTableMinWidthPx,
  sameColumnSet,
  type StablecoinTableVisualVariant,
} from "@/components/stablecoin-table-columns";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  filterStablecoins,
  prioritizePinnedStablecoins,
  resolveEffectiveSortKey,
  sortStablecoins,
  type StablecoinTableSortKey,
} from "@/components/stablecoin-table-logic";
import { useElementWidth } from "@/hooks/use-element-width";
import { useFittedColumns } from "@/hooks/use-fitted-columns";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
  usePreference,
  type ColumnId,
} from "@/hooks/use-preferences";
import { DENSITY_CONFIGS, useTableDensity, type TableDensity } from "@/hooks/use-table-density";
import type { DexLiquidityMap, FilterTag, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";

export interface StablecoinTableSort {
  key: StablecoinTableSortKey;
  direction: "asc" | "desc";
}

export function useStablecoinTableColumns({
  initialVisibleColumns,
  columnPreferenceNamespace,
  variant,
  showPinnedControls,
}: {
  initialVisibleColumns?: readonly ColumnId[];
  columnPreferenceNamespace: string;
  variant: StablecoinTableVisualVariant;
  showPinnedControls: boolean;
}) {
  const isOverview = variant === "figmaOverview";
  const scrollRef = useRef<HTMLDivElement>(null);
  const isMobileColumns = useIsMobile(isOverview ? 768 : 1024);
  const [measureViewportRef, viewportWidth] = useElementWidth<HTMLDivElement>();
  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      measureViewportRef(node);
    },
    [measureViewportRef],
  );
  const [density, setDensity] = useTableDensity();
  const densityConfig = DENSITY_CONFIGS[density];
  const deviceDefault = useMemo<ColumnId[]>(() => {
    if (isOverview && initialVisibleColumns?.length) return [...initialVisibleColumns];
    if (isMobileColumns) return [...MOBILE_DEFAULT_COLUMNS];
    if (initialVisibleColumns?.length) return [...initialVisibleColumns];
    return [...DEFAULT_VISIBLE_COLUMNS];
  }, [initialVisibleColumns, isMobileColumns, isOverview]);
  const preferenceKey = isMobileColumns
    ? `${columnPreferenceNamespace}-columns-mobile`
    : `${columnPreferenceNamespace}-columns`;
  const [visibleColumns, setVisibleColumns, resetColumns] = usePreference<ColumnId[]>(preferenceKey, deviceDefault, {
    decode: (raw) => normalizeVisibleColumns(raw, deviceDefault),
  });
  const previousDefaultColumnsRef = useRef<readonly ColumnId[]>(deviceDefault);

  useEffect(() => {
    setVisibleColumns((current) => {
      const previousDefault = previousDefaultColumnsRef.current;
      previousDefaultColumnsRef.current = deviceDefault;
      return sameColumnSet(current, previousDefault) ? [...deviceDefault] : current;
    });
  }, [deviceDefault, setVisibleColumns]);

  const getColumnWidth = useCallback((id: ColumnId) => getColumnMinWidthPx(id, variant), [variant]);
  const { renderedColumns, hiddenByFit, fitToWidth, setFitToWidth } = useFittedColumns({
    namespace: columnPreferenceNamespace,
    intent: visibleColumns,
    enabled: !isMobileColumns,
    containerWidth: viewportWidth,
    getColumnWidth,
    fixedWidth: showPinnedControls ? (isOverview ? 48 : PINNED_COLUMN_MIN_WIDTH_PX) : 0,
  });
  const renderedSet = useMemo(() => new Set(renderedColumns), [renderedColumns]);
  const isVisible = useCallback((id: ColumnId) => renderedSet.has(id), [renderedSet]);
  const tableMinWidthPx = useMemo(
    () => getTableMinWidthPx(renderedColumns, showPinnedControls, variant),
    [renderedColumns, showPinnedControls, variant],
  );
  const intentMinWidthPx = useMemo(
    () => getTableMinWidthPx(visibleColumns, showPinnedControls, variant),
    [showPinnedControls, variant, visibleColumns],
  );
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
  const intentOverflows = viewportWidth > 0 && intentMinWidthPx > viewportWidth;

  return {
    density,
    setDensity,
    densityConfig,
    deviceDefault,
    visibleColumns,
    setVisibleColumns,
    resetColumns,
    renderedSet,
    visibleSortColumns: STABLECOIN_HEADER_DEFS.filter((column) => renderedSet.has(column.id)),
    isVisible,
    tableMinWidthPx,
    visibleColumnCount: renderedColumns.length + (showPinnedControls ? 1 : 0),
    skeletonColumns,
    isMobileColumns,
    scrollRef,
    viewportRef,
    hiddenByFit,
    fitToWidth,
    setFitToWidth,
    showFitControl: !isMobileColumns && (hiddenByFit.length > 0 || (!fitToWidth && intentOverflows)),
  };
}

export function useStablecoinTableRows({
  data,
  activeFilters,
  eligibleIds,
  reportCards,
  searchQuery,
  sort,
  renderedSet,
  pegRates,
  pegScores,
  dexLiquidity,
  pinnedStablecoinIds,
  isOverview,
  isMobileColumns,
  density,
  densityConfig,
  scrollRef,
}: {
  data: StablecoinData[] | undefined;
  activeFilters: readonly FilterTag[];
  eligibleIds?: ReadonlySet<string>;
  reportCards?: Record<string, ReportCard>;
  searchQuery?: string;
  sort: StablecoinTableSort;
  renderedSet: ReadonlySet<ColumnId>;
  pegRates: Record<string, number>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  pinnedStablecoinIds: readonly string[];
  isOverview: boolean;
  isMobileColumns: boolean;
  density: TableDensity;
  densityConfig: { rowHeight: number; iconSize: number };
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const effectiveSortKey = useMemo(() => resolveEffectiveSortKey(sort.key, renderedSet), [renderedSet, sort.key]);
  const trackedIds = useMemo(
    () => buildTrackedIdSet(activeFilters, reportCards, eligibleIds),
    [activeFilters, eligibleIds, reportCards],
  );
  const filtered = useMemo(() => filterStablecoins(data, trackedIds, searchQuery), [data, searchQuery, trackedIds]);
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
    [dexLiquidity, effectiveSortKey, filtered, pegRates, pegScores, reportCards, sort],
  );
  const displayed = useMemo(
    () => prioritizePinnedStablecoins(sorted, pinnedStablecoinIds),
    [pinnedStablecoinIds, sorted],
  );
  const sortedRankById = useMemo(() => new Map(sorted.map((coin, index) => [coin.id, index + 1] as const)), [sorted]);
  const pinnedStablecoinSet = useMemo(() => new Set(pinnedStablecoinIds), [pinnedStablecoinIds]);
  const [overviewPageIndex, setOverviewPageIndex] = useState(0);
  const overviewPageCount = isOverview ? Math.max(1, Math.ceil(displayed.length / OVERVIEW_PAGE_SIZE)) : 1;

  useEffect(() => {
    setOverviewPageIndex((current) => Math.min(current, overviewPageCount - 1));
  }, [overviewPageCount]);

  const overviewPageStart = isOverview ? overviewPageIndex * OVERVIEW_PAGE_SIZE : 0;
  const overviewPageEnd = isOverview
    ? Math.min(displayed.length, overviewPageStart + OVERVIEW_PAGE_SIZE)
    : displayed.length;
  const displayedRows = useMemo(
    () => (isOverview ? displayed.slice(overviewPageStart, overviewPageEnd) : displayed),
    [displayed, isOverview, overviewPageEnd, overviewPageStart],
  );
  const previousRowsRef = useRef<{ rows: typeof displayed; sort: StablecoinTableSort } | null>(null);

  useEffect(() => {
    const previous = previousRowsRef.current;
    if (previous && (previous.rows !== displayed || previous.sort !== sort)) {
      scrollRef.current?.scrollTo({ top: 0 });
      if (isOverview) setOverviewPageIndex(0);
    }
    previousRowsRef.current = { rows: displayed, sort };
  }, [displayed, isOverview, scrollRef, sort]);

  const virtualDensityConfig = useMemo(
    () => ({
      ...densityConfig,
      rowHeight: isOverview
        ? OVERVIEW_ROW_HEIGHT_ESTIMATE_PX[density]
        : isMobileColumns
          ? Math.max(densityConfig.rowHeight, MOBILE_COLUMNS_MIN_ROW_HEIGHT_PX)
          : Math.max(densityConfig.rowHeight, VIRTUAL_ROW_HEIGHT_ESTIMATE_PX[density]),
      iconSize: isOverview ? OVERVIEW_ICON_SIZE_PX : densityConfig.iconSize,
    }),
    [density, densityConfig, isMobileColumns, isOverview],
  );
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
  }, [dexLiquidity, displayed, pegScores, reportCards]);
  const onPreviousOverviewPage = useCallback(() => {
    setOverviewPageIndex((current) => Math.max(0, current - 1));
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollRef]);
  const onNextOverviewPage = useCallback(() => {
    setOverviewPageIndex((current) => Math.min(overviewPageCount - 1, current + 1));
    scrollRef.current?.scrollTo({ top: 0 });
  }, [overviewPageCount, scrollRef]);

  return {
    displayed,
    displayedRows,
    sortedRankById,
    pinnedStablecoinSet,
    overviewPageIndex,
    overviewPageCount,
    overviewPageStart,
    overviewPageEnd,
    virtualDensityConfig,
    virtualizer,
    virtualItems,
    paddingTop,
    paddingBottom,
    measureVirtualRow,
    handleCsvExport,
    onPreviousOverviewPage,
    onNextOverviewPage,
  };
}
