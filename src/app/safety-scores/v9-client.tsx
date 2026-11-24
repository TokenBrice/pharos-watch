"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { GitCompareArrows, LayoutGrid, Network, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterSearchInput } from "@/components/filter-search-input";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { TablePagination } from "@/components/table-pagination";
import { TableToolbar } from "@/components/table-toolbar";
import {
  SafetyCompareSelectionBar,
  SafetyScoresMatrixTable,
} from "@/components/safety-scores/safety-scores-matrix-table";
import { useReportCardsV9Table } from "@/hooks/api-hooks";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useTablePagination } from "@/hooks/use-table-pagination";
import { useUrlFilters } from "@/hooks/use-url-filters";
import type { TableDensity } from "@/hooks/use-table-density";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import type { CsvColumn } from "@/lib/exports/csv";
import { logosById } from "@/lib/logos";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";
import type { V9TableConsumerCard as V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import { ECONOMIC_CONTROL_SHORT_LABEL } from "@shared/lib/classification";
import type { ReportCardGradeRange } from "@shared/types/report-card-grade";
import { SafetyScoresContentLoadingState } from "./loading-state";
import {
  SafetyEmptyState,
  SafetyResultsSummary,
  SafetyScoresHero,
} from "./presentational";
import { SafetyPillarExplainer, SafetyPillarScoringNote } from "./pillar-explainer";
import {
  GRADE_RANGES,
  buildSafetyMcapMap,
  buildSafetyPegTypeMap,
  buildV9GradeCounts,
  buildV9HeadlineStats,
  buildV9PillarAverages,
  buildV9SupplyMix,
  excludeTokenizedFundCards,
  filterAndSortV9Cards,
  formatSafetyCardTopDriverExport,
  groupV9CardsByGrade,
  resolveSafetyCardMeta,
  type GradeFilter,
  type PegFilter,
  type SafetyScoresViewMode,
  type V9SortDirection,
  type V9SortKey,
} from "./v9-view-model";

// Live grid cards need charts; the first-paint hero, matrix table, and dated preview do not.
const ReportCardMiniV9 = dynamic(() => import("@/components/safety-scores/report-card-mini-v9").then((m) => m.ReportCardMiniV9), {
  loading: () => <Skeleton className="h-[274px] w-full rounded-xl" aria-label="Loading safety card" />,
});

const SAFETY_SCORES_PAGE_SIZE = 48;

const SORT_OPTIONS: ReadonlyArray<{ key: V9SortKey; label: string }> = [
  { key: "overall", label: "Overall" },
  { key: "backing", label: "Backing" },
  { key: "exit", label: "Exit" },
  { key: "control", label: ECONOMIC_CONTROL_SHORT_LABEL },
  { key: "mcap", label: "MCap" },
];

const PEG_OPTIONS: ReadonlyArray<{ key: Exclude<PegFilter, "all">; label: string }> = [
  { key: "usd", label: "USD" },
  { key: "fiat-non-usd", label: "Other pegs" },
  { key: "commodities", label: "Commodities" },
];

const VALID_GRADES = new Set<string>(["all", ...GRADE_RANGES]);
const VALID_PEGS = new Set<string>(["all", "usd", "fiat-non-usd", "commodities"]);
const VALID_SORTS = new Set<string>(["overall", "backing", "exit", "control", "mcap", "coin"]);

function parseGradeParam(raw: string): GradeFilter {
  return VALID_GRADES.has(raw) ? (raw as GradeFilter) : "all";
}

function parsePegParam(raw: string): PegFilter {
  return VALID_PEGS.has(raw) ? (raw as PegFilter) : "all";
}

function parseSortParam(raw: string): V9SortKey {
  return VALID_SORTS.has(raw) ? (raw as V9SortKey) : "overall";
}

function parseSortDirParam(raw: string): V9SortDirection {
  return raw === "asc" ? "asc" : "desc";
}

function parseViewParam(raw: string): SafetyScoresViewMode {
  return raw === "grid" ? "grid" : "table";
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: SafetyScoresViewMode;
  onChange: (mode: SafetyScoresViewMode) => void;
}) {
  return (
    <div role="group" aria-label="Display view" className="pharos-segmented">
      <button
        type="button"
        aria-pressed={viewMode === "table"}
        onClick={() => onChange("table")}
        className="pharos-focus-ring pharos-segmented-item min-h-11 gap-1.5 sm:min-h-8"
      >
        <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Table</span>
      </button>
      <button
        type="button"
        aria-pressed={viewMode === "grid"}
        onClick={() => onChange("grid")}
        className="pharos-focus-ring pharos-segmented-item min-h-11 gap-1.5 sm:min-h-8"
      >
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Grid</span>
      </button>
    </div>
  );
}

function GradeFilterButtons({
  gradeFilter,
  totalCards,
  gradeCounts,
  onChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  onChange: (grade: GradeFilter) => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={gradeFilter === "all"}
        onClick={() => onChange("all")}
        className={cn(
          "pharos-focus-ring pharos-control-pill min-h-11 text-xs md:min-h-0",
          gradeFilter === "all" && "pharos-control-pill-active",
        )}
      >
        All ({totalCards})
      </Button>
      {GRADE_RANGES.map((grade) => {
        const count = gradeCounts[grade] ?? 0;
        if (count === 0) return null;
        return (
          <Button
            key={grade}
            variant="ghost"
            size="sm"
            aria-pressed={gradeFilter === grade}
            onClick={() => onChange(gradeFilter === grade ? "all" : grade)}
            className={cn(
              "pharos-focus-ring pharos-control-pill min-h-11 text-xs md:min-h-0",
              gradeFilter === grade && "pharos-control-pill-active",
            )}
          >
            {grade === "pipeline-gap" ? "Pipeline gap" : grade} ({count})
          </Button>
        );
      })}
    </>
  );
}

function SortButtons({
  sortKey,
  onChange,
}: {
  sortKey: V9SortKey;
  onChange: (key: V9SortKey) => void;
}) {
  return SORT_OPTIONS.map((option) => (
    <Button
      key={option.key}
      variant="ghost"
      size="sm"
      aria-pressed={sortKey === option.key}
      onClick={() => onChange(option.key)}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-11 text-xs md:min-h-0",
        sortKey === option.key && "pharos-control-pill-active",
      )}
    >
      {option.label}
    </Button>
  ));
}

function PegFilterButtons({
  pegFilter,
  onChange,
}: {
  pegFilter: PegFilter;
  onChange: (peg: PegFilter) => void;
}) {
  return PEG_OPTIONS.map((option) => (
    <Button
      key={option.key}
      variant="ghost"
      size="sm"
      aria-pressed={pegFilter === option.key}
      onClick={() => onChange(pegFilter === option.key ? "all" : option.key)}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-11 text-xs md:min-h-0",
        pegFilter === option.key && "pharos-control-pill-active",
      )}
    >
      {option.label}
    </Button>
  ));
}

function V9Controls({
  searchQuery,
  gradeFilter,
  totalCards,
  gradeCounts,
  pegFilter,
  sortKey,
  onSearchChange,
  onGradeFilterChange,
  onPegFilterChange,
  onSortChange,
}: {
  searchQuery: string;
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  pegFilter: PegFilter;
  sortKey: V9SortKey;
  onSearchChange: (value: string) => void;
  onGradeFilterChange: (grade: GradeFilter) => void;
  onPegFilterChange: (peg: PegFilter) => void;
  onSortChange: (key: V9SortKey) => void;
}) {
  const gradeButtons = (
    <GradeFilterButtons
      gradeFilter={gradeFilter}
      totalCards={totalCards}
      gradeCounts={gradeCounts}
      onChange={onGradeFilterChange}
    />
  );

  return (
    <div className="space-y-3 border-t border-border/40 pt-5">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        <FilterSearchInput
          value={searchQuery}
          onValueChange={onSearchChange}
          placeholder="Search coin, ticker, or ID"
          ariaLabel="Search safety scores by coin name, ticker, or ID"
          className="relative w-full md:w-64"
          inputClassName="h-11 pl-9 text-sm md:h-9"
        />

        <div className="hidden md:flex md:flex-wrap md:items-center md:gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="pharos-label mr-1.5">Grade:</span>
            {gradeButtons}
          </div>
          <div className="h-5 w-px bg-border" aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-1">
            <span className="pharos-label mr-1.5">Peg:</span>
            <PegFilterButtons pegFilter={pegFilter} onChange={onPegFilterChange} />
          </div>
          <div className="h-5 w-px bg-border" aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-1">
            <span className="pharos-label mr-1.5">Sort:</span>
            <SortButtons sortKey={sortKey} onChange={onSortChange} />
          </div>
        </div>
      </div>

      <details className="pharos-card-shell px-4 py-3 md:hidden">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-lg text-sm font-medium text-foreground">
          Filter and sort ratings
        </summary>
        <div className="space-y-4 pt-3">
          <div className="space-y-2">
            <span className="pharos-label">Filter by grade</span>
            <div className="flex flex-wrap gap-1.5">{gradeButtons}</div>
          </div>
          <div className="space-y-2">
            <span className="pharos-label">Peg</span>
            <div className="flex flex-wrap gap-1.5">
              <PegFilterButtons pegFilter={pegFilter} onChange={onPegFilterChange} />
            </div>
          </div>
          <div className="space-y-2">
            <span className="pharos-label">Sort by</span>
            <div className="flex flex-wrap gap-1.5">
              <SortButtons sortKey={sortKey} onChange={onSortChange} />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  const metadata = grade === "pipeline-gap" ? null : getSafetyGradeMetadata(grade as NonNullable<V9ConsumerCard["grade"]>);
  return (
    <div className="pharos-section-enter col-span-full flex items-center gap-3 pt-4 first:pt-0">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold text-white",
          metadata?.sectionSwatchClassName ?? "bg-muted text-foreground",
        )}
      >
        {grade === "pipeline-gap" ? "—" : grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">{count} {count === 1 ? "coin" : "coins"}</span>
        <span className="ml-2 text-xs text-muted-foreground">{metadata?.sectionDescription ?? "Pipeline gap · fewer than two available pillars; no rating"}</span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

function samePreviewMethodology(
  identity: { model: string; methodologyVersion: string; policyId?: string; policyDigest?: string },
  preview: SafetyScoresPreview,
): boolean {
  return identity.model === "v9"
    && identity.methodologyVersion === preview.identity.methodologyVersion
    && identity.policyId === preview.identity.policyId
    && identity.policyDigest === preview.identity.policyDigest;
}

export function ReportCardsV9Client({
  initialPreview = null,
  onHandoff,
}: {
  initialPreview?: SafetyScoresPreview | null;
  onHandoff?: () => void;
}) {
  const reportCardsQuery = useReportCardsV9Table();
  const stablecoinsQuery = useStablecoins();
  const logos = logosById;
  const { getParam, setParam, setParams } = useUrlFilters();

  const searchQuery = getParam("q", "");
  const gradeFilter = parseGradeParam(getParam("grade", "all"));
  const pegFilter = parsePegParam(getParam("peg", "all"));
  const sortKey = parseSortParam(getParam("sort", "overall"));
  const sortDirection = parseSortDirParam(getParam("dir", "desc"));
  const viewMode = parseViewParam(getParam("view", "table"));

  const [density, setDensity] = useState<TableDensity>("compact");
  const isDesktopTable = !useIsMobile(1024, false);
  const [selectedCompareIds, setSelectedCompareIds] = useState<string[]>([]);

  // Hydration-stable first render uses the build clock; after hydration,
  // re-evaluate retention with the viewer's clock and at its deadline.
  const [nowSec, setNowSec] = useState(initialPreview?.capturedAtSec ?? 0);
  const previewExpiresAtSec = initialPreview?.expiresAtSec;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const updateClock = () => {
      const nowMs = Date.now();
      setNowSec(Math.floor(nowMs / 1000));
      if (previewExpiresAtSec !== undefined && nowMs < previewExpiresAtSec * 1000) {
        // Browser timeouts cannot represent delays beyond signed 32-bit milliseconds.
        timer = setTimeout(updateClock, Math.min(previewExpiresAtSec * 1000 - nowMs, 2_147_483_647));
      }
    };
    timer = setTimeout(updateClock, 0);
    return () => clearTimeout(timer);
  }, [previewExpiresAtSec]);
  const previewActive = initialPreview !== null && nowSec < initialPreview.expiresAtSec;

  const cards = useMemo(
    () => excludeTokenizedFundCards(reportCardsQuery.data?.cards),
    [reportCardsQuery.data?.cards],
  );
  const mcapMap = useMemo(
    () => buildSafetyMcapMap(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
  const pegTypeMap = useMemo(
    () => buildSafetyPegTypeMap(cards),
    [cards],
  );
  const gradeCounts = useMemo(() => buildV9GradeCounts(cards), [cards]);
  const totalCards = cards.length;
  const headlineStats = useMemo(() => buildV9HeadlineStats(cards, mcapMap), [cards, mcapMap]);
  const supplyMix = useMemo(() => buildV9SupplyMix(cards, mcapMap), [cards, mcapMap]);
  const pillarAverages = useMemo(() => buildV9PillarAverages(cards), [cards]);
  // Same predicate as the ecosystem average in buildV9HeadlineStats.
  const scoredCount = useMemo(
    () => cards.filter((card) => card.ratingStatus === "rated" && card.score !== null).length,
    [cards],
  );
  const filteredCards = useMemo(
    () =>
      filterAndSortV9Cards(cards, {
        gradeFilter,
        pegFilter,
        pegTypeMap,
        sortKey,
        sortDirection,
        searchQuery,
        mcapMap,
      }),
    [cards, gradeFilter, mcapMap, pegFilter, pegTypeMap, searchQuery, sortDirection, sortKey],
  );

  const pagination = useTablePagination(filteredCards, {
    pageSize: SAFETY_SCORES_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const { onPageChange } = pagination;

  const groupedPageCards = useMemo(
    () => groupV9CardsByGrade(pagination.paginatedRows),
    [pagination.paginatedRows],
  );
  const showGroupedCards =
    gradeFilter === "all"
    && sortKey === "overall"
    && sortDirection === "desc"
    && searchQuery.trim().length === 0;

  const handleSearchChange = useCallback(
    (value: string) => {
      setParam("q", value);
      onPageChange(0);
    },
    [onPageChange, setParam],
  );

  const handleGradeFilterChange = useCallback(
    (grade: GradeFilter) => {
      setParam("grade", grade);
      onPageChange(0);
    },
    [onPageChange, setParam],
  );

  const handleDistributionGradeSelect = useCallback(
    (grade: ReportCardGradeRange) => {
      const nextGrade: GradeFilter = gradeFilter === grade ? "all" : grade;
      setParam("grade", nextGrade);
      onPageChange(0);
      const dataSection = document.getElementById("data");
      if (dataSection && typeof dataSection.scrollIntoView === "function") {
        dataSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [gradeFilter, onPageChange, setParam],
  );

  const handlePegFilterChange = useCallback(
    (peg: PegFilter) => {
      setParam("peg", peg);
      onPageChange(0);
    },
    [onPageChange, setParam],
  );

  const handleToggleSort = useCallback(
    (key: V9SortKey) => {
      const nextDirection: V9SortDirection =
        sortKey === key
          ? sortDirection === "asc"
            ? "desc"
            : "asc"
          : key === "coin"
            ? "asc"
            : "desc";
      setParams({
        sort: key === "overall" ? "" : key,
        dir: nextDirection === "desc" ? "" : nextDirection,
      });
      onPageChange(0);
    },
    [onPageChange, setParams, sortDirection, sortKey],
  );

  const handleSortButtonChange = useCallback(
    (key: V9SortKey) => {
      setParams({
        sort: key === "overall" ? "" : key,
        dir: "",
      });
      onPageChange(0);
    },
    [onPageChange, setParams],
  );

  const handleViewModeChange = useCallback(
    (mode: SafetyScoresViewMode) => {
      setParam("view", mode === "table" ? "" : mode);
    },
    [setParam],
  );

  const handleClearFilters = useCallback(() => {
    setParams({ q: "", grade: "all", peg: "all" });
    onPageChange(0);
  }, [onPageChange, setParams]);

  const handleToggleCompare = useCallback((coinId: string) => {
    setSelectedCompareIds((prev) => {
      if (prev.includes(coinId)) return prev.filter((id) => id !== coinId);
      if (prev.length >= MAX_COMPARE_COINS) return prev;
      return [...prev, coinId];
    });
  }, []);

  const handleRemoveCompare = useCallback((coinId: string) => {
    setSelectedCompareIds((prev) => prev.filter((id) => id !== coinId));
  }, []);

  const handleClearCompare = useCallback(() => {
    setSelectedCompareIds([]);
  }, []);

  const getAriaSortValue = useCallback(
    (columnKey: V9SortKey): "ascending" | "descending" | "none" => {
      if (sortKey !== columnKey) return "none";
      return sortDirection === "asc" ? "ascending" : "descending";
    },
    [sortDirection, sortKey],
  );

  const exportColumns = useMemo<CsvColumn<V9ConsumerCard>[]>(
    () => [
      { header: "Symbol", accessor: (row) => resolveSafetyCardMeta(row).symbol },
      { header: "Name", accessor: (row) => resolveSafetyCardMeta(row).name },
      { header: "ID", accessor: (row) => row.id },
      { header: "Grade", accessor: (row) => row.grade ?? "Pipeline gap" },
      { header: "Score", accessor: (row) => row.score },
      { header: "Rating Status", accessor: (row) => row.ratingStatus },
      {
        header: "Backing",
        accessor: (row) => (row.ratingStatus === "rated" ? row.pillars.backing.score : null),
      },
      {
        header: "Exit",
        accessor: (row) => (row.ratingStatus === "rated" ? row.pillars.exit.score : null),
      },
      {
        header: "Economic Control",
        accessor: (row) => (row.ratingStatus === "rated" ? row.pillars.control.score : null),
      },
      { header: "Top Driver / Cap", accessor: (row) => formatSafetyCardTopDriverExport(row) },
      { header: "Market Cap (USD)", accessor: (row) => mcapMap.get(row.id) ?? null },
      { header: "Peg", accessor: (row) => resolveSafetyCardMeta(row).pegLabel },
    ],
    [mcapMap],
  );

  const handleRetry = useCallback(
    () => refetchQueryGroup([reportCardsQuery.refetch, stablecoinsQuery.refetch]),
    [reportCardsQuery.refetch, stablecoinsQuery.refetch],
  );

  const liveData = reportCardsQuery.data;
  // A live publication wins unless it is the same methodology and strictly
  // older than the build preview. A methodology change is never compared.
  const previewOutranksLive = initialPreview !== null
    && liveData !== undefined
    && samePreviewMethodology(liveData.safetyScoreIdentity, initialPreview)
    && liveData.updatedAt < initialPreview.publishedAtSec;
  const usePreview = previewActive && (liveData === undefined || previewOutranksLive);
  const matchesFirstFlush = reportCardsQuery.isLoading && usePreview === (initialPreview !== null);
  useLayoutEffect(() => {
    if (!matchesFirstFlush) onHandoff?.();
  }, [matchesFirstFlush, onHandoff]);

  if (onHandoff) return null;

  if (reportCardsQuery.isLoading || usePreview) {
    return (
      <div className="space-y-6">
        {!reportCardsQuery.isLoading && (
          <QueryFreshnessNotices
            error={reportCardsQuery.error ?? stablecoinsQuery.error}
            hasData={false}
            onRetry={handleRetry}
            queries={[
              {
                preset: "reportCards",
                dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
                error: reportCardsQuery.error,
                hasData: false,
                meta: reportCardsQuery.meta,
              },
              {
                preset: "stablecoins",
                dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
                error: stablecoinsQuery.error,
                hasData: !!stablecoinsQuery.data?.peggedAssets?.length,
                meta: stablecoinsQuery.meta,
              },
            ]}
          />
        )}
        <SafetyScoresContentLoadingState preview={usePreview ? initialPreview : null} />
      </div>
    );
  }

  const activeDistributionGrade: ReportCardGradeRange | null =
    gradeFilter === "all" || gradeFilter === "pipeline-gap" ? null : gradeFilter;

  const exportAsOfISO = liveData
    ? new Date(liveData.updatedAt * 1000).toISOString()
    : "";
  const exportMethodologyLabel = liveData
    ? `safety-score v${liveData.safetyScoreIdentity.methodologyVersion}`
    : "safety-score";
  const exportMenu = liveData
    ? {
        data: filteredCards,
        columns: exportColumns,
        filename: "pharos-safety-scores",
        asOfISO: exportAsOfISO,
        endpoint: "report-cards",
        methodologyLabel: exportMethodologyLabel,
        sourceGenerations: liveData.source.sourceGenerations,
        disabled: filteredCards.length === 0,
      }
    : undefined;

  const paginationProps = {
    page: pagination.effectivePage,
    totalPages: pagination.totalPages,
    rangeStart: pagination.rangeStart,
    rangeEnd: pagination.rangeEnd,
    total: pagination.totalRows,
    onPrevious: pagination.onPreviousPage,
    onNext: pagination.onNextPage,
    noun: "stablecoins",
    showControls: pagination.totalPages > 1,
  };

  const showDensityToggle = viewMode === "table" && isDesktopTable;
  const toolbarNode = (
    <TableToolbar<V9ConsumerCard>
      eyebrow={viewMode === "table" ? "Safety Score Matrix" : "Safety Score Grid"}
      description={null}
      meta={`${filteredCards.length.toLocaleString("en-US")} of ${totalCards.toLocaleString("en-US")} coins`}
      density={showDensityToggle ? density : undefined}
      onDensityChange={showDensityToggle ? setDensity : undefined}
      exportMenu={exportMenu}
      additionalActions={
        <ViewModeToggle viewMode={viewMode} onChange={handleViewModeChange} />
      }
    />
  );

  const compareCrossLinkHref = selectedCompareIds.length > 0
    ? buildLiveCompareUrl(selectedCompareIds)
    : "/compare/";

  const renderCard = (card: V9ConsumerCard, index: number) => (
    // content-visibility skips off-screen card rendering without a JS mount
    // gate, so the grid keeps its height (no scroll-time layout shift) and the
    // card text stays in the static HTML.
    <div
      key={card.id}
      className="min-w-0 rounded-xl [contain-intrinsic-size:auto_274px] [content-visibility:auto] [&>div]:h-full [&>div>div]:h-full"
    >
      <div className="pharos-card-enter">
        <ReportCardMiniV9
          card={card}
          identity={liveData!.safetyScoreIdentity}
          logo={logos?.[card.id]}
          animIndex={index % 5}
          mcap={mcapMap.get(card.id) ?? null}
          highlightedMetric={sortKey}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={reportCardsQuery.error ?? stablecoinsQuery.error}
        hasData={cards.length > 0 || !!stablecoinsQuery.data?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
            error: reportCardsQuery.error,
            hasData: cards.length > 0,
            meta: reportCardsQuery.meta,
          },
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
            error: stablecoinsQuery.error,
            hasData: !!stablecoinsQuery.data?.peggedAssets?.length,
            meta: stablecoinsQuery.meta,
          },
        ]}
      />
      <SafetyScoresHero
        data={liveData ? {
          stats: headlineStats,
          gradeCounts,
          totalCards: totalCards - gradeCounts["pipeline-gap"],
          scoredCount,
          cardCount: totalCards,
          supplyMix,
          pillarAverages,
        } : null}
        activeGrade={activeDistributionGrade}
        onSelectGrade={liveData ? handleDistributionGradeSelect : undefined}
      />

      <SafetyPillarExplainer />
      <SafetyPillarScoringNote />

      <V9Controls
        searchQuery={searchQuery}
        gradeFilter={gradeFilter}
        totalCards={totalCards}
        gradeCounts={gradeCounts}
        pegFilter={pegFilter}
        sortKey={sortKey}
        onSearchChange={handleSearchChange}
        onGradeFilterChange={handleGradeFilterChange}
        onPegFilterChange={handlePegFilterChange}
        onSortChange={handleSortButtonChange}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SafetyResultsSummary
          count={filteredCards.length}
          totalCount={totalCards}
          gradeFilter={gradeFilter}
          pegFilter={pegFilter}
          searchQuery={searchQuery}
        />
        <nav aria-label="Related instruments" className="flex flex-wrap items-center gap-3 text-xs">
          <Link
            href="/dependency-map/"
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm font-medium text-brand-accent-text underline-offset-4 hover:underline"
          >
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Dependency Map{"\u00a0\u2192"}</span>
          </Link>
          <span className="text-border" aria-hidden="true">|</span>
          <Link
            href={compareCrossLinkHref}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm font-medium text-brand-accent-text underline-offset-4 hover:underline"
          >
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {selectedCompareIds.length > 0
                ? `Compare selected (${selectedCompareIds.length})\u00a0\u2192`
                : "Compare stablecoins\u00a0\u2192"}
            </span>
          </Link>
        </nav>
      </div>

      <SafetyCompareSelectionBar
        selectedIds={selectedCompareIds}
        logos={logos}
        onRemove={handleRemoveCompare}
        onClear={handleClearCompare}
      />

      <section
        id="data"
        aria-label={viewMode === "table" ? "Safety score matrix" : "Safety score cards"}
        tabIndex={-1}
        className="scroll-mt-[var(--sticky-header-bottom,4rem)]"
      >
        {!liveData ? (
          <p className="pharos-empty-note text-sm text-muted-foreground" role="alert">
            Safety Score ratings are temporarily unavailable. Legacy ratings are not used as a fallback.
          </p>
        ) : filteredCards.length === 0 ? (
          <div className="space-y-3">
            <div className="pharos-card-shell overflow-hidden">{toolbarNode}</div>
            <SafetyEmptyState
              gradeFilter={gradeFilter}
              pegFilter={pegFilter}
              searchQuery={searchQuery}
              onClearFilter={handleClearFilters}
            />
          </div>
        ) : viewMode === "table" ? (
          <SafetyScoresMatrixTable
            cards={pagination.paginatedRows}
            mcapMap={mcapMap}
            logos={logos}
            sort={{
              sortKey,
              sortDirection,
              toggleSort: handleToggleSort,
              getAriaSortValue,
            }}
            density={density}
            pagination={paginationProps}
            selectedCompareIds={selectedCompareIds}
            onToggleCompare={handleToggleCompare}
            toolbar={toolbarNode}
          />
        ) : (
          <div className="space-y-4">
            <div className="pharos-card-shell overflow-hidden">{toolbarNode}</div>
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {showGroupedCards
                ? groupedPageCards.map((group) => (
                    <Fragment key={group.grade}>
                      <GradeSectionHeader grade={group.grade} count={group.cards.length} />
                      {group.cards.map(renderCard)}
                    </Fragment>
                  ))
                : pagination.paginatedRows.map(renderCard)}
            </div>
            <div className="pharos-card-shell overflow-hidden">
              <TablePagination {...paginationProps} bordered={false} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
