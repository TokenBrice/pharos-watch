"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { RotateCcw, Star } from "lucide-react";

import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { useDexLiquidityTable, usePegSummary, useReportCardsV9Table } from "@/hooks/api-hooks";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { useCoinStates } from "@/hooks/use-coin-states";
import { useHomeAltFilters, type HomeAltPegFilter, type HomeAltUniverse } from "@/hooks/use-home-alt-filters";
import {
  buildHomepageCriticalViewModel,
  buildHomepageOptionalViewModel,
} from "@/components/homepage/homepage-client-view-model";
import { PegBrowseStrip } from "@/components/chart-primitives/peg-distribution-grid";
import { StablecoinOverviewSkeleton } from "@/components/stablecoin-directory/stablecoin-overview-skeleton";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";
import {
  CLIENT_ACTIVE_ALL_STABLECOIN_IDS,
  CLIENT_ACTIVE_TOKENIZED_FUND_IDS,
  CLIENT_ACTIVE_VARIANT_IDS,
  CLIENT_CORE_AGGREGATE_ACTIVE_IDS,
} from "@shared/lib/stablecoins/aggregate-client-registry";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import type { ColumnId } from "@/lib/column-visibility";
import { resolveQueryViewState } from "@/lib/query-view-state";

const StablecoinTable = dynamic(
  () => import("@/components/stablecoin-directory/stablecoin-table").then((mod) => mod.StablecoinTable),
  {
    loading: () => <StablecoinOverviewSkeleton showToolbar />,
  },
);

const HOME_ALT_DEFAULT_COLUMNS: readonly ColumnId[] = [
  "rank",
  "name",
  "price",
  "peg",
  "mcap",
  "change24h",
  "change7d",
  "grade",
  "stability",
  "liquidity",
  "blacklistable",
  "backing",
  "type",
];
const HOME_ALT_COLUMN_PREFERENCE_NAMESPACE = "pharos-home-alt-table-v3";

const UNIVERSE_OPTIONS: readonly { value: HomeAltUniverse; label: string }[] = [
  { value: "core", label: "Core" },
  { value: "variants", label: "Variants" },
  { value: "catalog", label: "All" },
  { value: "funds", label: "Funds" },
];

const PEG_QUICK_FILTERS: readonly { value: HomeAltPegFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "usd-peg", label: "USD" },
  { value: "fiat-non-usd-peg", label: "Non-USD" },
  { value: "commodity-peg", label: "Commodity" },
];

// Authoritative unfreezable active coin IDs, precomputed once from the shared blacklist registry.
const UNFREEZABLE_ACTIVE_IDS: ReadonlySet<string> = new Set(
  [...CLIENT_ACTIVE_IDS].filter((id) => getResolvedBlacklistStatus(id) === false),
);

interface HomeAltRankingsSectionProps {
  titleId: string;
}

export function HomeAltRankingsSection({ titleId }: HomeAltRankingsSectionProps) {
  const filters = useHomeAltFilters();
  const activeUniverse: HomeAltUniverse = filters.activeUniverse ?? "core";
  const activePeg: HomeAltPegFilter = filters.activePeg ?? "all";
  const [searchQuery, setSearchQuery] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [unfreezableOnly, setUnfreezableOnly] = useState(false);

  const stablecoinsQuery = useStablecoins();
  const pegSummaryQuery = usePegSummary();
  const dexLiquidityQuery = useDexLiquidityTable();
  const reportCardsQuery = useReportCardsV9Table();
  const { data: stablecoinsData, isLoading } = stablecoinsQuery;
  const logos = logosById;
  const { data: pegSummaryData } = pegSummaryQuery;
  const { data: dexLiquidity } = dexLiquidityQuery;
  const { data: reportCardsData } = reportCardsQuery;
  const pinned = usePinnedStablecoins();
  // Cold `/` load stays passive (zero extra requests); enabling Active alerts fetches DEWS & peg signals on demand.
  const coinStatesResult = useCoinStates({ enabled: alertsOnly });
  const coinStates = coinStatesResult.byId;

  const universeEligibleIds =
    activeUniverse === "core"
      ? CLIENT_CORE_AGGREGATE_ACTIVE_IDS
      : activeUniverse === "variants"
        ? CLIENT_ACTIVE_VARIANT_IDS
        : activeUniverse === "funds"
          ? CLIENT_ACTIVE_TOKENIZED_FUND_IDS
          : CLIENT_ACTIVE_ALL_STABLECOIN_IDS;

  const pinnedInUniverseCount = useMemo(
    () => pinned.pinnedIds.filter((id) => universeEligibleIds.has(id)).length,
    [pinned.pinnedIds, universeEligibleIds],
  );

  const alertEligibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of coinStates.keys()) ids.add(id);
    for (const coin of pegSummaryData?.coins ?? []) {
      if (coin.activeDepeg) ids.add(coin.id);
    }
    return ids;
  }, [coinStates, pegSummaryData?.coins]);

  const effectiveEligibleIds = useMemo(() => {
    if (!starredOnly && !alertsOnly && !unfreezableOnly) return universeEligibleIds;
    const pinnedSet = new Set(pinned.pinnedIds);
    const filtered = new Set<string>();
    for (const id of universeEligibleIds) {
      if (starredOnly && !pinnedSet.has(id)) continue;
      if (alertsOnly && !alertEligibleIds.has(id)) continue;
      if (unfreezableOnly && !UNFREEZABLE_ACTIVE_IDS.has(id)) continue;
      filtered.add(id);
    }
    return filtered;
  }, [alertEligibleIds, alertsOnly, pinned.pinnedIds, starredOnly, unfreezableOnly, universeEligibleIds]);

  const hasQuickFilters = activePeg !== "all" || starredOnly || alertsOnly || unfreezableOnly;

  const handleClearFilters = useCallback(() => {
    filters.setActivePeg?.("all");
    setStarredOnly(false);
    setAlertsOnly(false);
    setUnfreezableOnly(false);
    setSearchQuery("");
  }, [filters]);

  const { reportCardMap } = useMemo(
    () => buildHomepageOptionalViewModel({ reportCardsData }),
    [reportCardsData],
  );
  const { pegScores, filteredRowCount } = useMemo(
    () =>
      buildHomepageCriticalViewModel({
        stablecoinsData,
        pegSummaryData,
        reportCardMap,
        eligibleIds: effectiveEligibleIds,
        filters: { activeFilters: filters.activeFilters, searchQuery },
      }),
    [stablecoinsData, pegSummaryData, reportCardMap, effectiveEligibleIds, filters.activeFilters, searchQuery],
  );
  const stablecoinsState = resolveQueryViewState({
    hasData: stablecoinsData !== undefined,
    isLoading,
    error: stablecoinsQuery.error,
    isEmpty: stablecoinsData?.peggedAssets.length === 0,
  });
  // R2: when Active alerts is on and live peg/DEWS signals have not settled,
  // hold off on claiming zero matching alerts.
  const alertsSignalsPending =
    alertsOnly
    && !coinStatesResult.liveReady
    && stablecoinsState !== "loading"
    && stablecoinsState !== "unavailable"
    && filteredRowCount === 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h2 id={titleId} className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Stablecoin Overview
          </h2>
          {stablecoinsState === "unavailable" ? (
            <p className="text-sm text-muted-foreground">Stablecoin rankings are updating.</p>
          ) : alertsSignalsPending ? (
            <p className="text-sm text-muted-foreground">Active alert signals are updating.</p>
          ) : stablecoinsState === "loading" ? (
            <p className="text-sm text-muted-foreground">
              Compare market size, peg health, liquidity, and safety across the stablecoin market.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Showing <span className="pharos-numeric text-foreground">{filteredRowCount.toLocaleString("en-US")}</span>{" "}
              {activeUniverse === "core"
                ? "core stablecoins"
                : activeUniverse === "variants"
                  ? "tracked variants, excluded from core market aggregates"
                  : activeUniverse === "funds"
                    ? "tracked tokenized funds (not stablecoins; excluded from stablecoin aggregates and Safety grades)"
                    : "active stablecoins (core, variants, and review-hold; tokenized funds excluded)"}{" "}
              with market data. Inactive lifecycle states excluded,{" "}
              <Link
                href="/screener/"
                className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
              >
                see Screener
              </Link>
              .
            </p>
          )}
        </div>
        <div role="group" aria-label="Select stablecoin listing universe" className="pharos-segmented">
          {UNIVERSE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={activeUniverse === option.value}
              onClick={() => filters.setActiveUniverse?.(option.value)}
              className="pharos-focus-ring pharos-segmented-item min-h-11 sm:min-h-8"
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {/* In-place quick-filter row (Q7): peg cohort switch + triage toggle pills */}
      <div className="flex flex-wrap items-center gap-2" aria-label="Quick table filters">
        <div role="group" aria-label="Filter by peg currency" className="pharos-segmented">
          {PEG_QUICK_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={activePeg === option.value}
              onClick={() => filters.setActivePeg?.(option.value)}
              className="pharos-focus-ring pharos-segmented-item min-h-11 px-2.5 sm:min-h-8 sm:px-3"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={starredOnly}
            onClick={() => setStarredOnly((prev) => !prev)}
            className="pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 sm:min-h-8 sm:py-1.5"
          >
            <Star aria-hidden="true" className="h-3.5 w-3.5" />
            <span>Starred</span>
            <span className="pharos-numeric text-muted-foreground">({pinnedInUniverseCount})</span>
          </button>

          <button
            type="button"
            aria-pressed={alertsOnly}
            onClick={() => setAlertsOnly((prev) => !prev)}
            className="pharos-focus-ring pharos-control-pill min-h-11 sm:min-h-8 sm:py-1.5"
          >
            Active alerts
          </button>

          <button
            type="button"
            aria-pressed={unfreezableOnly}
            onClick={() => setUnfreezableOnly((prev) => !prev)}
            className="pharos-focus-ring pharos-control-pill min-h-11 sm:min-h-8 sm:py-1.5"
          >
            Unfreezable
          </button>

          {hasQuickFilters ? (
            <button
              type="button"
              onClick={handleClearFilters}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:min-h-8"
            >
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      {stablecoinsState !== "unavailable" ? (
        alertsSignalsPending ? (
          <div className="pharos-card-shell flex min-h-48 flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground">Updating active alerts…</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Live peg and DEWS stress signals are updating.
            </p>
          </div>
        ) : (
          <StablecoinTable
            data={stablecoinsData?.peggedAssets}
            isLoading={isLoading}
            activeFilters={filters.activeFilters}
            eligibleIds={effectiveEligibleIds}
            logos={logos}
            pegScores={pegScores}
            coinStates={coinStates}
            dexLiquidity={dexLiquidity ?? undefined}
            reportCards={reportCardMap}
            reportCardsMethodologyVersion={reportCardsData?.safetyScoreIdentity?.methodologyVersion ?? null}
            sourceGenerations={{
              stablecoins: stablecoinsQuery.meta?.updatedAt,
              pegSummary: pegSummaryQuery.meta?.updatedAt,
              dexLiquidity: dexLiquidityQuery.meta?.updatedAt,
              reportCards: reportCardsQuery.meta?.updatedAt,
            }}
            initialVisibleColumns={HOME_ALT_DEFAULT_COLUMNS}
            columnPreferenceNamespace={HOME_ALT_COLUMN_PREFERENCE_NAMESPACE}
            pinnedStablecoinIds={pinned.pinnedIds}
            onTogglePinnedStablecoin={pinned.togglePinned}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onClearSearch={() => setSearchQuery("")}
            onClearFilters={handleClearFilters}
            toolbarEyebrow=""
            toolbarDescription={null}
            toolbarVariant="figmaOverview"
          />
        )
      ) : null}
      <PegBrowseStrip pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
    </div>
  );
}
