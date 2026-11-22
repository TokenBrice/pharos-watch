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
} from "@/components/stablecoin-directory/stablecoin-table-columns";
import {
  buildTrackedIdSet,
  exportStablecoinsCsv,
  filterStablecoins,
  prioritizePinnedStablecoins,
  resolveEffectiveSortKey,
  sortStablecoins,
  type StablecoinTableSortKey,
  type StablecoinTableSourceGenerations,
} from "@/components/stablecoin-directory/stablecoin-table-logic";
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
import type { DexLiquidityTableMap } from "@shared/types/dex-liquidity";
import type { FilterTag } from "@shared/types/stablecoin-meta-primitives";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";

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
    if (isMobileColumns) return [...MOBILE_DEFAULT_COLUMNS];
    if (initialVisibleColumns?.length) return [...initialVisibleColumns];
    return [...DEFAULT_VISIBLE_COLUMNS];
  }, [initialVisibleColumns, isMobileColumns]);
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
  const needsHorizontalScroll = isMobileColumns || (!fitToWidth && intentOverflows);

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
    needsHorizontalScroll,
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
  reportCardsMethodologyVersion,
  searchQuery,
  sort,
  renderedSet,
  pegScores,
  dexLiquidity,
  pinnedStablecoinIds,
  sourceGenerations,
  isOverview,
  isMobileColumns,
  density,
  densityConfig,
  scrollRef,
  surfaceRef,
}: {
  data: StablecoinData[] | undefined;
  activeFilters: readonly FilterTag[];
  eligibleIds?: ReadonlySet<string>;
  reportCards?: Record<string, V9SafetyTableRow>;
  reportCardsMethodologyVersion?: string | null;
  searchQuery?: string;
  sort: StablecoinTableSort;
  renderedSet: ReadonlySet<ColumnId>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityTableMap;
  sourceGenerations?: StablecoinTableSourceGenerations;
  pinnedStablecoinIds: readonly string[];
  isOverview: boolean;
  isMobileColumns: boolean;
  density: TableDensity;
  densityConfig: { rowHeight: number; iconSize: number };
  scrollRef: RefObject<HTMLDivElement | null>;
  surfaceRef?: RefObject<HTMLDivElement | null>;
}) {
  const isVirtualized = !isOverview;
  const effectiveSortKey = useMemo(
    () => resolveEffectiveSortKey(sort.key, renderedSet, isMobileColumns),
    [isMobileColumns, renderedSet, sort.key],
  );
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
        pegScores,
        dexLiquidity,
        reportCards,
      }),
    [dexLiquidity, effectiveSortKey, filtered, pegScores, reportCards, sort],
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
  // Navigation belongs to the reader's controls, not refreshed dataset identity.
  // Serialize control values so equivalent newly allocated props do not reset it.
  const eligibilityKey = useMemo(
    () => eligibleIds ? JSON.stringify([...eligibleIds].sort()) : null,
    [eligibleIds],
  );
  const navigationKey = JSON.stringify([
    [...activeFilters].sort(),
    eligibilityKey,
    searchQuery ?? "",
    sort.key,
    sort.direction,
    effectiveSortKey,
    pinnedStablecoinIds,
  ]);
  const previousNavigationKeyRef = useRef(navigationKey);

  useEffect(() => {
    if (previousNavigationKeyRef.current !== navigationKey) {
      if (isVirtualized) {
        scrollRef.current?.scrollTo({ top: 0 });
      }
      if (isOverview) setOverviewPageIndex(0);
    }
    previousNavigationKeyRef.current = navigationKey;
  }, [navigationKey, isOverview, isVirtualized, scrollRef]);

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
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentional for unpaginated directory tables.
  const rawVirtualizer = useVirtualizer({
    count: isVirtualized ? displayedRows.length : 0,
    getScrollElement: () => (isVirtualized ? scrollRef.current : null),
    estimateSize: () => virtualDensityConfig.rowHeight,
    measureElement: (element) => element?.getBoundingClientRect().height ?? virtualDensityConfig.rowHeight,
    overscan: isVirtualized ? OVERSCAN : 0,
  });
  const virtualizer = isVirtualized ? rawVirtualizer : null;
  const virtualItems = virtualizer ? virtualizer.getVirtualItems() : [];
  const totalHeight = virtualizer ? virtualizer.getTotalSize() : 0;
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0;
  const measureVirtualRow = useCallback(
    (element: HTMLTableRowElement | null) => {
      if (!virtualizer || !element || typeof virtualizer.measureElement !== "function") return;
      virtualizer.measureElement(element);
    },
    [virtualizer],
  );
  const handleCsvExport = useCallback(() => {
    exportStablecoinsCsv(
      displayed,
      sortedRankById,
      pegScores,
      dexLiquidity,
      reportCards,
      sourceGenerations,
      reportCardsMethodologyVersion,
    );
  }, [dexLiquidity, displayed, pegScores, reportCards, reportCardsMethodologyVersion, sortedRankById, sourceGenerations]);
  const scrollOverviewTopIntoView = useCallback(() => {
    const top = surfaceRef?.current?.getBoundingClientRect().top;
    if (top != null && top < 0 && typeof surfaceRef?.current?.scrollIntoView === "function") {
      surfaceRef.current.scrollIntoView({ block: "start" });
    }
  }, [surfaceRef]);
  const onPreviousOverviewPage = useCallback(() => {
    setOverviewPageIndex((current) => Math.max(0, current - 1));
    scrollOverviewTopIntoView();
  }, [scrollOverviewTopIntoView]);
  const onNextOverviewPage = useCallback(() => {
    setOverviewPageIndex((current) => Math.min(overviewPageCount - 1, current + 1));
    scrollOverviewTopIntoView();
  }, [overviewPageCount, scrollOverviewTopIntoView]);

  return {
    isVirtualized,
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
    measureVirtualRow: isVirtualized ? measureVirtualRow : undefined,
    handleCsvExport,
    onPreviousOverviewPage,
    onNextOverviewPage,
  };
}
