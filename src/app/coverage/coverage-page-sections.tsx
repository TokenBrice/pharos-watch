"use client";

import Link from "next/link";
import { ChevronDown, Search, SearchX } from "lucide-react";
import { formatCurrency } from "@shared/lib/format";
import { getPricingSourceLabel } from "@shared/lib/pricing-sources";
import { CoverageLensSummary } from "@/components/coverage-lens-summary";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { COVERAGE_FEATURES } from "@/lib/coverage";
import {
  AUTHORITATIVE_ACCENT,
  FILTER_OPTIONS,
  LEGEND_ITEMS,
  type CoverageSortKey,
} from "@/lib/coverage-page-config";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { CoverageBadge } from "./coverage-badge";
import { CoverageFeatureSnapshotRow, FeatureSnapshotInsight } from "./coverage-feature-snapshot";
import { CoverageMobileCard } from "./coverage-mobile-card";
import type { useCoveragePageModel } from "./use-coverage-page-model";

type CoveragePageModel = ReturnType<typeof useCoveragePageModel>;

export function CoverageFeatureSnapshotCard({
  featureSummaries,
  widestFeature,
  narrowestFeature,
  mostConcentratedFeature,
  totalRows,
}: Pick<
  CoveragePageModel,
  "featureSummaries" | "widestFeature" | "narrowestFeature" | "mostConcentratedFeature"
> & { totalRows: number }) {
  return (
    <Card className="rounded-[1.6rem] border border-border/70 bg-card/85 shadow-[0_18px_44px_oklch(0_0_0_/0.14)]">
      <CardHeader className="space-y-5">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Feature Snapshot</p>
          <CardTitle as="h2" className="text-2xl tracking-tight">
            Start with the breadth, not the coin list
          </CardTitle>
          <CardDescription className="leading-relaxed">
            Count coverage shows how wide each Pharos surface reaches. Market-cap share shows
            whether that coverage is spread across the field or concentrated in the majors.
          </CardDescription>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          {widestFeature ? (
            <FeatureSnapshotInsight
              label="Widest today"
              accent={widestFeature.feature.key}
              title={widestFeature.feature.label}
              detail={<>Reaches {widestFeature.coveragePct.toFixed(0)}% of tracked coins.</>}
            />
          ) : null}
          {narrowestFeature ? (
            <FeatureSnapshotInsight
              label="Narrowest today"
              accent={narrowestFeature.feature.key}
              title={narrowestFeature.feature.label}
              detail={<>Reaches {narrowestFeature.coveragePct.toFixed(0)}% of tracked coins.</>}
            />
          ) : null}
          {mostConcentratedFeature ? (
            <FeatureSnapshotInsight
              label="Major-heavy"
              accent={mostConcentratedFeature.feature.key}
              title={mostConcentratedFeature.feature.label}
              detail={
                <>
                  Reaches {mostConcentratedFeature.mcapSharePct?.toFixed(0) ?? "0"}% of tracked
                  market cap with only {mostConcentratedFeature.coveragePct.toFixed(0)}% coin
                  coverage.
                </>
              }
            />
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-3">
          {featureSummaries.map((summary) => (
            <CoverageFeatureSnapshotRow key={summary.feature.key} summary={summary} totalRows={totalRows} />
          ))}
        </ul>
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
    <Card className="rounded-[1.6rem] border border-border/70 bg-card/85 shadow-[0_18px_44px_oklch(0_0_0_/0.14)]">
      <CardHeader className="space-y-2">
        <p className="pharos-kicker">Pricing Sources</p>
        <CardTitle as="h2" className="text-xl tracking-tight">
          Where Pharos gets its prices
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Each stablecoin price is derived from multi-source consensus. These are the providers
          feeding the pipeline and how many coins each one covers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {pricingSources.map((source) => (
            <div
              key={source.name}
              className="flex flex-col items-center gap-1.5 rounded-[1.15rem] border border-border/60 bg-background/40 px-4 py-4"
            >
              <span className="text-sm font-semibold text-foreground">
                {getPricingSourceLabel(source.name)}
              </span>
              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                {source.count}
              </span>
              <span className="text-[11px] text-muted-foreground">coins</span>
            </div>
          ))}
        </div>

        {authoritativeSources.length > 0 ? (
          <div className={cn("space-y-3 rounded-xl border p-4", AUTHORITATIVE_ACCENT.container)}>
            <div className="flex items-center gap-2">
              <p className="pharos-kicker">Authoritative Overrides</p>
              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", AUTHORITATIVE_ACCENT.badge)}>
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
                  className={cn("flex flex-col items-center gap-1.5 rounded-xl border px-4 py-4", AUTHORITATIVE_ACCENT.card)}
                >
                  <span className={cn("text-sm font-semibold", AUTHORITATIVE_ACCENT.cardLabel)}>
                    {getPricingSourceLabel(source.name)}
                  </span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {source.count}
                  </span>
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

export function CoverageMatrixCard(model: Pick<
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
>) {
  return (
    <Card className="rounded-[1.45rem] border border-border/70 bg-card/80">
      <CardHeader className="space-y-4">
        <div className="space-y-2">
          <p className="pharos-kicker">Coverage Matrix</p>
          <CardTitle as="h2" className="text-xl">
            Check a specific coin
          </CardTitle>
          <CardDescription className="max-w-3xl leading-relaxed">
            Search, filter, and inspect one asset at a time. The desktop table keeps the full
            comparison view; mobile cards show the highest-signal states first.
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
                className="h-10 rounded-2xl border-border/65 bg-background/45 pl-10"
                aria-label="Search stablecoin coverage table"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="shrink-0">Sort</span>
              <select
                value={model.sort}
                onChange={(event) => model.setSort(event.target.value as CoverageSortKey)}
                className="pharos-focus-ring h-10 rounded-2xl border border-border/65 bg-background/45 px-3 text-sm text-foreground transition-colors"
                aria-label="Sort coverage table"
              >
                <option value="market-cap">Market cap</option>
                <option value="most-covered">Most covered</option>
                <option value="name">Alphabetical</option>
              </select>
            </label>
          </div>

          <div aria-label="Coverage filters" className="flex flex-wrap items-center gap-2">
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={model.filter === option.key}
                aria-controls="coverage-results"
                onClick={() => model.setFilter(option.key)}
                className={cn(
                  "pharos-focus-ring h-8 rounded-full border px-3 text-xs font-medium transition-colors",
                  model.filter === option.key
                    ? "border-frost-blue/50 bg-frost-blue/12 text-foreground"
                    : "border-border/60 bg-background/45 text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            Showing {model.filteredRows.length} of {model.rows.length} tracked coins.
          </span>
          {model.hasActiveFilters ? (
            <button
              type="button"
              onClick={model.resetFilters}
              className="pharos-focus-ring rounded-md px-2 py-1 text-xs font-medium text-foreground hover:text-foreground"
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

        <details className="group rounded-2xl border border-border/60 bg-background/35">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <span>Status legend</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <dl className="grid gap-3 border-t border-border/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
            {LEGEND_ITEMS.map((item) => (
              <div key={item.term} className="rounded-xl border border-border/60 bg-background/45 px-3 py-3">
                <dt className="text-sm font-semibold text-foreground">{item.term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </CardHeader>

      <CardContent id="coverage-results" className="space-y-4">
        {model.filteredRows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/30 px-4 py-10 text-center">
            <SearchX className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <p className="mt-4 text-sm font-medium text-foreground">
              No stablecoins match your search or filters.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try adjusting your filters or search for popular stablecoins like USDT, USDC, or DAI.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {["USDT", "USDC", "DAI", "USDe"].map((ticker) => (
                <button
                  key={ticker}
                  type="button"
                  onClick={() => model.setSearch(ticker)}
                  className="pharos-focus-ring h-8 rounded-full border border-border/60 bg-background/60 px-3 text-xs font-medium text-foreground hover:bg-accent"
                >
                  {ticker}
                </button>
              ))}
            </div>
            {model.hasActiveFilters ? (
              <button
                type="button"
                onClick={model.resetFilters}
                className="pharos-focus-ring mt-4 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-foreground hover:bg-accent"
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {model.filteredRows.map((row) => (
                <CoverageMobileCard key={row.id} row={row} logoSrc={model.logos?.[row.id]} />
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-2xl border border-border/70 bg-background/30 md:block">
              <div className="overflow-auto">
                <table className="min-w-[68rem] w-full caption-bottom text-sm">
                  <TableCaption className="sr-only">
                    Per-coin feature availability across {model.rows.length} tracked stablecoins.
                  </TableCaption>
                  <TableHeader className="bg-muted/22 [&_tr]:border-border/70">
                    <TableRow className="hover:bg-transparent">
                      <TableHead
                        scope="col"
                        className="sticky left-0 z-20 h-11 bg-muted/22 px-4 text-sm font-medium text-foreground"
                      >
                        Stablecoin
                      </TableHead>
                      {COVERAGE_FEATURES.map((feature) => (
                        <TableHead key={feature.key} scope="col" className="h-11 text-sm font-medium text-foreground">
                          <span>{feature.shortLabel}</span>
                          <span className="sr-only">: {feature.label}. {feature.description}</span>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {model.filteredRows.map((row, index) => {
                      const stripeClass = index % 2 === 0 ? "bg-background/10" : "bg-muted/6";

                      return (
                        <TableRow key={row.id} className={cn("group", stripeClass)}>
                          <TableCell
                            className={cn(
                              "sticky left-0 z-10 whitespace-normal px-4 py-3 group-hover:bg-muted/30",
                              stripeClass,
                            )}
                          >
                            <Link
                              href={buildStablecoinUrl(row.id)}
                              className="pharos-focus-ring inline-flex w-full min-w-0 items-center gap-2 rounded-lg"
                            >
                              <StablecoinLogo src={model.logos?.[row.id]} name={row.name} size={24} />
                              <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="text-sm font-medium text-foreground">
                                    {row.symbol}
                                  </span>
                                  <span className="truncate text-xs text-muted-foreground xl:text-sm">
                                    {row.name}
                                  </span>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                                  <span className="font-mono tabular-nums text-foreground">
                                    {row.marketCapUsd > 0 ? formatCurrency(row.marketCapUsd) : "Mcap —"}
                                  </span>
                                  <span aria-hidden>·</span>
                                  <span>{row.pegLabel}</span>
                                  <span aria-hidden>·</span>
                                  <span>{row.backingLabel}</span>
                                  <span aria-hidden>·</span>
                                  <span>{row.governanceLabel}</span>
                                </div>
                              </div>
                            </Link>
                          </TableCell>
                          {COVERAGE_FEATURES.map((feature) => (
                            <TableCell key={feature.key} className="pb-2 pt-3 align-top">
                              <CoverageBadge status={row.statuses[feature.key]} />
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
