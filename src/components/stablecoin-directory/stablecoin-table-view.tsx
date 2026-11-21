"use client";

import type { ReactNode, Ref } from "react";
import Link from "next/link";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  TableBody,
  TableCaption,
  TableFrame,
  TableSkeletonRows,
  type TableSkeletonColumn,
} from "@/components/table";
import { TableBackgroundRefreshingBar } from "@/components/data-table-shell";
import { TablePagination } from "@/components/table-pagination";
import { StablecoinOverviewSkeleton } from "@/components/stablecoin-directory/stablecoin-overview-skeleton";
import { StablecoinTableEmptyState } from "@/components/stablecoin-directory/stablecoin-table-empty-state";
import { StablecoinVirtualRow } from "@/components/stablecoin-directory/stablecoin-table-row";
import {
  STABLECOIN_FRAME_SHARED,
  STABLECOIN_TABLE_REFRESH_QUERY_KEYS,
  StablecoinTableHeader,
  type StablecoinTableSortProps,
  type StablecoinTableVisualVariant,
} from "@/components/stablecoin-directory/stablecoin-table-columns";
import type { ColumnId } from "@/hooks/use-preferences";
import type { TableDensity } from "@/hooks/use-table-density";
import type { DexLiquidityTableMap } from "@shared/types/dex-liquidity";
import type { FilterTag } from "@shared/types/stablecoin-meta-primitives";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import type { CoinState } from "@shared/lib/coin-state";

export { StablecoinOverviewSkeleton };

const SKELETON_ROW_COUNT = 10;
const EAGER_LOGO_ROW_LIMIT = 20;

interface StablecoinTableViewProps {
  isLoading: boolean;
  isVirtualized: boolean;
  needsHorizontalScroll: boolean;
  variant: StablecoinTableVisualVariant;
  density: TableDensity;
  tableMinWidthPx: number;
  viewportRef: Ref<HTMLDivElement>;
  surfaceRef: Ref<HTMLDivElement>;
  showPinnedControls: boolean;
  isVisible: (id: ColumnId) => boolean;
  skeletonColumns: readonly TableSkeletonColumn[];
  tableToolbar: ReactNode;
  filterPanel?: ReactNode;
  displayed: readonly StablecoinData[];
  displayedRows: readonly StablecoinData[];
  overviewPageIndex: number;
  overviewPageCount: number;
  overviewPageStart: number;
  overviewPageEnd: number;
  onPreviousOverviewPage: () => void;
  onNextOverviewPage: () => void;
  sort: StablecoinTableSortProps;
  virtualItems: readonly VirtualItem[];
  paddingTop: number;
  paddingBottom: number;
  visibleColumnCount: number;
  sortedRankById: ReadonlyMap<string, number>;
  densityConfig: { rowHeight: number; iconSize: number };
  logos?: Record<string, string>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityTableMap;
  reportCards?: Record<string, V9SafetyTableRow>;
  coinStates?: ReadonlyMap<string, readonly CoinState[]>;
  pinnedStablecoinSet: ReadonlySet<string>;
  onTogglePinnedStablecoin?: (stablecoinId: string) => void;
  activeCursorIndex: number | null;
  activateCursorAtIndex: (index: number) => void;
  onNavigate: (stablecoinId: string) => void;
  onPrefetch: (stablecoinId: string) => void;
  measureVirtualRow?: (element: HTMLTableRowElement | null) => void;
  searchQuery?: string;
  activeFilters: readonly FilterTag[];
  data: StablecoinData[] | undefined;
  unavailable?: boolean;
  onClearFilters?: () => void;
  onClearSearch?: () => void;
}

type StablecoinTableFrameMode = "loading" | "ready";

function StablecoinTableFrame({
  children,
  mode,
  variant,
  isVirtualized,
  needsHorizontalScroll,
  density,
  tableMinWidthPx,
  viewportRef,
  surfaceRef,
  topSlot,
  footerSlot,
}: {
  children: ReactNode;
  mode: StablecoinTableFrameMode;
  variant: StablecoinTableVisualVariant;
  isVirtualized: boolean;
  needsHorizontalScroll: boolean;
  density: TableDensity;
  tableMinWidthPx: number;
  viewportRef: Ref<HTMLDivElement>;
  surfaceRef?: Ref<HTMLDivElement>;
  topSlot?: ReactNode;
  footerSlot?: ReactNode;
}) {
  const isOverview = variant === "figmaOverview";

  return (
    <TableFrame
      {...STABLECOIN_FRAME_SHARED}
      chrome="default"
      viewportDefaults={isVirtualized ? "virtual" : undefined}
      surfaceRef={surfaceRef}
      className={mode === "ready" ? "animate-in fade-in duration-200" : undefined}
      density={density}
      striped="indexed"
      stickyHeader
      stickyMode={isVirtualized ? "viewport" : "page"}
      mobileScrollHint={isOverview ? false : STABLECOIN_FRAME_SHARED.mobileScrollHint}
      viewportRef={viewportRef}
      viewportClassName={isVirtualized ? STABLECOIN_FRAME_SHARED.viewportClassName : undefined}
      viewportProps={
        isVirtualized
          ? undefined
          : {
              horizontal: needsHorizontalScroll,
              scrollShadow: needsHorizontalScroll,
              overscrollX: needsHorizontalScroll,
              compactBottomPadding: false,
            }
      }
      tableProps={{ style: { minWidth: tableMinWidthPx } }}
      topSlot={topSlot}
      footerSlot={footerSlot}
    >
      {children}
    </TableFrame>
  );
}

function LoadingTable({
  variant,
  isVirtualized,
  needsHorizontalScroll,
  density,
  tableMinWidthPx,
  viewportRef,
  showPinnedControls,
  isVisible,
  skeletonColumns,
}: Pick<
  StablecoinTableViewProps,
  | "variant"
  | "isVirtualized"
  | "needsHorizontalScroll"
  | "density"
  | "tableMinWidthPx"
  | "viewportRef"
  | "showPinnedControls"
  | "isVisible"
  | "skeletonColumns"
>) {
  if (variant === "figmaOverview") {
    return (
      <StablecoinOverviewSkeleton
        showToolbar
        density={density}
        tableMinWidthPx={tableMinWidthPx}
        columns={skeletonColumns}
        header={
          <StablecoinTableHeader
            showPinnedControls={showPinnedControls}
            isVisible={isVisible}
            variant={variant}
            sticky
          />
        }
      />
    );
  }

  return (
    <StablecoinTableFrame
      mode="loading"
      variant={variant}
      isVirtualized={isVirtualized}
      needsHorizontalScroll={needsHorizontalScroll}
      density={density}
      tableMinWidthPx={tableMinWidthPx}
      viewportRef={viewportRef}
    >
      <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
      <StablecoinTableHeader showPinnedControls={showPinnedControls} isVisible={isVisible} variant={variant} />
      <TableBody>
        <TableSkeletonRows columns={[...skeletonColumns]} rowCount={SKELETON_ROW_COUNT} />
      </TableBody>
    </StablecoinTableFrame>
  );
}

function DefaultFooter({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="text-sm text-muted-foreground">
        Showing <span className="font-mono tabular-nums text-foreground">{count.toLocaleString("en-US")}</span>{" "}
        active stablecoins — all inactive lifecycle states excluded,{" "}
        <Link
          href="/screener/"
          className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
        >
          see Screener
        </Link>
      </span>
      <span className="pharos-meta sm:text-right">
        Rows open the detail dossier. MCap columns compare dated USD market caps. The 24h and 7d columns use published USD balances when dated caps are unavailable.
      </span>
    </div>
  );
}

function StablecoinRows(props: StablecoinTableViewProps) {
  const renderRow = (coin: StablecoinData, index: number) => {
    const rowIndex = props.variant === "figmaOverview"
      ? props.overviewPageStart + index
      : index;
    return (
      <StablecoinVirtualRow
        key={coin.id}
        coin={coin}
        rank={props.sortedRankById.get(coin.id) ?? rowIndex + 1}
        virtualIndex={index}
        isStriped={rowIndex % 2 === 1}
        densityConfig={props.densityConfig}
        density={props.density}
        variant={props.variant}
        isVisible={props.isVisible}
        logos={props.logos}
        pegScores={props.pegScores}
        dexLiquidity={props.dexLiquidity}
        reportCards={props.reportCards}
        coinState={props.coinStates?.get(coin.id)?.[0] ?? null}
        showPinnedControl={props.showPinnedControls}
        isPinned={props.pinnedStablecoinSet.has(coin.id)}
        onTogglePinned={props.onTogglePinnedStablecoin}
        isCursor={index === props.activeCursorIndex}
        onCursorMouseEnter={props.activateCursorAtIndex}
        onNavigate={props.onNavigate}
        onPrefetch={props.onPrefetch}
        measureElement={props.measureVirtualRow}
        eagerLogo={!props.isVirtualized || index < EAGER_LOGO_ROW_LIMIT}
      />
    );
  };

  return (
    <TableBody>
      {props.isVirtualized ? (
        <>
          {props.paddingTop > 0 ? (
            <tr>
              <td colSpan={props.visibleColumnCount} style={{ height: props.paddingTop, padding: 0 }} />
            </tr>
          ) : null}
          {props.virtualItems.map((virtualRow) => {
            const coin = props.displayedRows[virtualRow.index];
            return coin ? renderRow(coin, virtualRow.index) : null;
          })}
          {props.paddingBottom > 0 ? (
            <tr>
              <td colSpan={props.visibleColumnCount} style={{ height: props.paddingBottom, padding: 0 }} />
            </tr>
          ) : null}
        </>
      ) : (
        props.displayedRows.map((coin, index) => renderRow(coin, index))
      )}
      {props.displayed.length === 0 ? (
        <StablecoinTableEmptyState
          searchQuery={props.searchQuery}
          activeFilters={props.activeFilters}
          data={props.data}
          unavailable={props.unavailable}
          logos={props.logos}
          onClearFilters={props.onClearFilters}
          onClearSearch={props.onClearSearch}
        />
      ) : null}
    </TableBody>
  );
}

export function StablecoinTableView(props: StablecoinTableViewProps) {
  if (props.isLoading) return <LoadingTable {...props} />;

  const isOverview = props.variant === "figmaOverview";
  const footer = isOverview ? (
    props.displayed.length > 0 ? (
      <TablePagination
        page={props.overviewPageIndex}
        totalPages={props.overviewPageCount}
        rangeStart={props.overviewPageStart + 1}
        rangeEnd={props.overviewPageEnd}
        total={props.displayed.length}
        noun="stablecoins"
        onPrevious={props.onPreviousOverviewPage}
        onNext={props.onNextOverviewPage}
      />
    ) : null
  ) : (
    <DefaultFooter count={props.displayed.length} />
  );
  const tableFrame = (
    <StablecoinTableFrame
      mode="ready"
      variant={props.variant}
      isVirtualized={props.isVirtualized}
      needsHorizontalScroll={props.needsHorizontalScroll}
      density={props.density}
      tableMinWidthPx={props.tableMinWidthPx}
      viewportRef={props.viewportRef}
      surfaceRef={props.surfaceRef}
      topSlot={
        <>
          <TableBackgroundRefreshingBar queryKeys={STABLECOIN_TABLE_REFRESH_QUERY_KEYS} isPending={props.isLoading} />
          {isOverview ? null : props.tableToolbar}
          {props.filterPanel}
        </>
      }
      footerSlot={footer}
    >
      <TableCaption className="sr-only">Stablecoin data table</TableCaption>
      <StablecoinTableHeader
        showPinnedControls={props.showPinnedControls}
        isVisible={props.isVisible}
        sort={props.sort}
        rows={props.displayed}
        sticky
        variant={props.variant}
      />
      <StablecoinRows {...props} />
    </StablecoinTableFrame>
  );

  return isOverview ? <div className="space-y-3">{props.tableToolbar}{tableFrame}</div> : tableFrame;
}
