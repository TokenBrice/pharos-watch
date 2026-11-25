"use client";

import { Fragment, useCallback, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, SearchX, X } from "lucide-react";
import { getPricingSourceLabel } from "@shared/lib/pricing-sources";
import { CoverageLensSummary } from "@/components/coverage/coverage-lens-summary";
import { FilterSearchInput } from "@/components/filter-search-input";
import { SafetyScoreDataCoverage } from "@/components/safety-scores/data-coverage-module";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { TablePagination } from "@/components/table-pagination";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useReferenceTablePage } from "@/hooks/use-reference-table-page";
import { COVERAGE_FEATURES, type CoverageRow } from "@/lib/coverage";
import {
  AUTHORITATIVE_ACCENT,
  FEATURE_ACCENT_CLASSES,
  getLegendGroups,
} from "@/lib/coverage-page-config";
import {
  COVERAGE_FEATURE_SORT_KEYS,
  COVERAGE_MATRIX_SORT_OPTIONS,
  getCoverageMatrixFilterGroups,
  type CoverageMatrixFilterKey,
  type CoverageMatrixSortKey,
} from "@/components/coverage/coverage-matrix-controls";
import { cn } from "@/lib/utils";
import { CoverageBadge } from "@/components/coverage/coverage-badge";
import { CoverageCoinIdentity } from "@/components/coverage/coverage-coin-identity";
import { CoverageFeatureSnapshotRow, FeatureSnapshotInsight } from "@/components/coverage/coverage-feature-snapshot";
import { CoverageMobileCard } from "@/components/coverage/coverage-mobile-card";
import type { useCoveragePageModel } from "@/hooks/use-coverage-page-model";

type CoveragePageModel = ReturnType<typeof useCoveragePageModel>;
// Mobile cards run ~250px each, so a page stays near one long scroll on phones.
const COVERAGE_PAGE_SIZE = 20;

export function CoverageMatrixDataStateCard({ state }: { state: "loading" | "error" }) {
  const isError = state === "error";

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1.5">
        <p className="pharos-label">Coverage matrix</p>
        <CardTitle as="h2" className="pharos-section-title">
          {isError ? "Coverage snapshot unavailable" : "Loading coverage snapshot"}
        </CardTitle>
        <CardDescription className="max-w-3xl leading-relaxed">
          {isError
            ? "The stablecoin market snapshot is required before coverage counts can be trusted. The matrix will return when that feed recovers."
            : "Waiting for the market snapshot and feature feeds before showing coverage counts, so loading states are not mistaken for real gaps."}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="pharos-empty-note py-8">
          {isError
            ? "Active-coin denominator isn't ready this round."
            : "Preparing feature availability, market-cap reach, and per-coin statuses."}
        </div>
      </CardContent>
    </Card>
  );
}

export function CoverageFeatureSnapshotCard({
  featureSummaries,
  sourceDepthProgress,
  widestFeature,
  narrowestFeature,
  mostConcentratedFeature,
  onFilterFeature,
}: Pick<
  CoveragePageModel,
  "featureSummaries" | "sourceDepthProgress" | "widestFeature" | "narrowestFeature" | "mostConcentratedFeature"
> & {
  onFilterFeature?: (filter: CoverageMatrixFilterKey) => void;
}) {
  const activeCoinTotal = featureSummaries.reduce((total, summary) => Math.max(total, summary.totalCount), 0);
  const knownCoveragePcts = featureSummaries
    .map((summary) => summary.coveragePct)
    .filter((coveragePct): coveragePct is number => coveragePct != null);
  const averageCoveragePct =
    knownCoveragePcts.length > 0
      ? knownCoveragePcts.reduce((sum, coveragePct) => sum + coveragePct, 0) / knownCoveragePcts.length
      : null;

  return (
    <Card className="pharos-card-shell gap-0 overflow-hidden py-0">
      <CardHeader className="pharos-panel-header px-4 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-end">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="pharos-label">Coverage overview</p>
              <CardTitle as="h2" className="pharos-section-title">
                Feature breadth by surface
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-border/40 pt-3">
              <div className="min-w-0">
                <p className="pharos-hero-kpi">
                  {activeCoinTotal}
                </p>
                <p className="mt-1.5 pharos-label">
                  Active coins tracked
                </p>
              </div>
              <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pb-0.5">
                <div className="flex items-baseline gap-1.5">
                  <dt className="pharos-label">
                    Avg. reach
                  </dt>
                  <dd className="pharos-numeric text-sm font-semibold leading-none text-foreground">
                    {averageCoveragePct == null ? "n/a" : `${averageCoveragePct.toFixed(0)}%`}
                  </dd>
                  <span className="text-2xs text-muted-foreground">headline</span>
                </div>
                <span aria-hidden="true" className="h-3 w-px bg-border/60" />
                <div className="flex items-baseline gap-1.5">
                  <dt className="pharos-label">
                    Surfaces
                  </dt>
                  <dd className="pharos-numeric text-sm font-semibold leading-none text-foreground">
                    {featureSummaries.length}
                  </dd>
                  <span className="text-2xs text-muted-foreground">tracked</span>
                </div>
              </dl>
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <FeatureSnapshotInsight
              label="Source target"
              title="3+ sources"
              detail={
                <>
                  <span className="text-foreground">
                    {sourceDepthProgress.atTargetCount}/{sourceDepthProgress.totalCount}
                  </span>
                  <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                  {sourceDepthProgress.atTargetMcapPct == null
                    ? "n/a"
                    : `${sourceDepthProgress.atTargetMcapPct.toFixed(0)}% ${sourceDepthProgress.marketCapComplete ? "cap" : "known cap"}`}
                </>
              }
            />
            {widestFeature ? (
              <FeatureSnapshotInsight
                label="Widest reach"
                title={widestFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">
                      {widestFeature.coveragePct == null ? "n/a" : `${widestFeature.coveragePct.toFixed(0)}%`}
                    </span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {widestFeature.availableCount}/{widestFeature.totalCount}
                  </>
                }
              />
            ) : null}
            {narrowestFeature ? (
              <FeatureSnapshotInsight
                label="Tightest reach"
                title={narrowestFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">
                      {narrowestFeature.coveragePct == null ? "n/a" : `${narrowestFeature.coveragePct.toFixed(0)}%`}
                    </span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {narrowestFeature.availableCount}/{narrowestFeature.totalCount}
                  </>
                }
              />
            ) : null}
            {mostConcentratedFeature ? (
              <FeatureSnapshotInsight
                label="Cap skew"
                title={mostConcentratedFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">
                      {mostConcentratedFeature.mcapSharePct == null
                        ? "n/a"
                        : `${mostConcentratedFeature.mcapSharePct.toFixed(0)}%`}
                    </span>
                    <span className="ml-1 text-muted-foreground/80">{mostConcentratedFeature.marketCapComplete ? "cap" : "known cap"}</span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {mostConcentratedFeature.coveragePct == null ? "n/a" : `${mostConcentratedFeature.coveragePct.toFixed(0)}%`} count
                  </>
                }
              />
            ) : (
              <FeatureSnapshotInsight label="Cap skew" title="n/a" detail="No observed cap share" />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border/55">
          {featureSummaries.map((summary) => (
            <CoverageFeatureSnapshotRow
              key={summary.feature.key}
              summary={summary}
              onFilterFeature={onFilterFeature}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function CoverageSafetyScoreDataCard({
  safetyScoreDataCoverage,
}: Pick<CoveragePageModel, "safetyScoreDataCoverage">) {
  if (!safetyScoreDataCoverage) return null;

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1.5 pb-3">
        <p className="pharos-label">Safety Score coverage</p>
        <CardTitle as="h2" className="pharos-section-title">
          Score input coverage
        </CardTitle>
        <CardDescription className="max-w-3xl leading-relaxed">
          What the current Safety Score publication evaluated, and how its open questions split
          between research, issuer non-disclosure and documentation gaps.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <SafetyScoreDataCoverage model={safetyScoreDataCoverage} />
      </CardContent>
    </Card>
  );
}

export function CoveragePricingSourcesCard({
  pricingSources,
  authoritativeSources,
}: Pick<CoveragePageModel, "pricingSources" | "authoritativeSources">) {
  if (pricingSources.length === 0) {
    return null;
  }

  const maxSourceCount = Math.max(
    ...pricingSources.map((source) => source.count),
    ...authoritativeSources.map((source) => source.count),
    1,
  );

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1.5">
        <p className="pharos-label">Pricing sources</p>
        <CardTitle as="h2" className="pharos-section-title">
          Where Pharos gets its prices
        </CardTitle>
        <CardDescription className="max-w-3xl leading-relaxed">
          Each stablecoin price is derived from multi-source consensus. These are the providers feeding the pipeline and
          how many coins each one covers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {pricingSources.map((source) => {
            const widthPct =
              source.count > 0 ? Math.max(4, Math.min(100, (source.count / maxSourceCount) * 100)) : 0;
            return (
              <li key={source.name} className="pharos-inset space-y-1.5 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {getPricingSourceLabel(source.name)}
                  </span>
                  <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">
                    {source.count}
                    <span className="ml-1 font-sans text-2xs font-normal text-muted-foreground">
                      {source.count === 1 ? "coin" : "coins"}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-meter-track" aria-hidden="true">
                  <div
                    className={cn("h-full rounded-full", FEATURE_ACCENT_CLASSES.price.countBar)}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        {authoritativeSources.length > 0 ? (
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="space-y-1">
              <p className="pharos-label">Authoritative overrides</p>
              <p className="text-xs text-muted-foreground">
                Direct issuer or protocol pricing that supersedes market sources for specific assets.
              </p>
            </div>
            <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {authoritativeSources.map((source) => {
                const widthPct =
                  source.count > 0 ? Math.max(4, Math.min(100, (source.count / maxSourceCount) * 100)) : 0;
                return (
                  <li key={source.name} className="pharos-inset space-y-1.5 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {getPricingSourceLabel(source.name)}
                        </span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-3xs font-medium",
                            AUTHORITATIVE_ACCENT.badge,
                          )}
                        >
                          Protocol
                        </span>
                      </div>
                      <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">
                        {source.count}
                        <span className="ml-1 font-sans text-2xs font-normal text-muted-foreground">
                          {source.count === 1 ? "coin" : "coins"}
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-meter-track" aria-hidden="true">
                      <div
                        className={cn("h-full rounded-full", AUTHORITATIVE_ACCENT.bar)}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface CoverageMatrixCardProps
  extends Pick<
    CoveragePageModel,
    | "logos"
    | "rows"
    | "search"
    | "setSearch"
    | "filteredRows"
    | "hasActiveFilters"
    | "resetFilters"
    | "unavailableFeatures"
    | "dataAsOfMs"
  > {
  filter: CoverageMatrixFilterKey;
  setFilter: (next: CoverageMatrixFilterKey) => void;
  sort: CoverageMatrixSortKey;
  setSort: (next: CoverageMatrixSortKey) => void;
}

const COVERAGE_COLUMN_GUIDE_ID = "coverage-matrix-column-guide";
const COVERAGE_COLUMN_GUIDE_TEXT = COVERAGE_FEATURES.map(
  (feature) => `${feature.label}: ${feature.description}`,
).join(" ");

function CoverageMatrixTable({
  rows,
  totalCount,
  logos,
  sort,
  setSort,
  resetKey,
}: {
  rows: readonly CoverageRow[];
  totalCount: number;
  logos: Record<string, string> | undefined;
  sort: CoverageMatrixSortKey;
  setSort: (next: CoverageMatrixSortKey) => void;
  resetKey: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { page, totalPages, pageStartIndex, rangeStart, rangeEnd, setPage } = useReferenceTablePage({
    totalRows: rows.length,
    pageSize: COVERAGE_PAGE_SIZE,
    param: "page",
    resetKey,
  });
  const pageRows = rows.slice(pageStartIndex, pageStartIndex + COVERAGE_PAGE_SIZE);

  const goToPage = useCallback(
    (next: number) => {
      setPage(next);
      const top = rootRef.current?.getBoundingClientRect().top;
      if (top != null && top < 0) rootRef.current?.scrollIntoView({ block: "start" });
    },
    [setPage],
  );

  const isFiltered = totalCount !== rows.length;
  const stablecoinAriaSort: "ascending" | "descending" | "none" =
    sort === "name" ? "ascending" : sort === "market-cap" ? "descending" : "none";
  const isStablecoinSorted = stablecoinAriaSort !== "none";

  const renderPagination = (bordered: boolean) => (
    <TablePagination
      bordered={bordered}
      page={page - 1}
      totalPages={totalPages}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      total={rows.length}
      noun="coins"
      onPrevious={() => goToPage(page - 1)}
      onNext={() => goToPage(page + 1)}
      showControls={totalPages > 1}
      supplementaryText={
        isFiltered || totalPages > 1 ? (
          <>
            {totalPages > 1 ? `Page ${page} of ${totalPages}` : null}
            {isFiltered && totalPages > 1 ? " · " : null}
            {isFiltered ? `filtered from ${totalCount.toLocaleString("en-US")}` : null}
          </>
        ) : null
      }
    />
  );

  return (
    <div ref={rootRef} className="scroll-mt-[var(--table-header-top,0px)]">
      <p id={COVERAGE_COLUMN_GUIDE_ID} className="sr-only">
        {COVERAGE_COLUMN_GUIDE_TEXT}
      </p>
      <TableFrame
        tableId="coverage-matrix"
        testId="coverage-matrix-table"
        caption={`Per-coin feature availability across ${totalCount} active stablecoins.`}
        captionClassName="sr-only"
        chrome="default"
        density="compact"
        stickyHeader
        className="hidden overflow-clip @5xl:block"
        tableClassName="w-full min-w-[1220px] border-collapse"
        tableProps={{ "aria-describedby": COVERAGE_COLUMN_GUIDE_ID }}
        viewportClassName="overflow-x-auto overscroll-x-contain scroll-shadow [--table-header-top:0px] min-[1360px]:overflow-visible min-[1360px]:bg-none min-[1360px]:[--table-header-top:var(--sticky-header-bottom,3.75rem)]"
        viewportProps={{
          compactBottomPadding: false,
          horizontal: false,
          mobileScrollHint: false,
          overscrollX: false,
          scrollShadow: false,
        }}
        footerSlot={renderPagination(true)}
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              scope="col"
              aria-sort={stablecoinAriaSort}
              className={cn(
                "sticky left-0 z-10 h-11 w-[200px] min-w-[200px] border-r border-border/60 bg-card px-4 text-sm font-medium text-foreground shadow-[var(--table-sticky-column-shadow)] min-[1360px]:shadow-none",
                isStablecoinSorted &&
                  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-brand-accent",
              )}
            >
              <button
                type="button"
                onClick={() => setSort(sort === "name" ? "market-cap" : "name")}
                aria-label={
                  sort === "name"
                    ? "Stablecoin: sorted alphabetically. Click to sort by market cap"
                    : sort === "market-cap"
                      ? "Stablecoin: sorted by market cap. Click to sort alphabetically"
                      : "Sort by Stablecoin name"
                }
                className="group/sort pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-sm px-1 text-inherit transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <span>Stablecoin</span>
                {sort === "name" ? (
                  <ArrowUp className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
                ) : sort === "market-cap" ? (
                  <ArrowDown className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
                ) : (
                  <ArrowUpDown
                    className="h-3.5 w-3.5 shrink-0 opacity-35 transition-opacity group-hover/sort:opacity-75"
                    aria-hidden="true"
                  />
                )}
              </button>
            </TableHead>
            {COVERAGE_FEATURES.map((feature) => {
              const featureSortKey = COVERAGE_FEATURE_SORT_KEYS[feature.key];
              const isSorted = featureSortKey != null && sort === featureSortKey;
              const headerLabel =
                feature.shortLabel === feature.label ? (
                  feature.shortLabel
                ) : (
                  <>
                    <span aria-hidden="true">{feature.shortLabel}</span>
                    <span className="sr-only">{feature.label}</span>
                  </>
                );

              return (
                <TableHead
                  key={feature.key}
                  scope="col"
                  aria-sort={featureSortKey ? (isSorted ? "ascending" : "none") : undefined}
                  title={`${feature.label}: ${feature.description}`}
                  className={cn(
                    "h-11 px-1.5 text-sm font-medium text-foreground",
                    isSorted && "shadow-[inset_0_-2px_0_0_var(--brand-accent)]",
                  )}
                >
                  {featureSortKey ? (
                    <button
                      type="button"
                      onClick={() => setSort(isSorted ? "market-cap" : featureSortKey)}
                      aria-label={
                        isSorted
                          ? `${feature.label}: sorted weakest first. Click to sort by market cap`
                          : `Sort by ${feature.label} (weakest first)`
                      }
                      className="group/sort pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-sm px-1 text-inherit transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <span>{headerLabel}</span>
                      {isSorted ? (
                        <ArrowUp className="h-3 w-3 shrink-0 text-foreground" aria-hidden="true" />
                      ) : (
                        <ArrowUpDown
                          className="h-3 w-3 shrink-0 opacity-35 transition-opacity group-hover/sort:opacity-75"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : (
                    headerLabel
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <Fragment key={row.id}>
              <TableRow rowIntent="scan" className="group">
                <TableHead
                  scope="row"
                  className="sticky left-0 z-1 h-auto w-[200px] min-w-[200px] max-w-[200px] whitespace-normal border-r border-border/60 bg-card px-4 py-2.5 text-left font-normal text-foreground shadow-[var(--table-sticky-column-shadow)] transition-colors group-hover:bg-[var(--table-row-hover)] min-[1360px]:shadow-none"
                >
                  <CoverageCoinIdentity row={row} logoSrc={logos?.[row.id]} logoSize={24} linked />
                </TableHead>
                {COVERAGE_FEATURES.map((feature) => (
                  <TableCell key={feature.key} className="px-1.5 py-2.5 align-middle">
                    <CoverageBadge status={row.statuses[feature.key]} compact />
                  </TableCell>
                ))}
              </TableRow>
            </Fragment>
          ))}
        </TableBody>
      </TableFrame>
      <div className="@5xl:hidden">
        <ul className="space-y-3">
          {pageRows.map((row) => (
            <li key={row.id} className="[contain-intrinsic-size:auto_220px] [content-visibility:auto]">
              <CoverageMobileCard row={row} logoSrc={logos?.[row.id]} />
            </li>
          ))}
        </ul>
        <div className="pharos-card-shell mt-3 overflow-hidden">{renderPagination(false)}</div>
      </div>
    </div>
  );
}

export function CoverageMatrixCard(model: CoverageMatrixCardProps) {
  const [tierGroup, featureGroup, gapGroup] = getCoverageMatrixFilterGroups();
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const unavailableFeatureLabels = model.unavailableFeatures
    .map((key) => COVERAGE_FEATURES.find((feature) => feature.key === key)?.shortLabel ?? key)
    .join(", ");

  return (
    <section
      id="coverage-matrix"
      aria-labelledby="coverage-matrix-heading"
      className="@container scroll-mt-[var(--table-header-top,4rem)] space-y-3"
    >
      <div className="pharos-table-toolbar rounded-xl border border-border/60">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
          <div className="min-w-0 space-y-1">
            <p className="pharos-label">Coverage matrix</p>
            <h2 id="coverage-matrix-heading" className="pharos-section-title">
              Check a specific coin
            </h2>
            <p className="pharos-meta max-w-3xl">
              Available counts any data for a surface; headline counts apply stricter depth or live-feed thresholds.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="hidden @5xl:inline min-[1360px]:hidden">
              Scroll sideways for all 12 features
            </span>
            {model.dataAsOfMs ? (
              <span className="pharos-numeric" suppressHydrationWarning>
                Updated {new Date(model.dataAsOfMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
            <div role="group" aria-label="Coverage tier presets" className="pharos-segmented w-fit">
              {tierGroup.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={model.filter === option.key}
                  aria-controls="coverage-results"
                  onClick={() => model.setFilter(option.key)}
                  className="pharos-focus-ring pharos-segmented-item min-h-11 sm:min-h-8"
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <FilterSearchInput
                value={model.search}
                onValueChange={model.setSearch}
                placeholder="Search stablecoin or ticker"
                className="relative w-full"
                inputClassName="h-11 rounded-md border-border/65 bg-background/45 pl-9 pr-9 text-sm sm:h-9"
                ariaLabel="Search stablecoin coverage table"
              />
              {model.search ? (
                <button
                  type="button"
                  onClick={() => model.setSearch("")}
                  aria-label="Clear search"
                  className="pharos-focus-ring absolute right-1.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground sm:h-6 sm:w-6"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="pharos-label shrink-0">Sort</span>
            <select
              value={model.sort}
              onChange={(event) => model.setSort(event.target.value as CoverageMatrixSortKey)}
              className="pharos-focus-ring h-11 rounded-md border border-border/65 bg-background/45 px-3 text-sm text-foreground transition-colors hover:border-foreground/20 sm:h-9"
              aria-label="Sort coverage table"
            >
              {COVERAGE_MATRIX_SORT_OPTIONS.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        <div aria-label="Coverage filters" className="space-y-2 border-t border-border/50 pt-2.5">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="pharos-label w-16 shrink-0">Has</span>
            <div role="group" aria-label="Filter by covered features" className="flex flex-wrap items-center gap-1.5">
              {featureGroup.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={model.filter === option.key}
                  aria-controls="coverage-results"
                  onClick={() => model.setFilter(option.key)}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill min-h-11 px-2.5 py-1 text-xs font-medium sm:h-7 sm:min-h-0",
                    model.filter === option.key
                      ? "pharos-control-pill-active"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="pharos-label w-16 shrink-0">Missing</span>
            <div role="group" aria-label="Filter by missing features" className="flex flex-wrap items-center gap-1.5">
              {gapGroup.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={model.filter === option.key}
                  aria-controls="coverage-results"
                  onClick={() => model.setFilter(option.key)}
                  className={cn(
                    "pharos-focus-ring pharos-control-pill min-h-11 px-2.5 py-1 text-xs font-medium sm:h-7 sm:min-h-0",
                    model.filter === option.key
                      ? "pharos-control-pill-active"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pharos-subtle-band">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <span aria-live="polite" className="font-medium text-foreground">
              Showing <span className="pharos-numeric">{model.filteredRows.length}</span> of{" "}
              <span className="pharos-numeric">{model.rows.length}</span> active coins.
            </span>
            <span aria-hidden="true" className="text-border">·</span>
            <CoverageLensSummary
              rows={model.rows}
              filteredRows={model.filteredRows}
              search={model.search}
              filter={model.filter}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {model.hasActiveFilters ? (
              <button
                type="button"
                onClick={model.resetFilters}
                className="pharos-focus-ring inline-flex min-h-11 items-center rounded-md px-2 py-1 text-xs font-medium text-foreground underline-offset-4 hover:underline sm:min-h-8"
              >
                Reset
              </button>
            ) : null}
            <button
              type="button"
              aria-expanded={isLegendOpen}
              aria-controls="coverage-status-legend"
              onClick={() => setIsLegendOpen((open) => !open)}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-8"
            >
              <span>Status legend</span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                  isLegendOpen && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div
          id="coverage-status-legend"
          hidden={!isLegendOpen}
          className="mt-3 space-y-5 border-t border-border/60 pt-4"
        >
          {getLegendGroups().map((group) => (
            <div key={group.label}>
              <p className="pharos-label mb-2">
                {group.label}
              </p>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {group.items.map((item) => (
                  <div key={item.term} className="pharos-inset px-3 py-3">
                    <dt className="text-sm font-semibold text-foreground">{item.term}</dt>
                    <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>

      {model.unavailableFeatures.length > 0 ? (
        <div
          role="status"
          className="rounded-lg border border-state-warn bg-state-warn-subtle px-4 py-3 text-sm leading-relaxed text-state-warn-strong"
        >
          Some feature feeds are unavailable, so affected cells are marked Data n/a, or Checking for reserve sync,
          instead of being counted as coverage gaps: {unavailableFeatureLabels}.
        </div>
      ) : null}

      <div id="coverage-results" className="space-y-4">
        {model.filteredRows.length === 0 ? (
          <div className="pharos-empty-note px-4 py-10 text-center">
            <SearchX className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <p className="mt-4 text-sm font-medium text-foreground">No stablecoins match your search or filters.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try adjusting your filters or search for popular stablecoins like USDT, USDC, or DAI.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {["USDT", "USDC", "DAI", "USDe"].map((ticker) => (
                <button
                  key={ticker}
                  type="button"
                  onClick={() => model.setSearch(ticker)}
                  className="pharos-focus-ring pharos-control-pill min-h-11 px-3 text-xs font-medium text-foreground sm:h-8 sm:min-h-0"
                >
                  {ticker}
                </button>
              ))}
            </div>
            {model.hasActiveFilters ? (
              <button
                type="button"
                onClick={model.resetFilters}
                className="pharos-focus-ring pharos-control-pill mt-4 min-h-11 gap-1.5 px-4 text-xs font-medium text-foreground sm:h-8 sm:min-h-0"
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        ) : (
          <CoverageMatrixTable
            rows={model.filteredRows}
            totalCount={model.rows.length}
            logos={model.logos}
            sort={model.sort}
            setSort={model.setSort}
            resetKey={`${model.filter}:${model.search}:${model.sort}`}
          />
        )}
      </div>
    </section>
  );
}
