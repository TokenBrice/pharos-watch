"use client";

import type { ReactNode, Ref } from "react";
import Link from "next/link";
import type { VirtualItem } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  TableBody,
  TableCaption,
  TableSkeletonRows,
  VirtualTableFrame,
  type TableSkeletonColumn,
} from "@/components/table";
import { TableBackgroundRefreshingBar } from "@/components/data-table-shell";
import { StablecoinTableEmptyState } from "@/components/stablecoin-table-empty-state";
import type { StablecoinTableSortKey } from "@/components/stablecoin-table-logic";
import { StablecoinVirtualRow } from "@/components/stablecoin-table-row";
import {
  STABLECOIN_FRAME_SHARED,
  STABLECOIN_TABLE_REFRESH_QUERY_KEYS,
  StablecoinTableHeader,
  type StablecoinTableVisualVariant,
} from "@/components/stablecoin-table-columns";
import type { ColumnId } from "@/hooks/use-preferences";
import type { TableDensity } from "@/hooks/use-table-density";
import type { DexLiquidityMap, FilterTag, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";

const SKELETON_ROW_COUNT = 10;

interface StablecoinTableSortProps {
  sortKey: StablecoinTableSortKey;
  sortDirection: "asc" | "desc";
  toggleSort: (key: StablecoinTableSortKey) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  showHeaderMethodologyHints: boolean;
}

interface StablecoinTableViewProps {
  isLoading: boolean;
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
  pegRates: Record<string, number>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  pinnedStablecoinSet: ReadonlySet<string>;
  onTogglePinnedStablecoin?: (stablecoinId: string) => void;
  activeCursorIndex: number | null;
  activateCursorAtIndex: (index: number) => void;
  onNavigate: (stablecoinId: string) => void;
  onPrefetch: (stablecoinId: string) => void;
  measureVirtualRow: (element: HTMLTableRowElement | null) => void;
  searchQuery?: string;
  activeFilters: readonly FilterTag[];
  data: StablecoinData[] | undefined;
  onClearFilters?: () => void;
  onClearSearch?: () => void;
}

function LoadingTable({
  variant,
  density,
  tableMinWidthPx,
  viewportRef,
  showPinnedControls,
  isVisible,
  skeletonColumns,
}: Pick<
  StablecoinTableViewProps,
  | "variant"
  | "density"
  | "tableMinWidthPx"
  | "viewportRef"
  | "showPinnedControls"
  | "isVisible"
  | "skeletonColumns"
>) {
  const isOverview = variant === "figmaOverview";
  return (
    <VirtualTableFrame
      {...STABLECOIN_FRAME_SHARED}
      className={isOverview ? "pharos-overview-table-shell" : undefined}
      density={density}
      striped="indexed"
      mobileScrollHint={isOverview ? false : STABLECOIN_FRAME_SHARED.mobileScrollHint}
      viewportRef={viewportRef}
      viewportClassName={isOverview ? "pharos-overview-table-viewport" : STABLECOIN_FRAME_SHARED.viewportClassName}
      tableProps={{ style: { minWidth: tableMinWidthPx } }}
    >
      <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
      <StablecoinTableHeader showPinnedControls={showPinnedControls} isVisible={isVisible} variant={variant} />
      <TableBody>
        <TableSkeletonRows columns={[...skeletonColumns]} rowCount={SKELETON_ROW_COUNT} />
      </TableBody>
    </VirtualTableFrame>
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
        Rows open the detail dossier. Green and red deltas reflect supply expansion and contraction, not price return.
      </span>
    </div>
  );
}

function OverviewFooter({
  count,
  pageIndex,
  pageCount,
  pageStart,
  pageEnd,
  onPrevious,
  onNext,
}: {
  count: number;
  pageIndex: number;
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="pharos-overview-table-footer">
      <span>
        Showing <span className="tabular-nums">{pageStart + 1}-{pageEnd}</span> of{" "}
        <span className="tabular-nums">{count.toLocaleString("en-US")}</span>
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="pharos-overview-pagination-button"
          disabled={pageIndex === 0}
          onClick={onPrevious}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Previous
        </button>
        <button
          type="button"
          className="pharos-overview-pagination-button"
          disabled={pageIndex >= pageCount - 1}
          onClick={onNext}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function StablecoinRows(props: StablecoinTableViewProps) {
  return (
    <TableBody>
      {props.paddingTop > 0 ? (
        <tr>
          <td colSpan={props.visibleColumnCount} style={{ height: props.paddingTop, padding: 0 }} />
        </tr>
      ) : null}
      {props.virtualItems.map((virtualRow) => {
        const coin = props.displayedRows[virtualRow.index];
        if (!coin) return null;
        const rowIndex = props.variant === "figmaOverview"
          ? props.overviewPageStart + virtualRow.index
          : virtualRow.index;
        return (
          <StablecoinVirtualRow
            key={coin.id}
            coin={coin}
            rank={props.sortedRankById.get(coin.id) ?? rowIndex + 1}
            virtualIndex={virtualRow.index}
            isStriped={rowIndex % 2 === 1}
            densityConfig={props.densityConfig}
            density={props.density}
            variant={props.variant}
            isVisible={props.isVisible}
            logos={props.logos}
            pegRates={props.pegRates}
            pegScores={props.pegScores}
            dexLiquidity={props.dexLiquidity}
            reportCards={props.reportCards}
            showPinnedControl={props.showPinnedControls}
            isPinned={props.pinnedStablecoinSet.has(coin.id)}
            onTogglePinned={props.onTogglePinnedStablecoin}
            isCursor={virtualRow.index === props.activeCursorIndex}
            onCursorMouseEnter={props.activateCursorAtIndex}
            onNavigate={props.onNavigate}
            onPrefetch={props.onPrefetch}
            measureElement={props.measureVirtualRow}
          />
        );
      })}
      {props.paddingBottom > 0 ? (
        <tr>
          <td colSpan={props.visibleColumnCount} style={{ height: props.paddingBottom, padding: 0 }} />
        </tr>
      ) : null}
      {props.displayed.length === 0 ? (
        <StablecoinTableEmptyState
          searchQuery={props.searchQuery}
          activeFilters={props.activeFilters}
          data={props.data}
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
    <OverviewFooter
      count={props.displayed.length}
      pageIndex={props.overviewPageIndex}
      pageCount={props.overviewPageCount}
      pageStart={props.overviewPageStart}
      pageEnd={props.overviewPageEnd}
      onPrevious={props.onPreviousOverviewPage}
      onNext={props.onNextOverviewPage}
    />
  ) : (
    <DefaultFooter count={props.displayed.length} />
  );
  const tableFrame = (
    <VirtualTableFrame
      {...STABLECOIN_FRAME_SHARED}
      surfaceRef={props.surfaceRef}
      className={isOverview ? "pharos-overview-table-shell animate-in fade-in duration-200" : "animate-in fade-in duration-200"}
      density={props.density}
      viewportRef={props.viewportRef}
      mobileScrollHint={isOverview ? false : STABLECOIN_FRAME_SHARED.mobileScrollHint}
      viewportClassName={isOverview ? "pharos-overview-table-viewport" : STABLECOIN_FRAME_SHARED.viewportClassName}
      tableProps={{ style: { minWidth: props.tableMinWidthPx } }}
      topSlot={
        <>
          {isOverview ? null : (
            <TableBackgroundRefreshingBar queryKeys={STABLECOIN_TABLE_REFRESH_QUERY_KEYS} isPending={props.isLoading} />
          )}
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
        sticky
        variant={props.variant}
      />
      <StablecoinRows {...props} />
    </VirtualTableFrame>
  );

  return isOverview ? <div className="space-y-3">{props.tableToolbar}{tableFrame}</div> : tableFrame;
}
