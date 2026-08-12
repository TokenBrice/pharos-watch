"use client";

import { useState } from "react";
import { ChevronDown, Search, SearchX } from "lucide-react";
import { getPricingSourceLabel } from "@shared/lib/pricing-sources";
import { CoverageLensSummary } from "@/components/coverage-lens-summary";
import { SafetyScoreDataCoverage } from "@/app/safety-scores/data-coverage-module";
import { MatrixTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { COVERAGE_FEATURES } from "@/lib/coverage";
import {
  AUTHORITATIVE_ACCENT,
  getFilterGroups,
  getLegendGroups,
  SORT_OPTIONS,
  type CoverageSortKey,
} from "@/lib/coverage-page-config";
import { cn } from "@/lib/utils";
import { CoverageBadge } from "./coverage-badge";
import { CoverageCoinIdentity } from "./coverage-coin-identity";
import { CoverageFeatureSnapshotRow, FeatureSnapshotInsight } from "./coverage-feature-snapshot";
import { CoverageMobileCard } from "./coverage-mobile-card";
import type { useCoveragePageModel } from "./use-coverage-page-model";

type CoveragePageModel = ReturnType<typeof useCoveragePageModel>;
const MOBILE_COVERAGE_BATCH_SIZE = 24;

export function CoverageMatrixDataStateCard({ state }: { state: "loading" | "error" }) {
  const isError = state === "error";

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-2">
        <p className="pharos-kicker">Coverage Matrix</p>
        <CardTitle as="h2" className="text-xl">
          {isError ? "Coverage snapshot unavailable" : "Loading coverage snapshot"}
        </CardTitle>
        <CardDescription className="max-w-3xl leading-relaxed">
          {isError
            ? "The stablecoin market snapshot is required before coverage counts can be trusted. The matrix will return when that feed recovers."
            : "Waiting for the market snapshot and feature feeds before showing coverage counts, so loading states are not mistaken for real gaps."}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-xl border border-dashed border-border/70 bg-background/30 px-4 py-8 text-sm text-muted-foreground">
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
}: Pick<
  CoveragePageModel,
  "featureSummaries" | "sourceDepthProgress" | "widestFeature" | "narrowestFeature" | "mostConcentratedFeature"
>) {
  const activeCoinTotal = featureSummaries.reduce((total, summary) => Math.max(total, summary.totalCount), 0);
  const averageCoveragePct =
    featureSummaries.length > 0
      ? featureSummaries.reduce((sum, summary) => sum + summary.coveragePct, 0) / featureSummaries.length
      : 0;

  return (
    <Card className="pharos-card-shell overflow-hidden">
      <CardHeader className="pharos-panel-header px-4 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-end">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="pharos-kicker">Coverage Overview</p>
              <CardTitle as="h2" className="pharos-display text-2xl font-bold leading-tight tracking-tight">
                Feature breadth by surface
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-border/40 pt-3">
              <div className="min-w-0">
                <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
                  {activeCoinTotal}
                </p>
                <p className="mt-1.5 pharos-kicker">
                  active coins tracked
                </p>
              </div>
              <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pb-0.5">
                <div className="flex items-baseline gap-1.5">
                  <dt className="pharos-kicker">
                    Avg. reach
                  </dt>
                  <dd className="pharos-numeric text-[15px] font-semibold leading-none text-foreground">
                    {averageCoveragePct.toFixed(0)}%
                  </dd>
                  <span className="text-[11px] text-muted-foreground">headline</span>
                </div>
                <span aria-hidden="true" className="h-3 w-px bg-border/60" />
                <div className="flex items-baseline gap-1.5">
                  <dt className="pharos-kicker">
                    Surfaces
                  </dt>
                  <dd className="pharos-numeric text-[15px] font-semibold leading-none text-foreground">
                    {featureSummaries.length}
                  </dd>
                  <span className="text-[11px] text-muted-foreground">tracked</span>
                </div>
              </dl>
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <FeatureSnapshotInsight
              label="Source target"
              accent="price"
              title="3+ sources"
              detail={
                <>
                  <span className="text-foreground">
                    {sourceDepthProgress.atTargetCount}/{sourceDepthProgress.totalCount}
                  </span>
                  <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                  {sourceDepthProgress.atTargetMcapPct == null
                    ? "n/a"
                    : `${sourceDepthProgress.atTargetMcapPct.toFixed(0)}% cap`}
                </>
              }
            />
            {widestFeature ? (
              <FeatureSnapshotInsight
                label="Widest reach"
                accent={widestFeature.feature.key}
                title={widestFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">{widestFeature.coveragePct.toFixed(0)}%</span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {widestFeature.availableCount}/{widestFeature.totalCount}
                  </>
                }
              />
            ) : null}
            {narrowestFeature ? (
              <FeatureSnapshotInsight
                label="Tightest reach"
                accent={narrowestFeature.feature.key}
                title={narrowestFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">{narrowestFeature.coveragePct.toFixed(0)}%</span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {narrowestFeature.availableCount}/{narrowestFeature.totalCount}
                  </>
                }
              />
            ) : null}
            {mostConcentratedFeature ? (
              <FeatureSnapshotInsight
                label="Cap skew"
                accent={mostConcentratedFeature.feature.key}
                title={mostConcentratedFeature.feature.shortLabel}
                detail={
                  <>
                    <span className="text-foreground">{mostConcentratedFeature.mcapSharePct?.toFixed(0) ?? "0"}%</span>
                    <span className="ml-1 text-muted-foreground/80">cap</span>
                    <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">·</span>
                    {mostConcentratedFeature.coveragePct.toFixed(0)}% count
                  </>
                }
              />
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border/55">
          {featureSummaries.map((summary) => (
            <CoverageFeatureSnapshotRow key={summary.feature.key} summary={summary} />
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
        <p className="pharos-kicker">Safety Score Coverage</p>
        <CardTitle as="h2" className="text-xl tracking-tight">
          Score input coverage
        </CardTitle>
        <CardDescription className="max-w-3xl leading-relaxed">
          What the current Safety Score publication evaluated, and which inputs remain open.
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

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-2">
        <p className="pharos-kicker">Pricing Sources</p>
        <CardTitle as="h2" className="text-xl tracking-tight">
          Where Pharos gets its prices
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Each stablecoin price is derived from multi-source consensus. These are the providers feeding the pipeline and
          how many coins each one covers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {pricingSources.map((source) => (
            <div
              key={source.name}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-background/40 px-4 py-4"
            >
              <span className="text-sm font-semibold text-foreground">{getPricingSourceLabel(source.name)}</span>
              <span className="pharos-numeric text-2xl font-semibold text-foreground">{source.count}</span>
              <span className="text-[11px] text-muted-foreground">coins</span>
            </div>
          ))}
        </div>

        {authoritativeSources.length > 0 ? (
          <div className={cn("space-y-3 rounded-xl border p-4", AUTHORITATIVE_ACCENT.container)}>
            <div className="flex items-center gap-2">
              <p className="pharos-kicker">Authoritative Overrides</p>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  AUTHORITATIVE_ACCENT.badge,
                )}
              >
                Protocol
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Direct issuer or protocol pricing that supersedes market sources for specific assets.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {authoritativeSources.map((source) => (
                <div
                  key={source.name}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border px-4 py-4",
                    AUTHORITATIVE_ACCENT.card,
                  )}
                >
                  <span className={cn("text-sm font-semibold", AUTHORITATIVE_ACCENT.cardLabel)}>
                    {getPricingSourceLabel(source.name)}
                  </span>
                  <span className="pharos-numeric text-2xl font-semibold text-foreground">{source.count}</span>
                  <span className="text-[11px] text-muted-foreground">coins</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CoverageMatrixCard(
  model: Pick<
    CoveragePageModel,
    | "logos"
    | "rows"
    | "filter"
    | "setFilter"
    | "sort"
    | "setSort"
    | "search"
    | "setSearch"
    | "filteredRows"
    | "hasActiveFilters"
    | "resetFilters"
    | "unavailableFeatures"
    | "dataUpdatedAt"
  >,
) {
  const isMobileLayout = useIsMobile(768);
  const filterGroups = getFilterGroups();
  const unavailableFeatureLabels = model.unavailableFeatures
    .map((key) => COVERAGE_FEATURES.find((feature) => feature.key === key)?.shortLabel ?? key)
    .join(", ");

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="pharos-kicker">Coverage Matrix</p>
            {model.dataUpdatedAt ? (
              <span className="text-xs text-muted-foreground">
                Updated {new Date(model.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : null}
          </div>
          <CardTitle as="h2" className="text-xl">
            Check a specific coin
          </CardTitle>
          <CardDescription className="max-w-3xl leading-relaxed">
            Search, filter, and inspect one asset at a time. The desktop table keeps the full comparison view; mobile
            cards show the highest-signal states first. Available counts all coins with any data for a feature. Headline
            counts apply stricter thresholds — for example, pricing requires three or more independent sources, and
            reserve coverage requires live composition feeds.
          </CardDescription>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={model.search}
                onChange={(event) => model.setSearch(event.target.value)}
                placeholder="Search stablecoin or ticker"
                className="h-11 rounded-lg border-border/65 bg-background/45 pl-10 sm:h-10"
                aria-label="Search stablecoin coverage table"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="shrink-0">Sort</span>
              <select
                value={model.sort}
                onChange={(event) => model.setSort(event.target.value as CoverageSortKey)}
                className="pharos-focus-ring h-11 rounded-full border border-border/65 bg-background/45 px-4 text-sm text-foreground transition-colors hover:border-foreground/20 sm:h-10"
                aria-label="Sort coverage table"
              >
                {SORT_OPTIONS.map((group) => (
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

          <div aria-label="Coverage filters" className="flex flex-wrap items-center gap-2">
            {filterGroups.map((group, groupIndex) => (
              <div
                key={groupIndex}
                className={cn(
                  "flex flex-wrap items-center gap-2",
                  groupIndex < filterGroups.length - 1 && "border-r border-border/40 pr-2 mr-1",
                )}
              >
                {group.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={model.filter === option.key}
                    aria-controls="coverage-results"
                    onClick={() => model.setFilter(option.key)}
                    className={cn(
                      "pharos-focus-ring pharos-control-pill min-h-11 px-3 text-xs font-medium sm:h-8 sm:min-h-0",
                      model.filter === option.key
                        ? "pharos-control-pill-active"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            Showing {model.filteredRows.length} of {model.rows.length} active coins.
          </span>
          {model.hasActiveFilters ? (
            <button
              type="button"
              onClick={model.resetFilters}
              className="pharos-focus-ring min-h-11 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:text-foreground sm:min-h-0"
            >
              Reset search and filters
            </button>
          ) : null}
        </div>

        <CoverageLensSummary
          rows={model.rows}
          filteredRows={model.filteredRows}
          search={model.search}
          filter={model.filter}
        />

        {model.unavailableFeatures.length > 0 ? (
          <div
            role="status"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-800 dark:text-amber-200"
          >
            Some feature feeds are unavailable, so affected cells are marked Data n/a, or Checking for reserve sync,
            instead of being counted as coverage gaps: {unavailableFeatureLabels}.
          </div>
        ) : null}

        <details className="group rounded-xl border border-border/60 bg-background/35">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <span>Status legend</span>
            <ChevronDown
              className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-5 border-t border-border/60 px-4 py-4">
            {getLegendGroups().map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {group.items.map((item) => (
                    <div key={item.term} className="rounded-xl border border-border/60 bg-background/45 px-3 py-3">
                      <dt className="text-sm font-semibold text-foreground">{item.term}</dt>
                      <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.description}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </details>
      </CardHeader>

      <CardContent id="coverage-results" className="space-y-4">
        {model.filteredRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/30 px-4 py-10 text-center">
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
                  className="pharos-focus-ring min-h-11 rounded-full border border-border/60 bg-background/60 px-3 text-xs font-medium text-foreground hover:bg-accent sm:h-8 sm:min-h-0"
                >
                  {ticker}
                </button>
              ))}
            </div>
            {model.hasActiveFilters ? (
              <button
                type="button"
                onClick={model.resetFilters}
                className="pharos-focus-ring mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-foreground hover:bg-accent sm:min-h-0"
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {isMobileLayout ? (
              <CoverageMobileResults
                key={`${model.filter}:${model.search}:${model.sort}`}
                rows={model.filteredRows}
                logos={model.logos}
              />
            ) : (
              <MatrixTable
                tableId="coverage-matrix"
                testId="coverage-matrix-table"
                caption={`Per-coin feature availability across ${model.rows.length} active stablecoins.`}
                captionClassName="sr-only"
                chrome="bare"
                className="hidden overflow-hidden rounded-xl border border-border/70 bg-background/30 md:block"
                tableClassName="min-w-[64rem] table-fixed"
                viewportClassName="overflow-auto"
                viewportProps={{
                  compactBottomPadding: false,
                  horizontal: false,
                  mobileScrollHint: false,
                  overscrollX: false,
                  scrollShadow: false,
                }}
              >
                <TableHeader className="bg-muted/22 [&_tr]:border-border/70">
                  <TableRow className="hover:bg-transparent">
                    <TableHead
                      scope="col"
                      className="sticky left-0 z-20 h-11 w-[200px] bg-muted/22 px-4 text-sm font-medium text-foreground"
                    >
                      Stablecoin
                    </TableHead>
                    {COVERAGE_FEATURES.map((feature) => (
                      <TableHead key={feature.key} scope="col" className="h-11 text-sm font-medium text-foreground">
                        <span>{feature.shortLabel}</span>
                        <span className="sr-only">
                          : {feature.label}. {feature.description}
                        </span>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.filteredRows.map((row, index) => {
                    const stripeClass = index % 2 === 0 ? "bg-background/10" : "bg-muted/6";

                    return (
                      <TableRow key={row.id} className={cn("group", stripeClass)}>
                        <TableHead
                          scope="row"
                          className={cn(
                            "sticky left-0 z-10 h-auto w-[200px] max-w-[200px] whitespace-normal px-4 py-3 text-left font-normal text-foreground group-hover:bg-muted/30",
                            stripeClass,
                          )}
                        >
                          <CoverageCoinIdentity row={row} logoSrc={model.logos?.[row.id]} logoSize={24} linked />
                        </TableHead>
                        {COVERAGE_FEATURES.map((feature) => (
                          <TableCell key={feature.key} className="pb-2 pt-3 align-top">
                            <CoverageBadge status={row.statuses[feature.key]} />
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </MatrixTable>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function CoverageMobileResults({
  rows,
  logos,
}: {
  rows: CoveragePageModel["filteredRows"];
  logos: CoveragePageModel["logos"];
}) {
  const [visibleCount, setVisibleCount] = useState(MOBILE_COVERAGE_BATCH_SIZE);
  const visibleRows = rows.slice(0, visibleCount);
  const hasMoreRows = visibleCount < rows.length;

  return (
    <div className="space-y-3 md:hidden">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          Showing {visibleRows.length} of {rows.length} matching coins
        </span>
        {visibleCount > MOBILE_COVERAGE_BATCH_SIZE ? (
          <button
            type="button"
            onClick={() => setVisibleCount(MOBILE_COVERAGE_BATCH_SIZE)}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full px-3 font-medium text-foreground hover:bg-accent"
          >
            Collapse
          </button>
        ) : null}
      </div>
      {visibleRows.map((row) => (
        <CoverageMobileCard key={row.id} row={row} logoSrc={logos?.[row.id]} />
      ))}
      {hasMoreRows ? (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => Math.min(count + MOBILE_COVERAGE_BATCH_SIZE, rows.length))}
          className="pharos-focus-ring flex min-h-11 w-full items-center justify-center rounded-xl border border-border/70 bg-background/55 px-4 py-3 text-sm font-medium text-foreground hover:bg-accent"
        >
          Show next {Math.min(MOBILE_COVERAGE_BATCH_SIZE, rows.length - visibleCount)} coins
        </button>
      ) : null}
    </div>
  );
}
