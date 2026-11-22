"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, GitCompareArrows, Wallet, X } from "lucide-react";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
  type DataTableSortControls,
} from "@/components/data-table-shell";
import { MobileMetricPill, MobileSortPanel, MobileSortPills } from "@/components/mobile-sort-pills";
import { TableCell, TableRow } from "@/components/table";
import { TablePagination, type TablePaginationProps } from "@/components/table-pagination";
import { useTablePagination } from "@/hooks/use-table-pagination";
import { useRowCursor, type UseRowCursorResult } from "@/hooks/use-row-cursor";
import { useSortColumnEvent } from "@/hooks/use-sort-column-event";
import { useWatchlist } from "@/hooks/use-watchlist";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { buildPortfolioCoinsHref } from "@/lib/portfolio-codec";
import { copyText } from "@/lib/clipboard";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { PEG_SCORE_HEADER_TITLE } from "@/lib/definitions";
import { EmptyStateIllustration } from "@/components/empty-state-illustration";
import { CoinStateChip } from "@/components/coin-state-chip";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StablecoinIdentityTransition } from "@/components/view-transitions";
import { RowSparkline } from "@/components/row-sparkline";
import { SafetyScoreTopDriver, type SafetyScoreTopDriverProps } from "@/components/safety-scores/safety-score-top-driver";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCompactUsd } from "@shared/lib/format";
import {
  MINT_AUTHORITY_STATUS_CONFIG,
  PEG_METADATA,
  getMechanismArchetypeLabel,
  SAFETY_EVIDENCE_BADGE_CLASSES,
  SAFETY_EVIDENCE_LABELS,
  THREAT_BAND_LABELS,
  THREAT_BAND_STYLES,
  type ThreatBand,
} from "@shared/lib/classification";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import type { ScreenerRow, ScreenerSortKey } from "@/lib/screener-filters";
import type { QueryKey } from "@tanstack/react-query";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

// M1: keys feeding the screener table's visible data (supply, peg, DEWS,
// liquidity, safety grade). A background refetch of any of these surfaces the
// RefreshingBar while the prior rows stay visible (keepPreviousData).
export const SCREENER_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.queryKey,
  FRONTEND_API_QUERY_DESCRIPTORS.pegSummary.queryKey,
  FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.queryKey,
  FRONTEND_API_QUERY_DESCRIPTORS.stressSignals.queryKey,
  FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityTable.queryKey,
];

function getRowPegDeviationSeries(row: ScreenerRow): ReadonlyArray<number | null> {
  return row.pegDeviationSeries ?? [];
}

function getRowSupplySeries(row: ScreenerRow): ReadonlyArray<number | null> {
  return row.supplySeries ?? [];
}

const DATA_COLUMNS: readonly DataTableColumn<ScreenerSortKey>[] = [
  { id: "name", label: "Name", sortKey: "name", className: "min-w-[160px]" },
  { id: "supply", label: "Supply", sortKey: "supply", className: "text-right whitespace-nowrap" },
  {
    id: "pegScore",
    label: "Peg Score",
    sortKey: "pegScore",
    className: "text-right whitespace-nowrap",
    title: PEG_SCORE_HEADER_TITLE,
  },
  {
    id: "dewsScore",
    label: "DEWS",
    sortKey: "dewsScore",
    className: "text-right whitespace-nowrap",
    title: "Depeg Early Warning System stress band and score (0-100)",
  },
  {
    id: "liquidityScore",
    label: "Liquidity",
    sortKey: "liquidityScore",
    className: "text-right whitespace-nowrap",
    title: "DEX Liquidity Score (0-100): pool depth, volume, and diversity",
  },
  {
    id: "safetyScore",
    label: "Grade",
    sortKey: "safetyScore",
    className: "text-center whitespace-nowrap",
    title: `Pharos Safety Grade (${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL})`,
  },
  {
    id: "safetyProfile",
    label: "Safety Profile",
    className: "w-[15rem] max-w-[15rem] text-center",
    title: "Safety Score pillars: Backing / Exit / Economic Control. The weakest published pillar is highlighted.",
  },
  { id: "mechanism", label: "Mechanism", className: "text-left" },
  { id: "peg", label: "Peg", className: "text-left whitespace-nowrap" },
  {
    id: "peg30d",
    label: "Peg range",
    className: "text-right w-[112px] hidden xl:table-cell whitespace-nowrap",
    title: "Peg range: worst / current deviation (±bps around the peg)",
  },
  {
    id: "supply30d",
    label: "30d Supply",
    className: "text-right w-[112px] hidden xl:table-cell whitespace-nowrap",
    title: "30-day supply trajectory",
  },
] as const;

const MOBILE_SORT_OPTIONS: Array<{ key: ScreenerSortKey; label: string }> = [
  { key: "safetyScore", label: "Grade" },
  { key: "supply", label: "Supply" },
  { key: "pegScore", label: "Peg" },
  { key: "dewsScore", label: "DEWS" },
  { key: "liquidityScore", label: "Liquidity" },
];

interface ScreenerTableProps {
  rows: readonly ScreenerRow[];
  logos?: Record<string, string>;
  dataState: NonNullable<TablePaginationProps["dataState"]>;
  onClearFilters?: () => void;
  hasActiveFilters: boolean;
  sort: DataTableSortControls<ScreenerSortKey>;
  selectedIds?: readonly string[];
  onToggleSelect?: (coinId: string) => void;
  onToggleSelectPage?: (pageIds: readonly string[], checked: boolean) => void;
  onClearSelection?: () => void;
}

export function ScreenerTable({
  rows,
  logos,
  dataState,
  onClearFilters,
  hasActiveFilters,
  sort,
  selectedIds: controlledSelectedIds,
  onToggleSelect: controlledToggleSelect,
  onToggleSelectPage: controlledToggleSelectPage,
  onClearSelection: controlledClearSelection,
}: ScreenerTableProps) {
  const isLoading = dataState === "loading";
  const watchlist = useWatchlist();
  const tableRef = useRef<HTMLDivElement>(null);
  const compareLinkRef = useRef<HTMLAnchorElement>(null);
  const [uncontrolledSelectedIds, setUncontrolledSelectedIds] = useState<string[]>([]);

  const selectedIds = controlledSelectedIds ?? uncontrolledSelectedIds;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const handleToggleSelect = useCallback(
    (coinId: string) => {
      if (controlledToggleSelect) {
        controlledToggleSelect(coinId);
        return;
      }
      setUncontrolledSelectedIds((prev) =>
        prev.includes(coinId) ? prev.filter((id) => id !== coinId) : [...prev, coinId],
      );
    },
    [controlledToggleSelect],
  );

  const handleToggleSelectPage = useCallback(
    (pageIds: readonly string[], checked: boolean) => {
      if (controlledToggleSelectPage) {
        controlledToggleSelectPage(pageIds, checked);
        return;
      }
      setUncontrolledSelectedIds((prev) => {
        if (checked) {
          const merged = new Set(prev);
          for (const id of pageIds) merged.add(id);
          return Array.from(merged);
        }
        const pageSet = new Set(pageIds);
        return prev.filter((id) => !pageSet.has(id));
      });
    },
    [controlledToggleSelectPage],
  );

  const handleClearSelection = useCallback(() => {
    if (controlledClearSelection) {
      controlledClearSelection();
      return;
    }
    setUncontrolledSelectedIds([]);
  }, [controlledClearSelection]);

  const pagination = useTablePagination(rows, { pageSize: 50, resetPageOnTotalChange: true });
  const pageRows = pagination.paginatedRows;
  const pageRowIds = useMemo(() => pageRows.map((row) => row.id), [pageRows]);
  const allPageSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => selectedSet.has(id));
  const somePageSelected =
    !allPageSelected && pageRowIds.some((id) => selectedSet.has(id));

  const columns = useMemo<readonly DataTableColumn<ScreenerSortKey>[]>(
    () => [
      {
        id: "select",
        label: (
          <label className="inline-flex size-8 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={allPageSelected}
              ref={(node) => {
                if (node) node.indeterminate = somePageSelected;
              }}
              disabled={pageRowIds.length === 0 || dataState !== "ready"}
              onChange={(event) => handleToggleSelectPage(pageRowIds, event.target.checked)}
              aria-label="Select all visible stablecoins on this page"
              className="pharos-focus-ring h-4 w-4 rounded-sm border-border accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            />
          </label>
        ),
        className: "w-11 text-center",
        title: "Select rows for Compare, Portfolio, or link sharing",
      },
      ...DATA_COLUMNS,
    ],
    [allPageSelected, somePageSelected, pageRowIds, dataState, handleToggleSelectPage],
  );

  const paginationProps = {
    page: pagination.effectivePage,
    totalPages: pagination.totalPages,
    rangeStart: pagination.rangeStart,
    rangeEnd: pagination.rangeEnd,
    total: pagination.totalRows,
    dataState,
    onPrevious: pagination.onPreviousPage,
    onNext: pagination.onNextPage,
  };

  // P6: j/k row cursor over desktop table rows. o/Enter opens the dossier,
  // s toggles the watchlist, c adds to /compare. Interactive controls retain
  // their native keyboard behavior.
  const { getRowProps, cursorId } = useRowCursor<ScreenerRow>({
    rows: pageRows,
    getRowId: (row) => row.id,
    onOpen: (row) => {
      tableRef.current
        ?.querySelector<HTMLAnchorElement>(`[data-screener-open="${row.id}"]`)
        ?.click();
    },
    onToggleStar: (row) => watchlist.toggle(row.id),
    onAddToCompare: () => compareLinkRef.current?.click(),
    scopeRef: tableRef,
    enabled: dataState === "ready",
  });
  const compareHref = cursorId ? buildLiveCompareUrl([cursorId]) : null;

  // P8: numeric column sort (keys 1-9 map onto the data columns).
  const toggleSort = sort.toggleSort;
  useSortColumnEvent(DATA_COLUMNS, toggleSort);

  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row] as const)), [rows]);

  return (
    <div ref={tableRef} className="@container">
      {/* Hidden target for the cursor's `c` (add-to-compare) shortcut */}
      {compareHref ? (
        <Link
          ref={compareLinkRef}
          href={compareHref}
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
        >
          Compare cursor row
        </Link>
      ) : null}

      {/* Mobile card list (CSS @container switching: zero hydration bounce) */}
      <div className="space-y-3 @3xl:hidden" data-testid="stablecoin-screener-mobile">
        <MobileSortPanel kicker="Sort results">
          <MobileSortPills
            options={MOBILE_SORT_OPTIONS}
            sortKey={sort.sortKey}
            sortDirection={sort.sortDirection}
            onSort={sort.toggleSort}
            ariaLabel="Sort screener results"
          />
        </MobileSortPanel>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="pharos-card-shell h-28 animate-pulse rounded-xl bg-muted/20" />
            ))}
          </div>
        ) : dataState === "unavailable" ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Screener inputs unavailable. Retry using the data notice above.
          </p>
        ) : rows.length === 0 ? (
          <ScreenerEmptyState hasActiveFilters={hasActiveFilters} onClearFilters={onClearFilters} />
        ) : (
          <div className="space-y-3">
            {pageRows.map((row) => (
              <ScreenerMobileCard
                key={row.id}
                row={row}
                logo={logos?.[row.id]}
                selected={selectedSet.has(row.id)}
                onToggleSelect={handleToggleSelect}
              />
            ))}
          </div>
        )}
        <TablePagination {...paginationProps} />
      </div>

      {/* Desktop DataTableShell with page-level sticky header */}
      <div className="hidden @3xl:block">
        <DataTableShell<ScreenerSortKey>
          tableId="stablecoin-screener"
          testId="stablecoin-screener-table"
          columns={columns}
          sort={sort}
          stickyHeader
          stickyMode="page"
          striped
          mobileScrollHint={false}
          refreshingQueryKeys={SCREENER_REFRESH_QUERY_KEYS}
          isPending={isLoading}
          pagination={paginationProps}
        >
          {isLoading ? (
            <DataTableLoadingRows columns={columns} rowCount={8} />
          ) : dataState === "unavailable" ? (
            <DataTableEmptyRow colSpan={columns.length}>
              Screener inputs unavailable. Retry using the data notice above.
            </DataTableEmptyRow>
          ) : rows.length === 0 ? (
            <DataTableEmptyRow colSpan={columns.length}>
              <ScreenerEmptyState hasActiveFilters={hasActiveFilters} onClearFilters={onClearFilters} compact />
            </DataTableEmptyRow>
          ) : (
            pageRows.map((row, index) => (
              <ScreenerTableRow
                key={row.id}
                row={row}
                logo={logos?.[row.id]}
                rowProps={getRowProps(index, row.id)}
                selected={selectedSet.has(row.id)}
                onToggleSelect={handleToggleSelect}
              />
            ))
          )}
        </DataTableShell>
      </div>

      {/* Sticky batch selection tray */}
      <ScreenerBatchTray
        selectedIds={selectedIds}
        rowsById={rowsById}
        logos={logos}
        onClear={handleClearSelection}
      />
    </div>
  );
}

function ScreenerBatchTray({
  selectedIds,
  rowsById,
  logos,
  onClear,
}: {
  selectedIds: readonly string[];
  rowsById: ReadonlyMap<string, ScreenerRow>;
  logos?: Record<string, string>;
  onClear: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (selectedIds.length === 0) return null;

  const compareIds = selectedIds.slice(0, MAX_COMPARE_COINS);
  const compareHref = buildLiveCompareUrl(compareIds);
  const portfolioHref = buildPortfolioCoinsHref(selectedIds);
  const shareableIds = selectedIds.slice(0, 8);

  const handleCopyLink = async () => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/screener/?coins=${shareableIds.map(encodeURIComponent).join(",")}`;
    const result = await copyText(url);
    if (result.ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      role="region"
      aria-label="Batch selection actions"
      data-testid="screener-batch-tray"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--mobile-utility-safe-offset,4.5rem)+0.75rem)] z-chrome flex justify-center px-3 print:hidden sm:px-4 lg:bottom-4"
    >
      <div className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur sm:w-auto sm:gap-2.5 sm:rounded-full sm:px-4">
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5" aria-hidden="true">
            {selectedIds.slice(0, 4).map((id) => {
              const row = rowsById.get(id);
              return <StablecoinLogo key={id} src={logos?.[id]} name={row?.name ?? id} size={20} />;
            })}
          </div>
          <span className="pharos-numeric text-xs font-semibold text-foreground">
            {selectedIds.length} selected
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5 sm:ml-1">
          <Link
            href={compareHref}
            title={
              selectedIds.length > MAX_COMPARE_COINS
                ? `Compares the first ${MAX_COMPARE_COINS} selected stablecoins`
                : undefined
            }
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 sm:min-h-8 sm:py-1"
          >
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Compare ({compareIds.length})</span>
          </Link>

          <Link
            href={portfolioHref}
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium sm:min-h-8 sm:py-1"
          >
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Model in Portfolio</span>
          </Link>

          <button
            type="button"
            onClick={() => {
              void handleCopyLink();
            }}
            className="pharos-focus-ring pharos-control-pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs font-medium sm:min-h-8 sm:py-1"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{copied ? "Copied" : "Copy link"}</span>
          </button>

          <button
            type="button"
            onClick={onClear}
            aria-label="Clear batch selection"
            className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:min-h-8 sm:min-w-8"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Selection link copied to clipboard." : ""}
        </span>
      </div>
    </div>
  );
}

function ScoreValue({ value }: { value: number | null }) {
  return value != null ? (
    <span className="pharos-numeric text-foreground">{value.toFixed(0)}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** DEWS as its band word beside the score, never a bare number. */
function DewsReading({ score, band }: { score: number | null; band?: ThreatBand | null }) {
  if (score == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      {band ? <span className={`text-xs font-medium ${THREAT_BAND_STYLES[band].textCls}`}>{THREAT_BAND_LABELS[band]}</span> : null}
      <span className="pharos-numeric text-foreground">{score.toFixed(0)}</span>
    </span>
  );
}

function ScreenerEmptyState({
  hasActiveFilters,
  onClearFilters,
  compact = false,
}: {
  hasActiveFilters: boolean;
  onClearFilters?: () => void;
  compact?: boolean;
}) {
  if (!hasActiveFilters) {
    return (
      <div className={compact ? "space-y-2" : "rounded-xl border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground"}>
        <p>No stablecoins available in this dataset.</p>
      </div>
    );
  }

  return (
    <EmptyStateIllustration
      kind="no-matches"
      title="No stablecoins match these filters."
      className={compact ? "py-6" : "rounded-xl border border-dashed border-border/70 bg-background/35 px-4"}
      action={
        onClearFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm text-foreground hover:text-foreground/80 md:min-h-9"
          >
            Reset filters and try again.
          </button>
        ) : undefined
      }
    />
  );
}

function ScreenerMobileCard({
  row,
  logo,
  selected,
  onToggleSelect,
}: {
  row: ScreenerRow;
  logo?: string;
  selected: boolean;
  onToggleSelect: (coinId: string) => void;
}) {
  const topDriver = projectScreenerTopDriver(row);
  return (
    <article className="pharos-card-shell rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <label className="-ml-2 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(row.id)}
              aria-label={`Select ${row.name} (${row.symbol})`}
              className="pharos-focus-ring h-4 w-4 rounded-sm border-border accent-foreground"
            />
          </label>
          <Link
            href={buildStablecoinUrl(row.id)}
            className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-md"
          >
            <StablecoinIdentity
              layout="contents"
              logoSrc={logo}
              name={row.name}
              symbol={row.symbol}
              logoSize={30}
              symbolClassName="block font-semibold text-foreground"
              nameClassName="block truncate text-xs text-muted-foreground"
            />
          </Link>
        </div>
        <div className="shrink-0 text-right">
          <p className="pharos-label">Supply</p>
          <p className="pharos-numeric text-sm font-semibold text-foreground">
            {row.supplyUsd != null ? formatCompactUsd(row.supplyUsd) : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {row.states?.[0] ? <CoinStateChip state={row.states[0]} showDetail /> : null}
        {row.safetyGrade !== null || row.ratingStatus === "pipeline-gap" ? (
          <SafetyGradeBadge
            grade={row.safetyGrade}
            score={row.safetyScore}
            size="sm"
            className="whitespace-nowrap"
          />
        ) : (
          <span className="whitespace-nowrap rounded-full border border-border/60 px-2 py-1">Grade —</span>
        )}
        <MobileMetricPill>Peg <ScoreValue value={row.pegScore} /></MobileMetricPill>
        <MobileMetricPill>DEWS <DewsReading score={row.dewsScore} band={row.dewsBand} /></MobileMetricPill>
        <MobileMetricPill>Liq <ScoreValue value={row.liquidityScore} /></MobileMetricPill>
        <SafetyProfile row={row} compact />
        <SafetyScoreTopDriver driver={topDriver} coinId={row.id} subjectLabel={row.symbol} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="pharos-inset px-3 py-2">
          <p className="text-muted-foreground">Mechanism</p>
          <p className="mt-0.5 truncate font-medium text-foreground">
            {row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : "—"}
          </p>
        </div>
        <div className="pharos-inset px-3 py-2">
          <p className="text-muted-foreground">Peg</p>
          <p className="mt-0.5 font-medium text-foreground">
            {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
          </p>
        </div>
        <div className="pharos-inset px-3 py-2">
          <p className="text-muted-foreground">Mint authority</p>
          <p className="mt-0.5 font-medium text-foreground">
            {row.mintAuthorityScoreLabel ?? "—"}
            {row.mintAuthorityScoreLabel !== null
              ? ` / ${MINT_AUTHORITY_STATUS_CONFIG[row.mintAuthority].spokenLabel}`
              : null}
          </p>
        </div>
      </div>
    </article>
  );
}

function DesktopScoreCell({ value }: { value: number | null }) {
  return (
    <TableCell className="text-right pharos-numeric">
      <ScoreValue value={value} />
    </TableCell>
  );
}

function ScreenerTableRow({
  row,
  logo,
  rowProps,
  selected,
  onToggleSelect,
}: {
  row: ScreenerRow;
  logo?: string;
  rowProps?: ReturnType<UseRowCursorResult["getRowProps"]>;
  selected: boolean;
  onToggleSelect: (coinId: string) => void;
}) {
  const topDriver = projectScreenerTopDriver(row);
  return (
    <TableRow
      {...rowProps}
      data-state={selected ? "selected" : undefined}
      className="data-[cursor=true]:bg-muted/40 data-[cursor=true]:shadow-[inset_3px_0_0_0_var(--brand-accent)]"
    >
      <TableCell className="w-11 text-center">
        <label className="inline-flex size-8 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(row.id)}
            aria-label={`Select ${row.name} (${row.symbol})`}
            className="pharos-focus-ring h-4 w-4 rounded-sm border-border accent-foreground"
          />
        </label>
      </TableCell>
      <TableCell className="min-w-[160px]">
        <StablecoinIdentityTransition id={row.id}>
          <Link
            href={buildStablecoinUrl(row.id)}
            data-screener-open={row.id}
            className="pharos-focus-ring inline-flex min-w-0 items-center gap-2 rounded-sm"
          >
            <StablecoinIdentity
              layout="contents"
              logoSrc={logo}
              name={row.name}
              symbol={row.symbol}
              logoSize={24}
              symbolClassName="block font-semibold text-foreground"
              nameClassName="block truncate text-xs text-muted-foreground"
            />
          </Link>
        </StablecoinIdentityTransition>
        {row.states?.[0] ? <CoinStateChip state={row.states[0]} className="mt-1 flex w-fit" /> : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right pharos-numeric">
        {row.supplyUsd != null ? formatCompactUsd(row.supplyUsd) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <DesktopScoreCell value={row.pegScore} />
      <TableCell className="text-right">
        <DewsReading score={row.dewsScore} band={row.dewsBand} />
      </TableCell>
      <DesktopScoreCell value={row.liquidityScore} />
      <TableCell className="whitespace-nowrap text-center">
        {row.safetyGrade !== null || row.ratingStatus === "pipeline-gap" ? (
          <SafetyGradeBadge
            grade={row.safetyGrade}
            score={row.safetyScore}
            size="sm"
            className="whitespace-nowrap"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="w-[15rem] max-w-[15rem] text-center">
        <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
          <SafetyProfile row={row} />
          <SafetyScoreTopDriver driver={topDriver} coinId={row.id} subjectLabel={row.symbol} />
        </div>
      </TableCell>
      <TableCell className="text-left text-muted-foreground">
        {row.mechanism ? getMechanismArchetypeLabel(row.mechanism) : "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-left text-muted-foreground">
        {PEG_METADATA[row.peg]?.filterLabel ?? row.peg}
      </TableCell>
      <TableCell
        data-column-id="peg30d"
        className="hidden w-[112px] text-right xl:table-cell"
      >
        <RowSparkline
          data={getRowPegDeviationSeries(row)}
          signed
          referenceValue={0}
          ariaLabel={`Peg range: worst / current for ${row.symbol}`}
          width={96}
          height={16}
        />
      </TableCell>
      <TableCell
        data-column-id="supply30d"
        className="hidden w-[112px] text-right xl:table-cell"
      >
        <RowSparkline
          data={getRowSupplySeries(row)}
          ariaLabel={`30-day supply trajectory for ${row.symbol}`}
          width={96}
          height={16}
        />
      </TableCell>
    </TableRow>
  );
}

// ScreenerRow intentionally remains the existing scalar projection; it does
// not carry the card freshness enum, so the chip names no evidence age rather
// than fetching or reconstructing the full card.
function projectScreenerTopDriver(row: ScreenerRow): SafetyScoreTopDriverProps["driver"] {
  if (row.ratingStatus === "pipeline-gap" || row.ratingStatus === null) return null;
  if (row.safetyGrade === null || row.safetyGrade === "NR") {
    return {
      kind: "withheld",
      label: null,
      value: null,
      reason: "Safety Score is not rated.",
    };
  }
  if (row.safetyBindingCapReason !== null) {
    return {
      kind: "cap-bound",
      label: row.safetyBindingCapReason,
      value: null,
      reason: row.safetyBindingCapReason,
    };
  }
  if (row.safetyWeakestPillar !== null && row.safetyWeakestScore !== null) {
    // A weakest pillar that is only assumed (no measured score) names the
    // pillar without its stand-in value, which would read as a measurement.
    const measured = { backing: row.safetyBackingScore, exit: row.safetyExitScore, control: row.safetyControlScore }[row.safetyWeakestPillar];
    return {
      kind: "pillar-bound",
      label: row.safetyWeakestPillar,
      value: measured == null ? null : row.safetyWeakestScore,
      reason: null,
    };
  }
  return null;
}

function SafetyProfile({ row, compact = false }: { row: ScreenerRow; compact?: boolean }) {
  const partial = describePartialEvidence(row);
  const unavailableEvidence = row.safetyEvidence === null || row.safetyEvidence === "pipeline-gap";
  const evidenceLabel = row.safetyEvidence === null ? "Unavailable"
    : row.safetyEvidence === "pipeline-gap" ? "Pipeline gap" : SAFETY_EVIDENCE_LABELS[row.safetyEvidence];
  const evidenceClass = unavailableEvidence ? "border-border text-muted-foreground"
    : SAFETY_EVIDENCE_BADGE_CLASSES[row.safetyEvidence as keyof typeof SAFETY_EVIDENCE_BADGE_CLASSES];
  const title = row.safetyBindingCapReason
    ? `Binding cap: ${row.safetyBindingCapReason}`
    : `Safety evidence: ${evidenceLabel}`;
  return (
    <span className={`inline-flex max-w-full ${compact ? "items-center" : "min-w-0 flex-col"} gap-1`} title={title}>
      <span className="inline-flex items-center gap-1 pharos-numeric text-xs">
        <PillarReading label="B" value={row.safetyBackingScore} weakest={row.safetyWeakestPillar === "backing"} />
        <span className="text-border">/</span>
        <PillarReading label="E" value={row.safetyExitScore} weakest={row.safetyWeakestPillar === "exit"} />
        <span className="text-border">/</span>
        <PillarReading label="C" value={row.safetyControlScore} weakest={row.safetyWeakestPillar === "control"} />
      </span>
      <span className={`whitespace-nowrap rounded-full border px-1.5 py-0.5 text-3xs font-semibold leading-none ${evidenceClass}`}>
        {evidenceLabel}
      </span>
      {partial !== null ? <span className="text-3xs text-muted-foreground" title={partial.summary}>
        {partial.gaps.map(formatPartialEvidenceGap).join(" · ")}
      </span> : null}
    </span>
  );
}

function PillarReading({
  label,
  value,
  weakest,
}: {
  label: "B" | "E" | "C";
  value: number | null;
  weakest: boolean;
}) {
  return (
    <span className={weakest ? "font-bold text-state-warn-bright" : "text-foreground"} title={value == null ? `${{ B: "Backing", E: "Exit", C: "Economic Control" }[label]} unknown` : undefined}>
      <span className="text-muted-foreground">{label}</span>{value == null ? "?" : Math.round(value)}
    </span>
  );
}
