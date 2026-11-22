"use client";

import { useMemo, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FilterSearchInput } from "@/components/filter-search-input";
import { TableExportMenu } from "@/components/table-export-menu";
import { logosById } from "@/lib/logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { LiquidityHero } from "@/components/liquidity/liquidity-hero";
import { LiquidityTable } from "@/components/liquidity/liquidity-table";
import {
  computeDepthToMcapRatio,
  LIQUIDITY_NR_REASON_LABELS,
  type LiquidityRow,
} from "@/components/liquidity/liquidity-table-logic";
import { buildLiquidityExitRouteModel } from "@/components/liquidity/exit-route-model";
import type { LiquidityStatsData } from "@/components/liquidity/liquidity-stats-types";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { HeroMetricRow } from "@/components/feature-hero-split";
import { ModuleDisclosure, MODULE_FOLD_RHYTHM_CLASS } from "@/components/stablecoin-detail/module-disclosure";
import type { PegCurrency } from "@shared/types/core";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { trackEvent } from "@/lib/analytics";
import { type UrlStateSchema } from "@/lib/url-state";
import { useUrlState } from "@/hooks/use-url-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { formatDateTimeLocale, timeAgo } from "@shared/lib/format";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { dexVolumeToTvlRatio } from "@shared/lib/dex-volume-availability";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { prettifyProtocol } from "@/lib/dex-display-constants";
import type { CsvColumn } from "@/lib/exports/csv";
import { LiquidityStatusChip } from "./status-chip";
import { LiquidityContentLoadingState } from "./loading-state";
import {
  LIQUIDITY_TRIAGE_FILTERS,
  PEG_FILTERS,
  buildLiquidityViewModel,
  type LiquidityRouteFilter,
  type LiquidityTriageFilter,
  type LiquidityViewModel,
} from "./model";

interface LiquidityUrlState {
  peg: PegCurrency | "all";
  tier: LiquidityTriageFilter;
}

const LIQUIDITY_PEG_VALUES: readonly (PegCurrency | "all")[] = [
  "all",
  ...(Object.keys(PEG_LABELS_SHORT) as PegCurrency[]),
];

const LIQUIDITY_TIER_VALUES: readonly LiquidityTriageFilter[] = ["all", "deep", "thin", "nr"];

export const LIQUIDITY_URL_SCHEMA: UrlStateSchema<LiquidityUrlState> = {
  peg: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: LIQUIDITY_PEG_VALUES,
  },
  tier: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: LIQUIDITY_TIER_VALUES,
  },
};

const LIQUIDITY_EXPORT_COLUMNS: CsvColumn<LiquidityRow>[] = [
  { header: "Symbol", accessor: (row) => row.meta.symbol },
  { header: "Name", accessor: (row) => row.meta.name },
  { header: "Liquidity Score", accessor: (row) => row.liq.liquidityScore },
  { header: "DEX TVL (USD)", accessor: (row) => Math.round(row.liq.totalTvlUsd) },
  {
    header: "Depth/MCap (%)",
    accessor: (row) => {
      const ratio = computeDepthToMcapRatio(row.liq.totalTvlUsd, row.mcapUsd);
      return ratio != null ? Number((ratio * 100).toFixed(2)) : null;
    },
  },
  { header: "TVL 7d Change (%)", accessor: (row) => row.liq.tvlChange7d },
  { header: "24h Volume (USD)", accessor: (row) => row.liq.totalVolume24hUsd },
  {
    header: "Vol/TVL (%)",
    accessor: (row) => {
      const ratio = dexVolumeToTvlRatio(row.liq.totalVolume24hUsd, row.liq.totalTvlUsd);
      return ratio != null ? Number((ratio * 100).toFixed(2)) : null;
    },
  },
  { header: "Pools", accessor: (row) => row.liq.poolCount },
  { header: "Chains", accessor: (row) => row.liq.chainCount },
  {
    header: "Top Protocol",
    accessor: (row) => {
      const top = Object.entries(row.liq.protocolTvl).sort((a, b) => b[1] - a[1])[0];
      return top ? prettifyProtocol(top[0]) : null;
    },
  },
  {
    header: "Balance (%)",
    accessor: (row) => (row.liq.weightedBalanceRatio != null ? Math.round(row.liq.weightedBalanceRatio * 100) : null),
  },
  {
    header: "Organic (%)",
    accessor: (row) => (row.liq.organicFraction != null ? Math.round(row.liq.organicFraction * 100) : null),
  },
  { header: "Durability", accessor: (row) => row.liq.durabilityScore },
];

export function LiquidityClient() {
  const { data: liquidityMap, isLoading, error, dataUpdatedAt, refetch, meta } = useDexLiquidity();
  const stablecoinsQuery = useStablecoins();
  const logos = logosById;
  const { getParam, setParam } = useUrlFilters();
  const { state: { peg: pegFilter, tier: triageFilter }, patchState } = useUrlState(
    LIQUIDITY_URL_SCHEMA, { clear: { key: "peg" } },
  );
  const [routeFilter, setRouteFilter] = useState<LiquidityRouteFilter | null>(null);
  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v });
      patchState({ peg: v });
    }, [patchState],
  );
  const setTriageFilter = useCallback(
    (v: LiquidityTriageFilter) => {
      trackEvent("filter_applied", { page: "liquidity", filter_type: "liquidity_tier", filter_value: v });
      patchState({ tier: v });
    }, [patchState],
  );
  const router = useRouter();

  // Search: local state for instant input, deferred value for filtering,
  // debounced sync to URL + analytics to avoid per-keystroke overhead
  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync(
    "liquidity",
    { getParam, setParam },
  );

  const mcapById = useMemo(() => {
    const map = new Map<string, number | null>();
    const assets = stablecoinsQuery.data?.peggedAssets;
    if (!assets) return map;
    for (const asset of assets) {
      map.set(asset.id, getCirculatingRawOrNull(asset));
    }
    return map;
  }, [stablecoinsQuery.data?.peggedAssets]);

  const routeNamedTopKeys = useMemo(() => {
    if (!liquidityMap || !routeFilter || routeFilter.key !== "_other-routes") return undefined;
    const exitModel = buildLiquidityExitRouteModel(liquidityMap);
    if (!exitModel) return undefined;
    if (routeFilter.kind === "protocol") {
      return new Set(exitModel.protocolRoutes.filter((r) => !r.isOther).map((r) => r.key));
    }
    return new Set(exitModel.chainRoutes.filter((r) => !r.isOther).map((r) => r.key.toLowerCase()));
  }, [liquidityMap, routeFilter]);

  const { leaderboardRows, unobservedRows, unavailableRows, summaryStats } = useMemo(
    () =>
      buildLiquidityViewModel(liquidityMap, pegFilter, deferredSearch, {
        mcapById,
        triageFilter,
        routeFilter,
        routeNamedTopKeys,
      }),
    [liquidityMap, pegFilter, deferredSearch, mcapById, triageFilter, routeFilter, routeNamedTopKeys],
  );

  const handleRowClick = useCallback(
    (id: string) => {
      router.push(buildStablecoinUrl(id));
    },
    [router],
  );
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const handleClearFilters = useCallback(() => {
    patchState({ peg: "all", tier: "all" });
    setRouteFilter(null);
    setSearchInput("");
  }, [patchState, setSearchInput]);

  const searchActive = deferredSearch.trim().length > 0;
  const hasAnyFilter = pegFilter !== "all" || triageFilter !== "all" || routeFilter != null || searchActive;
  const exportAsOfISO = meta?.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : "";

  const leaderboardToolbar = (
    <div className="space-y-2.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="pharos-label">Liquidity leaderboard</h2>
          {routeFilter ? (
            <button
              type="button"
              data-testid="active-route-filter-chip"
              onClick={() => setRouteFilter(null)}
              className="pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-8 gap-1.5 text-xs"
            >
              <span>
                {routeFilter.kind === "protocol" ? "Protocol" : "Chain"}: {routeFilter.label}
              </span>
              <X className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Clear {routeFilter.label} filter</span>
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSearchInput
            value={searchInput}
            onValueChange={setSearchInput}
            placeholder="Search..."
            className="relative w-full sm:w-44"
            inputClassName="pl-8 h-11 md:h-8 text-xs"
            ariaLabel="Search stablecoins by name or symbol"
          />
          <TableExportMenu
            data={leaderboardRows}
            columns={LIQUIDITY_EXPORT_COLUMNS}
            filename="pharos-dex-liquidity"
            asOfISO={exportAsOfISO}
            endpoint="dex-liquidity"
            methodologyLabel={`dex-liquidity ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}`}
            sourceGenerations={{
              dexLiquidity: meta?.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null,
              stablecoins: stablecoinsQuery.meta?.updatedAt != null ? new Date(stablecoinsQuery.meta.updatedAt * 1000).toISOString() : null,
            }}
            disabled={leaderboardRows.length === 0}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ControlPillToggle
          className="flex flex-wrap gap-1.5"
          ariaLabel="Filter by peg currency"
          options={PEG_FILTERS}
          value={pegFilter}
          onChange={setPegFilter}
          buttonClassName="min-h-11 md:min-h-8"
        />
        <ControlPillToggle
          className="flex flex-wrap gap-1.5"
          ariaLabel="Filter by liquidity tier"
          options={LIQUIDITY_TRIAGE_FILTERS}
          value={triageFilter}
          onChange={setTriageFilter}
          buttonClassName="min-h-11 md:min-h-8"
        />
        {hasAnyFilter ? (
          <button
            type="button"
            onClick={handleClearFilters}
            className="pharos-focus-ring ml-auto min-h-11 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-8"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );

  if (isLoading) return <LiquidityContentLoadingState />;

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={error}
        hasData={!!liquidityMap}
        onRetry={handleRetry}
        queries={[{ preset: "dexLiquidity", dataUpdatedAt, error, hasData: !!liquidityMap, meta }]}
        // Degraded or stale data is the hero's status chip; the body only reports a hard error.
        showFreshnessBanner={false}
      />

      {summaryStats && liquidityMap && (
        <LiquidityHero
          stats={summaryStats}
          liquidityMap={liquidityMap}
          status={<LiquidityStatusChip meta={meta} stats={summaryStats} dataUpdatedAt={dataUpdatedAt} error={error} />}
          activeRouteFilter={routeFilter}
          onRouteFilterChange={setRouteFilter}
        />
      )}

      {/* Leaderboard workbench: filters live in the table toolbar */}
      <section id="data" aria-label="Data table" tabIndex={-1}>
        <LiquidityTable
          rows={leaderboardRows}
          logos={logos}
          searchQuery={deferredSearch}
          onRowClick={handleRowClick}
          toolbar={leaderboardToolbar}
          onClearFilters={hasAnyFilter ? handleClearFilters : undefined}
        />
      </section>

      <div className={MODULE_FOLD_RHYTHM_CLASS}>
        {summaryStats ? <PoolQualityFold stats={summaryStats} /> : null}
        {unobservedRows.length > 0 ? (
          // Remounts open while a search is active so matching coins are visible.
          <UnobservedFold key={searchActive ? "search" : "browse"} rows={unobservedRows} defaultOpen={searchActive} />
        ) : null}
        {unavailableRows.length > 0 ? (
          <UnavailableFold key={searchActive ? "unavailable-search" : "unavailable-browse"} rows={unavailableRows} defaultOpen={searchActive} />
        ) : null}
      </div>

      {meta?.updatedAt != null ? (
        <p className="pharos-meta border-t border-border/50 pt-3">
          Source: Pharos DEX liquidity lane, published hourly. Snapshot{" "}
          <time dateTime={new Date(meta.updatedAt * 1000).toISOString()} title={formatDateTimeLocale(meta.updatedAt)}>
            {timeAgo(meta.updatedAt)}
          </time>
          . Secondary-market depth only; issuer redemption capacity is scored separately.
        </p>
      ) : null}
    </div>
  );
}

/** Pool quality and coverage behind the hero: TVL-weighted aggregates the map encodes as dashes. */
function PoolQualityFold({ stats }: { stats: LiquidityStatsData }) {
  return (
    <ModuleDisclosure label="Pool quality and coverage">
      <div className="max-w-2xl space-y-3 pt-2">
        <div className="divide-y divide-border/50">
          <HeroMetricRow
            label="Pool balance, TVL-weighted"
            value={stats.avgBalance == null ? "—" : `${stats.avgBalance}%`}
          />
          <HeroMetricRow
            label="Base-yield share, TVL-weighted"
            value={stats.avgOrganic == null ? "—" : `${stats.avgOrganic}%`}
          />
          <HeroMetricRow
            label="Coverage of observed markets"
            value={`${stats.highConfidenceCoverage.toLocaleString("en-US")} primary or mixed · ${stats.fallbackCoverage.toLocaleString("en-US")} fallback`}
          />
        </div>
        <p className="pharos-meta">
          On the map, rails turn dashed when pool balance is under 70% and flow lines turn dashed when base-yield
          share is under 60%. Durability is scored per coin; see the Durability column in the leaderboard.
        </p>
      </div>
    </ModuleDisclosure>
  );
}

/** Tracked coins with no observed DEX market: a compact link list, not a logo grid. */
function UnobservedFold({ rows, defaultOpen }: { rows: LiquidityViewModel["unobservedRows"]; defaultOpen: boolean }) {
  const symbolCounts = new Map<string, number>();
  for (const row of rows) symbolCounts.set(row.meta.symbol, (symbolCounts.get(row.meta.symbol) ?? 0) + 1);
  return (
    <ModuleDisclosure id="unrated" label="Not observed on DEX" count={rows.length} defaultOpen={defaultOpen}>
      <div className="space-y-2 pt-2">
        <p className="pharos-meta max-w-3xl">
          Tracked coins with no retained DEX pool in this snapshot. They carry no Liquidity Score.
        </p>
        <ul className="columns-2 gap-x-6 text-sm sm:columns-3 lg:columns-5">
          {rows.map((row) => {
            const reason = row.liq.liquidityScoreUnavailableReason;
            return (
              <li key={row.meta.id} className="break-inside-avoid py-0.5">
                <Link
                  href={buildStablecoinUrl(row.meta.id)}
                  className="pharos-focus-ring rounded-sm hover:underline"
                  title={row.meta.name}
                >
                  {row.meta.symbol}
                </Link>
                {/* A shared symbol names its coin so the two entries are distinguishable. */}
                {(symbolCounts.get(row.meta.symbol) ?? 0) > 1 ? (
                  <span className="ml-1.5 text-2xs text-muted-foreground">{row.meta.name}</span>
                ) : null}
                {reason && reason !== "no-retained-pools" ? (
                  <span className="ml-1.5 text-2xs text-muted-foreground">{LIQUIDITY_NR_REASON_LABELS[reason]}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </ModuleDisclosure>
  );
}

/** Unavailable evidence is neither an admitted market nor proof that no pools exist. */
function UnavailableFold({ rows, defaultOpen }: { rows: LiquidityViewModel["unavailableRows"]; defaultOpen: boolean }) {
  return (
    <ModuleDisclosure id="unavailable" label="DEX evidence unavailable" count={rows.length} defaultOpen={defaultOpen}>
      <div className="space-y-2 pt-2">
        <p className="pharos-meta max-w-3xl">
          These coins have unavailable DEX coverage evidence. Their raw pool data is excluded from the leaderboard
          and coverage, trend, and pool-quality statistics.
        </p>
        <ul className="space-y-1 text-sm">
          {rows.map(({ meta, liq }) => (
            <li key={meta.id} data-unavailable-reason={liq.unavailableReason ?? liq.liquidityScoreUnavailableReason ?? undefined}>
              <Link href={buildStablecoinUrl(meta.id)} className="pharos-focus-ring rounded-sm hover:underline">
                {meta.symbol} <span className="text-muted-foreground">({meta.name})</span>
              </Link>
              <span className="ml-1.5 text-xs text-muted-foreground">
                {liq.unavailableReason === "invalid-coverage-evidence" || liq.liquidityScoreUnavailableReason === "invalid-coverage-evidence"
                  ? LIQUIDITY_NR_REASON_LABELS["invalid-coverage-evidence"]
                  : "Coverage evidence unavailable"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ModuleDisclosure>
  );
}
