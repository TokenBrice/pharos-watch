"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Search,
  TableProperties,
} from "lucide-react";
import { formatCurrency } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StaleDataBanner } from "@/components/stale-data-banner";
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
import {
  type CoverageFeatureDefinition,
  type CoverageFeatureKey,
  type CoverageFeatureSummary,
  type CoverageRow,
  type CoverageStatus,
  COVERAGE_BADGE_TONE_CLASS,
  COVERAGE_FEATURES,
} from "@/lib/coverage";
import { useCoverageMatrixModel } from "@/hooks/use-coverage-matrix-model";
import { useLogos } from "@/hooks/use-logos";
import {
  FEATURE_ACCENT_CLASSES,
  FEATURE_ICON,
  FILTER_OPTIONS,
  LEGEND_ITEMS,
  MOBILE_PREVIEW_FEATURES,
  type CoverageFilterKey,
  type CoverageSortKey,
} from "@/lib/coverage-page-config";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  coingecko: "CoinGecko",
  defillama: "DefiLlama",
  coinmarketcap: "CoinMarketCap",
  pyth: "Pyth Network",
  binance: "Binance",
  coinbase: "Coinbase",
  redstone: "RedStone",
  "curve-onchain": "Curve on-chain",
  "curve-oracle": "Curve oracle",
  "dex-promoted": "DEX prices",
  "defillama-contract": "DefiLlama (contract)",
  "protocol-redeem": "Protocol Redeem",
};

function buildSourceTooltip(status: CoverageStatus): string {
  if (!status.sourceNames?.length) return status.detail;

  const confidenceLabel = status.priceConfidence
    ? `${status.priceConfidence.charAt(0).toUpperCase()}${status.priceConfidence.slice(1).replace("-", " ")} confidence`
    : "";
  const sourceList = status.sourceNames
    .map((s) => SOURCE_DISPLAY_NAMES[s] ?? s)
    .join(", ");

  return confidenceLabel
    ? `${confidenceLabel} — ${sourceList}`
    : sourceList;
}

function CoverageBadge({
  status,
  compact = false,
}: {
  status: CoverageStatus;
  compact?: boolean;
}) {
  const countSuffix =
    status.sourceCount != null && status.sourceCount > 0
      ? compact
        ? ` (${status.sourceCount})`
        : ` (${status.sourceCount} sources)`
      : "";

  return (
    <span
      title={buildSourceTooltip(status)}
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.01em]",
        compact ? "min-w-[4.25rem]" : "min-w-[4.75rem]",
        COVERAGE_BADGE_TONE_CLASS[status.tone],
      )}
    >
      <span aria-hidden="true">
        {status.label}
        {countSuffix}
      </span>
      <span className="sr-only">
        {status.spokenLabel}
        {countSuffix}
      </span>
    </span>
  );
}

function CoverageFeatureLink({
  feature,
  className,
  children,
}: {
  feature: CoverageFeatureDefinition;
  className?: string;
  children: React.ReactNode;
}) {
  if (!feature.href) {
    return <span className={className}>{children}</span>;
  }

  if (feature.external) {
    return (
      <a
        href={feature.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={feature.href} className={className}>
      {children}
    </Link>
  );
}

function CoverageMobileCard({
  row,
  logoSrc,
}: {
  row: CoverageRow;
  logoSrc?: string;
}) {
  const remainingFeatures = COVERAGE_FEATURES.filter(
    (feature) => !MOBILE_PREVIEW_FEATURES.includes(feature.key),
  );

  return (
    <details className="group rounded-[1.35rem] border border-border/70 bg-background/35 open:bg-background/42">
      <summary className="pharos-focus-ring flex cursor-pointer list-none flex-col gap-4 p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <StablecoinLogo src={logoSrc} name={row.name} size={32} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">
                  {row.symbol}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {row.name}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
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
          </div>

          <div className="shrink-0 text-right">
            <div className="pharos-kicker">Covered</div>
            <div className="font-mono text-lg font-semibold text-foreground">
              {row.coverageCount}/{COVERAGE_FEATURES.length}
            </div>
            <ChevronDown
              className="ml-auto mt-2 h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </div>
        </div>

        <dl className="grid gap-2 sm:grid-cols-2">
          {MOBILE_PREVIEW_FEATURES.map((featureKey) => {
            const feature = COVERAGE_FEATURES.find((item) => item.key === featureKey)!;
            return (
              <div
                key={feature.key}
                className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/45 px-3 py-2"
              >
                <dt className="min-w-0 text-[11px] font-medium text-muted-foreground">
                  {feature.shortLabel}
                </dt>
                <dd className="shrink-0">
                  <CoverageBadge status={row.statuses[feature.key]} compact />
                </dd>
              </div>
            );
          })}
        </dl>
      </summary>

      <div className="space-y-4 border-t border-border/60 px-4 py-4">
        <dl className="grid gap-2">
          {remainingFeatures.map((feature) => (
            <div
              key={feature.key}
              className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/45 px-3 py-2"
            >
              <dt className="min-w-0 text-[11px] font-medium text-muted-foreground">
                {feature.shortLabel}
              </dt>
              <dd className="shrink-0">
                <CoverageBadge status={row.statuses[feature.key]} compact />
              </dd>
            </div>
          ))}
        </dl>

        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/55 px-4 py-2 text-sm font-medium text-foreground hover:border-foreground/20 hover:bg-accent"
        >
          Open stablecoin detail
        </Link>
      </div>
    </details>
  );
}

function CoverageFeatureSnapshotRow({
  summary,
  totalRows,
}: {
  summary: CoverageFeatureSummary;
  totalRows: number;
}) {
  const Icon = FEATURE_ICON[summary.feature.key];
  const accent = FEATURE_ACCENT_CLASSES[summary.feature.key];
  const breakdownItems = summary.breakdown.split("·").map((item) => item.trim());

  return (
    <li
      className={cn(
        "relative grid gap-4 overflow-hidden rounded-[1.15rem] border border-border/60 bg-[linear-gradient(180deg,oklch(0.985_0.006_248_/_0.98),oklch(0.95_0.008_248_/_1))] px-4 py-4 shadow-[inset_0_1px_0_oklch(1_0_0_/0.7),0_12px_28px_oklch(0_0_0_/0.05)] before:absolute before:inset-y-4 before:left-0 before:w-[2px] dark:bg-[linear-gradient(180deg,oklch(0.17_0.01_248_/_0.78),oklch(0.12_0.008_248_/_0.92))] dark:shadow-[inset_0_1px_0_oklch(1_0_0_/0.03)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)_minmax(15rem,0.9fr)]",
        accent.rail,
      )}
    >
      <div className="min-w-0">
        <CoverageFeatureLink
          feature={summary.feature}
          className={cn(
            "inline-flex min-w-0 items-center gap-2 rounded-md",
            summary.feature.href
              ? "pharos-focus-ring text-foreground hover:text-foreground"
              : "text-foreground",
          )}
        >
          <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", accent.ring)}>
            <Icon className={cn("h-4 w-4", accent.icon)} aria-hidden="true" />
          </span>
          <span className={cn("truncate text-sm font-semibold", accent.title)}>
            {summary.feature.label}
          </span>
        </CoverageFeatureLink>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {summary.feature.description}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>{summary.countLabel}</span>
            <span className="font-mono text-base font-semibold tracking-tight text-foreground">
              {summary.availableCount}/{totalRows}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted/80">
            <div
              className={cn("h-full rounded-full", accent.countBar)}
              style={{ width: `${Math.max(summary.coveragePct, 4)}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {summary.coverageLabel}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>Market Share</span>
            <span className="font-mono text-base font-semibold tracking-tight text-foreground">
              {summary.mcapSharePct == null ? "—" : `${summary.mcapSharePct.toFixed(0)}%`}
            </span>
          </div>
          <div className="h-2 rounded-full bg-frost-blue/12">
            <div
              className="h-full rounded-full bg-frost-blue/75"
              style={{ width: `${Math.max(summary.mcapSharePct ?? 0, 4)}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {summary.shareLabel}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 px-3 py-3">
        <div className="pharos-kicker">Breakdown</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {breakdownItems.map((item, index) => (
            <span
              key={`${summary.feature.key}-${item}`}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                index === 0
                  ? accent.chip
                  : "border-border/60 bg-background/45 text-muted-foreground",
              )}
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

function FeatureSnapshotInsight({
  label,
  title,
  detail,
  accent,
}: {
  label: string;
  title: React.ReactNode;
  detail: React.ReactNode;
  accent: CoverageFeatureKey;
}) {
  const accentClasses = FEATURE_ACCENT_CLASSES[accent];

  return (
    <div
      className={cn(
        "space-y-2 rounded-[1rem] border px-4 py-4",
        accentClasses.tile,
      )}
    >
      <div className="pharos-kicker">{label}</div>
      <div className={cn("text-base font-semibold leading-tight", accentClasses.title)}>
        {title}
      </div>
      <div className="text-sm leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}

function matchesFilter(row: CoverageRow, filter: CoverageFilterKey): boolean {
  switch (filter) {
    case "live-reserves":
      return row.statuses.reserves.kind === "live";
    case "yield":
      return row.statuses.yield.available;
    case "flows":
      return row.statuses.flows.available;
    case "blacklist":
      return row.statuses.blacklist.available;
    default:
      return true;
  }
}

function sortRows(rows: CoverageRow[], sort: CoverageSortKey): CoverageRow[] {
  const cloned = [...rows];
  if (sort === "name") {
    return cloned.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (sort === "most-covered") {
    return cloned.sort((left, right) => {
      if (right.coverageCount !== left.coverageCount) {
        return right.coverageCount - left.coverageCount;
      }
      if (right.advancedCoverageCount !== left.advancedCoverageCount) {
        return right.advancedCoverageCount - left.advancedCoverageCount;
      }
      return right.marketCapUsd - left.marketCapUsd;
    });
  }
  return cloned.sort((left, right) => {
    if (right.marketCapUsd !== left.marketCapUsd) {
      return right.marketCapUsd - left.marketCapUsd;
    }
    return left.name.localeCompare(right.name);
  });
}

export default function CoveragePageClient() {
  const [filter, setFilter] = useState<CoverageFilterKey>("all");
  const [sort, setSort] = useState<CoverageSortKey>("market-cap");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const { data: logos } = useLogos();
  const {
    rows,
    featureSummaries,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    staleQueries,
  } = useCoverageMatrixModel();

  const filteredRows = useMemo(
    () =>
      sortRows(
        rows.filter((row) => {
          if (!matchesFilter(row, filter)) return false;
          if (!deferredSearch) return true;
          return (
            row.name.toLowerCase().includes(deferredSearch) ||
            row.symbol.toLowerCase().includes(deferredSearch)
          );
        }),
        sort,
      ),
    [deferredSearch, filter, rows, sort],
  );

  const hasActiveFilters = filter !== "all" || search.trim().length > 0;

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={staleQueries} />

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
                detail={
                  <>
                    Reaches {widestFeature.coveragePct.toFixed(0)}% of tracked coins.
                  </>
                }
              />
            ) : null}
            {narrowestFeature ? (
              <FeatureSnapshotInsight
                label="Narrowest today"
                accent={narrowestFeature.feature.key}
                title={narrowestFeature.feature.label}
                detail={
                  <>
                    Reaches {narrowestFeature.coveragePct.toFixed(0)}% of tracked coins.
                  </>
                }
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
              <CoverageFeatureSnapshotRow
                key={summary.feature.key}
                summary={summary}
                totalRows={rows.length}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {pricingSources.length > 0 && (
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
              {pricingSources.map((src) => (
                <div
                  key={src.name}
                  className="flex flex-col items-center gap-1.5 rounded-[1.15rem] border border-border/60 bg-background/40 px-4 py-4"
                >
                  <span className="text-sm font-semibold text-foreground">
                    {SOURCE_DISPLAY_NAMES[src.name] ?? src.name}
                  </span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {src.count}
                  </span>
                  <span className="text-[11px] text-muted-foreground">coins</span>
                </div>
              ))}
            </div>

            {authoritativeSources.length > 0 && (
              <div className="space-y-3">
                <p className="pharos-kicker">Authoritative Overrides</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {authoritativeSources.map((src) => (
                    <div
                      key={src.name}
                      className="flex flex-col items-center gap-1.5 rounded-[1.15rem] border border-violet-500/20 bg-violet-500/5 px-4 py-4"
                    >
                      <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">
                        {SOURCE_DISPLAY_NAMES[src.name] ?? src.name}
                      </span>
                      <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                        {src.count}
                      </span>
                      <span className="text-[11px] text-muted-foreground">coins</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative min-w-0 flex-1 xl:max-w-sm">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search stablecoin or ticker"
                className="h-11 rounded-2xl border-border/65 bg-background/45 pl-10"
                aria-label="Search stablecoin coverage table"
              />
            </div>

            <div
              role="toolbar"
              aria-label="Coverage filters"
              className="flex flex-wrap items-center gap-2"
            >
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={filter === option.key}
                  aria-controls="coverage-results"
                  onClick={() => setFilter(option.key)}
                  className={cn(
                    "pharos-focus-ring min-h-11 rounded-full border px-3 py-2 text-xs font-medium transition-colors sm:min-h-0",
                    filter === option.key
                      ? "border-frost-blue/50 bg-frost-blue/12 text-foreground"
                      : "border-border/60 bg-background/45 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="shrink-0">Sort</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as CoverageSortKey)}
                className="h-11 rounded-2xl border border-border/65 bg-background/45 px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-10"
                aria-label="Sort coverage table"
              >
                <option value="market-cap">Market cap</option>
                <option value="most-covered">Most covered</option>
                <option value="name">Alphabetical</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span aria-live="polite">
              Showing {filteredRows.length} of {rows.length} tracked coins.
            </span>
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
                className="pharos-focus-ring rounded-md px-2 py-1 text-xs font-medium text-foreground hover:text-foreground"
              >
                Reset search and filters
              </button>
            ) : null}
          </div>

          <details className="group rounded-2xl border border-border/60 bg-background/35">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span>Status legend</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="grid gap-3 border-t border-border/60 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
              {LEGEND_ITEMS.map((item) => (
                <div key={item.term} className="rounded-xl border border-border/60 bg-background/45 px-3 py-3">
                  <dt className="text-sm font-semibold text-foreground">{item.term}</dt>
                  <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </dd>
                </div>
              ))}
            </div>
          </details>
        </CardHeader>

        <CardContent id="coverage-results" className="space-y-4">
          {filteredRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-background/30 px-4 py-10 text-center">
              <TableProperties className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="mt-4 text-sm font-medium text-foreground">
                No stablecoins match the current search and filter set.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the search input or switch back to All coins.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {filteredRows.map((row) => (
                  <CoverageMobileCard key={row.id} row={row} logoSrc={logos?.[row.id]} />
                ))}
              </div>

              <div className="hidden overflow-hidden rounded-2xl border border-border/70 bg-background/30 md:block">
                <div className="overflow-auto">
                  <table className="min-w-[76rem] w-full caption-bottom text-sm">
                    <TableCaption className="sr-only">
                      Per-coin feature availability across {rows.length} tracked stablecoins.
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
                          <TableHead
                            key={feature.key}
                            scope="col"
                            className="h-11 text-sm font-medium text-foreground"
                          >
                            <span>{feature.label}</span>
                            <span className="sr-only">. {feature.description}</span>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRows.map((row, index) => {
                        const stripeClass =
                          index % 2 === 0 ? "bg-background/10" : "bg-muted/6";

                        return (
                          <TableRow
                            key={row.id}
                            className={cn("group", stripeClass)}
                          >
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
                                <StablecoinLogo src={logos?.[row.id]} name={row.name} size={24} />
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
                                      {row.marketCapUsd > 0
                                        ? formatCurrency(row.marketCapUsd)
                                        : "Mcap —"}
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
                              <TableCell
                                key={feature.key}
                                className="pb-2 pt-3 align-top"
                              >
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
    </div>
  );
}
