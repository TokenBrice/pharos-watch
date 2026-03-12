"use client";

import { useDeferredValue, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpDown,
  BadgeCheck,
  Droplets,
  Landmark,
  Network,
  Search,
  ShieldBan,
  ShieldCheck,
  TableProperties,
  TrendingUp,
} from "lucide-react";
import { formatCurrency } from "@shared/lib/format";
import { getCirculatingRaw } from "@shared/lib/supply";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useReportCards } from "@/hooks/use-report-cards";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useYieldRankings } from "@/hooks/use-yield-rankings";
import {
  buildCoverageRow,
  COVERAGE_FEATURES,
  type CoverageFeatureDefinition,
  type CoverageFeatureKey,
  type CoverageRow,
  type CoverageStatus,
} from "@/lib/coverage";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

type CoverageFilterKey =
  | "all"
  | "live-reserves"
  | "yield"
  | "flows"
  | "blacklist"
  | "bluechip";

type CoverageSortKey = "market-cap" | "name" | "most-covered";

const BADGE_TONE_CLASS: Record<CoverageStatus["tone"], string> = {
  emerald:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  amber:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  violet:
    "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  rose: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  slate: "border-border/70 bg-muted text-muted-foreground",
};

const FEATURE_ICON: Record<CoverageFeatureKey, typeof Activity> = {
  price: Activity,
  safety: ShieldCheck,
  dex: Droplets,
  reserves: Landmark,
  yield: TrendingUp,
  flows: ArrowUpDown,
  blacklist: ShieldBan,
  bluechip: BadgeCheck,
  dependency: Network,
};

const FILTER_OPTIONS: ReadonlyArray<{
  key: CoverageFilterKey;
  label: string;
}> = [
  { key: "all", label: "All coins" },
  { key: "live-reserves", label: "Live reserves" },
  { key: "yield", label: "Yield" },
  { key: "flows", label: "Flows" },
  { key: "blacklist", label: "Blacklist" },
  { key: "bluechip", label: "Bluechip" },
] as const;

function CoverageBadge({ status }: { status: CoverageStatus }) {
  return (
    <span
      title={status.detail}
      className={cn(
        "inline-flex min-w-[4.75rem] items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.01em]",
        BADGE_TONE_CLASS[status.tone],
      )}
    >
      {status.label}
    </span>
  );
}

function CoverageSummaryCard({
  feature,
  rows,
  totalMcapUsd,
}: {
  feature: CoverageFeatureDefinition;
  rows: CoverageRow[];
  totalMcapUsd: number;
}) {
  const Icon = FEATURE_ICON[feature.key];
  const availableRows = rows.filter((row) => row.statuses[feature.key].available);
  const coveredMcapUsd = availableRows.reduce(
    (sum, row) => sum + row.marketCapUsd,
    0,
  );
  const coveragePct =
    rows.length > 0 ? (availableRows.length / rows.length) * 100 : 0;
  const mcapSharePct =
    totalMcapUsd > 0 ? (coveredMcapUsd / totalMcapUsd) * 100 : null;
  const breakdownMap = new Map<string, number>();
  for (const row of rows) {
    const kind = row.statuses[feature.key].kind;
    breakdownMap.set(kind, (breakdownMap.get(kind) ?? 0) + 1);
  }

  const breakdown =
    feature.key === "price"
      ? `tracked ${breakdownMap.get("tracked") ?? 0} · price-only ${breakdownMap.get("price-only") ?? 0}`
      : feature.key === "dex"
        ? `primary ${breakdownMap.get("primary") ?? 0} · mixed ${breakdownMap.get("mixed") ?? 0} · fallback ${breakdownMap.get("fallback") ?? 0}`
        : feature.key === "reserves"
          ? `live ${breakdownMap.get("live") ?? 0} · curated ${breakdownMap.get("curated") ?? 0} · estimated ${breakdownMap.get("estimated") ?? 0}`
          : feature.key === "flows"
            ? `full ${breakdownMap.get("full") ?? 0} · partial ${breakdownMap.get("partial-history") ?? 0} · bootstrapping ${breakdownMap.get("bootstrapping") ?? 0}`
            : feature.key === "safety"
              ? `rated ${breakdownMap.get("rated") ?? 0} · NR ${breakdownMap.get("nr") ?? 0}`
              : `${availableRows.length} covered · ${rows.length - availableRows.length} uncovered`;

  const content = (
    <Card className="rounded-2xl border-l-[3px] border-l-frost-blue/75 bg-card/85 shadow-[0_18px_40px_oklch(0_0_0_/0.12)]">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="pharos-kicker">Coverage</p>
            <CardTitle as="div" className="text-base">
              {feature.label}
            </CardTitle>
          </div>
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-background/55">
            <Icon className="h-4 w-4 text-frost-blue" aria-hidden="true" />
          </span>
        </div>
        <CardDescription className="leading-relaxed">
          {feature.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-3xl font-semibold tracking-tight text-foreground">
              {availableRows.length}
              <span className="ml-1 text-base text-muted-foreground">
                / {rows.length}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {coveragePct.toFixed(0)}% of tracked coins
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-lg font-semibold text-foreground">
              {mcapSharePct == null ? "—" : `${mcapSharePct.toFixed(0)}%`}
            </div>
            <div className="text-xs text-muted-foreground">
              tracked market cap
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {breakdown}
        </div>
      </CardContent>
    </Card>
  );

  if (!feature.href) return content;

  if (feature.external) {
    return (
      <a
        href={feature.href}
        target="_blank"
        rel="noopener noreferrer"
        className="block pharos-focus-ring rounded-[1.15rem]"
      >
        {content}
      </a>
    );
  }

  return (
    <Link href={feature.href} className="block pharos-focus-ring rounded-[1.15rem]">
      {content}
    </Link>
  );
}

function ResourceLinkCard({ feature }: { feature: CoverageFeatureDefinition }) {
  const Icon = FEATURE_ICON[feature.key];
  const body = (
    <Card className="rounded-xl border border-border/70 bg-card/75 transition-colors hover:border-border">
      <CardContent className="flex items-start gap-3 py-4">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/55">
          <Icon className="h-4 w-4 text-frost-blue" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1.5">
          <div className="text-sm font-semibold text-foreground">
            {feature.label}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {feature.description}
          </p>
          {feature.href ? (
            <span className="inline-flex text-xs font-medium text-muted-foreground">
              {feature.external ? "Open source" : "Open feature"}
            </span>
          ) : (
            <span className="inline-flex text-xs font-medium text-muted-foreground">
              Detail page surface
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );

  if (!feature.href) return body;

  if (feature.external) {
    return (
      <a
        href={feature.href}
        target="_blank"
        rel="noopener noreferrer"
        className="block pharos-focus-ring rounded-xl"
      >
        {body}
      </a>
    );
  }

  return (
    <Link href={feature.href} className="block pharos-focus-ring rounded-xl">
      {body}
    </Link>
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
    case "bluechip":
      return row.statuses.bluechip.available;
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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CoverageFilterKey>("all");
  const [sort, setSort] = useState<CoverageSortKey>("market-cap");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const {
    data: stablecoinsData,
    dataUpdatedAt: stablecoinsUpdatedAt,
    error: stablecoinsError,
  } = useStablecoins();
  const {
    data: pegData,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    meta: pegMeta,
  } = usePegSummary();
  const {
    data: dexData,
    dataUpdatedAt: dexUpdatedAt,
    error: dexError,
    meta: dexMeta,
  } = useDexLiquidity();
  const {
    data: yieldData,
    dataUpdatedAt: yieldUpdatedAt,
    error: yieldError,
    meta: yieldMeta,
  } = useYieldRankings();
  const {
    data: flowData,
    dataUpdatedAt: flowUpdatedAt,
    error: flowError,
    meta: flowMeta,
  } = useMintBurnFlows();
  const {
    data: bluechipData,
    dataUpdatedAt: bluechipUpdatedAt,
    error: bluechipError,
  } = useBluechipRatings();
  const {
    data: reportCardsData,
    dataUpdatedAt: reportCardsUpdatedAt,
    error: reportCardsError,
  } = useReportCards();

  const assetById = new Map(
    (stablecoinsData?.peggedAssets ?? []).map((asset) => [asset.id, asset]),
  );
  const pegIds = new Set((pegData?.coins ?? []).map((coin) => coin.id));
  const yieldIds = new Set((yieldData?.rankings ?? []).map((row) => row.id));
  const flowById = new Map(
    (flowData?.coins ?? []).map((row) => [row.stablecoinId, row]),
  );
  const reportCardById = new Map(
    (reportCardsData?.cards ?? []).map((card) => [card.id, card]),
  );
  const dependencyIds = new Set<string>();
  for (const edge of reportCardsData?.dependencyGraph.edges ?? []) {
    dependencyIds.add(edge.from);
    dependencyIds.add(edge.to);
  }

  const rows = TRACKED_STABLECOINS.map((coin) =>
    buildCoverageRow({
      coin,
      marketCapUsd: assetById.has(coin.id)
        ? getCirculatingRaw(assetById.get(coin.id)!)
        : 0,
      hasPegCoverage: pegIds.has(coin.id),
      safetyScore: reportCardById.get(coin.id)?.overallScore ?? null,
      dexCoverageClass: dexData?.[coin.id]?.coverageClass ?? null,
      hasYieldCoverage: yieldIds.has(coin.id),
      flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
      bluechipGrade: bluechipData?.[coin.id]?.grade ?? null,
      hasDependencyCoverage: dependencyIds.has(coin.id),
    }),
  );

  const filteredRows = sortRows(
    rows.filter((row) => {
      if (!matchesFilter(row, filter)) return false;
      if (!deferredSearch) return true;
      return (
        row.name.toLowerCase().includes(deferredSearch) ||
        row.symbol.toLowerCase().includes(deferredSearch)
      );
    }),
    sort,
  );

  const totalMcapUsd = rows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const advancedCoveredRows = rows.filter((row) => row.advancedCoverageCount > 0);
  const advancedCoveredMcapUsd = advancedCoveredRows.reduce(
    (sum, row) => sum + row.marketCapUsd,
    0,
  );

  return (
    <div className="space-y-6">
      <StaleDataBanner
        queries={[
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsUpdatedAt,
            error: stablecoinsError,
            hasData: !!stablecoinsData?.peggedAssets?.length,
          },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegUpdatedAt,
            error: pegError,
            hasData: !!pegData?.coins?.length,
            meta: pegMeta,
          },
          {
            preset: "dexLiquidity",
            dataUpdatedAt: dexUpdatedAt,
            error: dexError,
            hasData: !!dexData,
            meta: dexMeta,
          },
          {
            preset: "yieldRankings",
            dataUpdatedAt: yieldUpdatedAt,
            error: yieldError,
            hasData: !!yieldData?.rankings?.length,
            meta: yieldMeta,
          },
          {
            preset: "mintBurnFlows",
            dataUpdatedAt: flowUpdatedAt,
            error: flowError,
            hasData: !!flowData?.coins?.length,
            meta: flowMeta,
          },
          {
            preset: "reportCards",
            dataUpdatedAt: reportCardsUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
          },
          {
            preset: "bluechip",
            dataUpdatedAt: bluechipUpdatedAt,
            error: bluechipError,
            hasData: bluechipData != null,
          },
        ]}
      />

      <Card className="rounded-[1.6rem] border-l-[3px] border-l-frost-blue/70 bg-card/85 shadow-[0_20px_46px_oklch(0_0_0_/0.14)]">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <p className="pharos-kicker">Coverage At A Glance</p>
              <CardTitle as="h2" className="text-xl">
                Broad on the majors, selective in the long tail
              </CardTitle>
              <CardDescription className="max-w-3xl leading-relaxed">
                Core price coverage is close to universal. Deeper features like live reserves,
                Bluechip ratings, blacklist tracking, and Ethereum flow monitoring are more selective.
                Count coverage shows breadth. Market-cap share shows how much of the market each
                feature actually reaches.
              </CardDescription>
            </div>
            <div className="grid min-w-[14rem] gap-2 text-right sm:grid-cols-2 sm:text-left">
              <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
                <div className="text-xs text-muted-foreground">Tracked coins</div>
                <div className="font-mono text-2xl font-semibold text-foreground">
                  {rows.length}
                </div>
              </div>
              <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
                <div className="text-xs text-muted-foreground">Any deeper module</div>
                <div className="font-mono text-2xl font-semibold text-foreground">
                  {advancedCoveredRows.length}
                </div>
                <div className="text-xs text-muted-foreground">
                  {totalMcapUsd > 0
                    ? `${((advancedCoveredMcapUsd / totalMcapUsd) * 100).toFixed(0)}% mcap`
                    : "—"}
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {COVERAGE_FEATURES.map((feature) => (
            <CoverageSummaryCard
              key={feature.key}
              feature={feature}
              rows={rows}
              totalMcapUsd={totalMcapUsd}
            />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.9fr)]">
        <Card className="rounded-[1.4rem] border-l-[3px] border-l-sky-500/65 bg-card/82">
          <CardHeader className="space-y-2">
            <p className="pharos-kicker text-sky-700 dark:text-sky-300">How To Read It</p>
            <CardTitle as="h2" className="text-lg">
              Structural coverage and live-snapshot coverage live side by side
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              <span className="text-foreground">Structural columns</span> describe whether Pharos has a
              supported feature path for that coin: reserve views, blacklist tracking, Bluechip
              ratings, and dependency-graph membership.
            </p>
            <p>
              <span className="text-foreground">Live columns</span> reflect the latest successful public
              datasets: DEX observation class, current Yield rankings, and Ethereum flow coverage
              state.
            </p>
            <p>
              Reserve badges distinguish <span className="text-foreground">Live</span>,
              <span className="text-foreground"> Curated</span>, and
              <span className="text-foreground"> Estimated</span>. That is important: a coin can have a
              usable reserve view on Pharos without yet having live reserve sync.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Card className="rounded-[1.4rem] border-l-[3px] border-l-amber-500/60 bg-card/82">
            <CardHeader className="space-y-2">
              <p className="pharos-kicker text-amber-700 dark:text-amber-300">Resources</p>
              <CardTitle as="h2" className="text-lg">
                Follow each coverage surface
              </CardTitle>
              <CardDescription className="leading-relaxed">
                Jump from the matrix into the underlying tracker, scoreboard, or external source.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {COVERAGE_FEATURES.map((feature) => (
                <ResourceLinkCard key={feature.key} feature={feature} />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="rounded-[1.6rem] border-l-[3px] border-l-emerald-500/65 bg-card/85 shadow-[0_18px_44px_oklch(0_0_0_/0.14)]">
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="pharos-kicker text-emerald-700 dark:text-emerald-300">
                Coverage Matrix
              </p>
              <CardTitle as="h2" className="text-xl">
                Per-coin feature availability
              </CardTitle>
              <CardDescription className="max-w-3xl leading-relaxed">
                Search by name or ticker, then filter to a specific surface. The table is sorted by
                live market cap by default so the most consequential gaps stay visible.
              </CardDescription>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3 text-right">
              <div className="text-xs text-muted-foreground">Rows shown</div>
              <div className="font-mono text-2xl font-semibold text-foreground">
                {filteredRows.length}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative min-w-0 flex-1 xl:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search stablecoin or ticker"
                className="h-11 rounded-2xl border-border/65 bg-background/45 pl-10"
                aria-label="Search stablecoin coverage table"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
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
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            Swipe horizontally on smaller screens. DEX, Yield, and Flows reflect the latest
            successful live snapshots; the other columns are driven by explicit Pharos coverage
            configuration and stablecoin metadata.
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border/70 bg-background/30">
            <table className="min-w-[76rem] w-full border-separate border-spacing-0">
              <thead>
                <tr className="bg-background/70 text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="sticky left-0 z-20 border-b border-border/70 bg-background/92 px-4 py-3 font-medium">
                    Stablecoin
                  </th>
                  {COVERAGE_FEATURES.map((feature) => (
                    <th
                      key={feature.key}
                      title={feature.description}
                      className="border-b border-border/70 px-3 py-3 font-medium"
                    >
                      {feature.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.id}
                    className="group even:bg-background/18 hover:bg-background/40"
                  >
                    <td className="sticky left-0 z-10 border-b border-border/60 bg-inherit px-4 py-3">
                      <Link
                        href={buildStablecoinUrl(row.id)}
                        className="pharos-focus-ring inline-flex w-full min-w-0 items-center gap-3 rounded-xl"
                      >
                        <StablecoinLogo src={undefined} name={row.name} size={34} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-semibold text-foreground">
                              {row.symbol}
                            </span>
                            <span className="truncate text-sm text-muted-foreground">
                              {row.name}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
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
                    </td>
                    {COVERAGE_FEATURES.map((feature) => (
                      <td
                        key={feature.key}
                        className="border-b border-border/60 px-3 py-3 align-middle"
                      >
                        <CoverageBadge status={row.statuses[feature.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
