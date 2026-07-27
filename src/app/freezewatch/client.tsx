"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { UsdsStatusCard } from "@/components/usds-status-card";
import { EurcBlacklistCard } from "@/components/eurc-blacklist-card";
import { BlacklistStats } from "@/components/blacklist-stats";
import { BlacklistChart } from "@/components/blacklist-chart";
import { BlacklistStatusDrilldown } from "@/components/blacklist-status-drilldown";
import { BlacklistFilters } from "@/components/blacklist-filters";
import { BlacklistTable } from "@/components/blacklist-table";
import { TablePagination } from "@/components/table-pagination";
import { CoinCrossTrackerHatnote } from "@/components/coin-cross-tracker-hatnote";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  FreezableSupplyMeter,
  computeFreezableSummary,
  formatShare,
} from "@/components/freezewatch/freezable-supply-meter";
import { InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";
import { formatCurrency } from "@shared/lib/format";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { useFreezeWatchPageController } from "./view-model";

function FreezeWatchSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 animate-in fade-in duration-300">
      <div className="space-y-1">
        <p className="pharos-kicker">{eyebrow}</p>
        <h2 className="pharos-section-title">{title}</h2>
        {description ? <p className="pharos-meta max-w-3xl">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function HeroStat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div className="space-y-1">
      <dt className="pharos-kicker">{label}</dt>
      {loading ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <dd className="pharos-numeric text-xl font-semibold text-foreground sm:text-2xl">{value}</dd>
      )}
    </div>
  );
}

export default function FreezeWatchClient() {
  const {
    summary,
    summaryLoading,
    error,
    dataUpdatedAt,
    freshnessMeta,
    stablecoins,
    stablecoinFxFallbackRates,
    reportCardMap,
    reportCardsResponse,
    blacklistStatusBuckets,
    supportDataLoading,
    refetchSummary,
    refetchPage,
    statusBucket,
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    sortKey,
    sortDirection,
    searchInput,
    handleStablecoinChange,
    handleChainChange,
    handleEventTypeChange,
    handleSearchChange,
    handleSortChange,
    handleStatusBucketChange,
    handleStatusBucketClear,
    handlePreviousPage,
    handleNextPage,
    drilldownRef,
    clampedPage,
    total,
    totalPages,
    rangeStart,
    rangeEnd,
    pageLoading,
    events,
    pageSize,
  } = useFreezeWatchPageController();

  const focusedCoin =
    stablecoinFilter !== "all"
      ? stablecoins?.find((coin) => coin.symbol === stablecoinFilter)
      : null;
  const focusedCoinId =
    focusedCoin?.id ??
    (stablecoinFilter !== "all" ? coinIdBySymbol(stablecoinFilter) : null);

  const heroLoading = summaryLoading || supportDataLoading;
  const { freezableMarketCap, freezableCount, freezableShare } =
    computeFreezableSummary(blacklistStatusBuckets);

  return (
    <FeaturePageShell
      breadcrumbName="FreezeWatch"
      path="/freezewatch/"
      title="FreezeWatch"
      methodology={{
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        "The stablecoin freeze and blacklist tracker: live issuer freeze, release, and wipe events — with affected addresses, frozen value, and direct vs. upstream exposure per asset.",
      ]}
    >
      {focusedCoinId ? (
        <CoinCrossTrackerHatnote
          coinId={focusedCoinId}
          coinSymbol={stablecoinFilter}
          currentTracker="freezewatch"
        />
      ) : null}
      <QueryFreshnessNotices
        error={error}
        hasData={!!summary || events.length > 0}
        onRetry={() => {
          void refetchSummary();
          void refetchPage();
        }}
        queries={[
          { preset: "blacklist", dataUpdatedAt, error, hasData: !!summary || events.length > 0, meta: freshnessMeta },
        ]}
      />
      <SafetyScoreV9StatusNotice response={reportCardsResponse} />

      <section
        aria-label="Freezable supply overview"
        className="pharos-card-shell overflow-hidden animate-in fade-in duration-300"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-border/50 p-5 sm:p-6">
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Freezable share of tracked supply</p>
            {heroLoading ? (
              <Skeleton className="h-10 w-32" />
            ) : (
              <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
                {formatShare(freezableShare)}
              </p>
            )}
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              of tracked stablecoin market cap sits under direct, upstream, or possible issuer freeze control.
            </p>
          </div>
          <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <HeroStat label="Freezable value" value={formatCurrency(freezableMarketCap, 0)} loading={heroLoading} />
            <HeroStat label="Freezable coins" value={String(freezableCount)} loading={heroLoading} />
          </dl>
        </div>
        <FreezableSupplyMeter
          buckets={blacklistStatusBuckets}
          isLoading={heroLoading}
          selectedBucket={statusBucket}
          onBucketSelect={handleStatusBucketChange}
        />
      </section>

      <BlacklistStats
        summary={summary}
        isLoading={summaryLoading}
        blacklistStatusBuckets={blacklistStatusBuckets}
        supportDataLoading={supportDataLoading}
        onUnfreezableSelect={() => handleStatusBucketChange("no")}
      />

      {statusBucket ? (
        <div ref={drilldownRef}>
          <BlacklistStatusDrilldown
            status={statusBucket}
            stablecoins={stablecoins}
            fxFallbackRates={stablecoinFxFallbackRates}
            reportCards={reportCardMap}
            onClear={handleStatusBucketClear}
          />
        </div>
      ) : null}

      <BlacklistChart chart={summary?.chart} isLoading={summaryLoading} />

      <FreezeWatchSection
        eyebrow="Event ledger"
        title="Affected addresses and transactions"
        description="Filter by asset, chain, event type, or address to isolate the rows that matter."
      >
        <div className="pharos-table-toolbar rounded-xl border border-border/60">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <BlacklistFilters
              chains={summary?.chains ?? []}
              stablecoinFilter={stablecoinFilter}
              chainFilter={chainFilter}
              eventTypeFilter={eventTypeFilter}
              perCoinTotalEvents={summary?.stats.perCoinTotalEvents}
              onStablecoinChange={handleStablecoinChange}
              onChainChange={handleChainChange}
              onEventTypeChange={handleEventTypeChange}
            />
            <FilterSearchInput
              value={searchInput}
              onValueChange={handleSearchChange}
              placeholder="Search address..."
              className="relative w-full sm:w-56"
              inputClassName="pl-8 h-11 sm:h-8 text-sm sm:text-xs"
              ariaLabel="Search events by address"
            />
          </div>
        </div>

        <section id="data" aria-label="Data table" tabIndex={-1}>
          <BlacklistTable
            events={events}
            isLoading={pageLoading}
            page={clampedPage}
            pageSize={pageSize}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSortChange={handleSortChange}
          />
        </section>

        {total > 0 && (
          <TablePagination
            page={clampedPage - 1} /* TablePagination expects 0-indexed page */
            totalPages={totalPages}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={total}
            onPrevious={handlePreviousPage}
            onNext={handleNextPage}
            noun="events"
          />
        )}

        <div className="flex justify-end">
          <Link
            href="/timeline/?type=freeze.*"
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground"
          >
            See all freeze events on the Timeline →
          </Link>
        </div>
      </FreezeWatchSection>

      <FreezeWatchSection
        eyebrow="Coverage"
        title="Watched contracts by chain"
        description="Coverage cells show where Pharos watches issuer intervention events. Empty cells mean no tracker coverage, not no freeze risk."
      >
        <SovereigntyLattice
          coverage={summary?.coverage}
          stats={summary?.stats}
          chains={summary?.chains ?? []}
          isLoading={summaryLoading}
          onCellSelect={({ stablecoin, chainId }) => {
            handleStablecoinChange(stablecoin);
            handleChainChange(chainId);
          }}
        />
      </FreezeWatchSection>

      <FreezeWatchSection
        eyebrow="Timeline"
        title="Quarterly freeze, release, and wipe events"
        description="Historical event volume by quarter. Use the ledger above for address-level rows."
      >
        <InterventionSeismograph stats={summary?.stats} chart={summary?.chart} isLoading={summaryLoading} />
      </FreezeWatchSection>

      <FreezeWatchSection
        eyebrow="Monitors"
        title="Special-case issuer controls"
        description="Known edge cases that need separate status context."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5">
          <UsdsStatusCard />
          <EurcBlacklistCard />
        </div>
      </FreezeWatchSection>
    </FeaturePageShell>
  );
}
