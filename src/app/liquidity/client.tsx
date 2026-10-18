"use client";

import { useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FilterSearchInput } from "@/components/filter-search-input";
import { logosById } from "@/lib/logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { LiquidityHero } from "@/components/liquidity-hero";
import { LiquidityTable } from "@/components/liquidity-table";
import { LIQUIDITY_NR_REASON_LABELS } from "@/components/liquidity-table-logic";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { HeroMetricRow } from "@/components/feature-hero-split";
import { ModuleDisclosure, MODULE_FOLD_RHYTHM_CLASS } from "@/components/stablecoin-detail/module-disclosure";
import type { PegCurrency } from "@shared/types";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { trackEvent } from "@/lib/analytics";
import { type UrlStateSchema } from "@/lib/url-state";
import { useUrlState } from "@/hooks/use-url-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { formatDateTimeLocale, timeAgo } from "@shared/lib/format";
import { LiquidityStatusChip } from "./status-chip";
import { LiquidityContentLoadingState } from "./loading";
import {
  PEG_FILTERS,
  buildLiquidityViewModel,
  type LiquidityViewModel,
} from "./model";

interface LiquidityUrlState {
  peg: PegCurrency | "all";
}

const LIQUIDITY_PEG_VALUES: readonly (PegCurrency | "all")[] = [
  "all",
  ...(Object.keys(PEG_LABELS_SHORT) as PegCurrency[]),
];

export const LIQUIDITY_URL_SCHEMA: UrlStateSchema<LiquidityUrlState> = {
  peg: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: LIQUIDITY_PEG_VALUES,
  },
};

export function LiquidityClient() {
  const { data: liquidityMap, isLoading, error, dataUpdatedAt, refetch, meta } = useDexLiquidity();
  const logos = logosById;
  const { getParam, setParam } = useUrlFilters();
  const { state: { peg: pegFilter }, patchState } = useUrlState(
    LIQUIDITY_URL_SCHEMA, { clear: { key: "peg" } },
  );
  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v });
      patchState({ peg: v });
    }, [patchState],
  );
  const router = useRouter();

  // Search: local state for instant input, deferred value for filtering,
  // debounced sync to URL + analytics to avoid per-keystroke overhead
  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync(
    "liquidity",
    { getParam, setParam },
  );

  const { leaderboardRows, unobservedRows, summaryStats } = useMemo(
    () => buildLiquidityViewModel(liquidityMap, pegFilter, deferredSearch),
    [liquidityMap, pegFilter, deferredSearch],
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
  const searchActive = deferredSearch.trim().length > 0;

  const leaderboardToolbar = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="pharos-label">Liquidity leaderboard</h2>
      <div className="flex flex-wrap items-center gap-2">
        <ControlPillToggle
          className="flex flex-wrap gap-1.5"
          ariaLabel="Filter by peg currency"
          options={PEG_FILTERS}
          value={pegFilter}
          onChange={setPegFilter}
          buttonClassName="min-h-11 md:min-h-9"
        />
        <FilterSearchInput
          value={searchInput}
          onValueChange={setSearchInput}
          placeholder="Search..."
          className="relative w-full sm:w-44"
          inputClassName="pl-8 h-11 md:h-8 text-xs"
          ariaLabel="Search stablecoins by name or symbol"
        />
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
          status={<LiquidityStatusChip meta={meta} stats={summaryStats} />}
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
        />
      </section>

      <div className={MODULE_FOLD_RHYTHM_CLASS}>
        {summaryStats ? <PoolQualityFold stats={summaryStats} /> : null}
        {unobservedRows.length > 0 ? (
          // Remounts open while a search is active so matching coins are visible.
          <UnobservedFold key={searchActive ? "search" : "browse"} rows={unobservedRows} defaultOpen={searchActive} />
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
            label="Organic liquidity, fee-based share of TVL"
            value={stats.avgOrganic == null ? "—" : `${stats.avgOrganic}%`}
          />
          <HeroMetricRow
            label="Coverage of observed markets"
            value={`${stats.highConfidenceCoverage.toLocaleString("en-US")} primary or mixed · ${stats.fallbackCoverage.toLocaleString("en-US")} fallback`}
          />
        </div>
        <p className="pharos-meta">
          On the map, rails turn dashed when pool balance is under 70% and flow lines turn dashed when organic
          liquidity is under 60%. Durability is scored per coin; see the Durability column in the leaderboard.
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
