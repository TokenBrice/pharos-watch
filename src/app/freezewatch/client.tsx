"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterSearchInput } from "@/components/filter-search-input";
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
import { FreezableSupplyMeter } from "@/components/freezewatch/freezable-supply-meter";
import { InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
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
        "Live issuer freeze, release, and wipe events across supported stablecoin contracts.",
      ]}
      headerSupplement={(
        <p className="pharos-lead hidden sm:block">
          Use FreezeWatch to see affected addresses, chains, timing, current frozen value, and whether each asset has
          direct or upstream freeze exposure.
        </p>
      )}
    >
      {focusedCoin ? (
        <CoinCrossTrackerHatnote
          coinId={focusedCoin.id}
          coinSymbol={focusedCoin.symbol}
          currentTracker="freezewatch"
        />
      ) : null}
      <QueryErrorNotice
        error={error}
        hasData={!!summary || events.length > 0}
        onRetry={() => {
          void refetchSummary();
          void refetchPage();
        }}
      />
      <StaleDataBanner
        queries={[
          { preset: "blacklist", dataUpdatedAt, error, hasData: !!summary || events.length > 0, meta: freshnessMeta },
        ]}
      />

      {stablecoinFilter !== "all" && coinIdBySymbol(stablecoinFilter) ? (
        <CoinCrossTrackerHatnote
          coinId={coinIdBySymbol(stablecoinFilter)!}
          coinSymbol={stablecoinFilter}
          currentTracker="freezewatch"
        />
      ) : null}

      <FreezeWatchSection
        eyebrow="Exposure"
        title="Who can freeze value"
        description="Market-cap exposure and current frozen value in one summary."
      >
        <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
          <FreezableSupplyMeter
            buckets={blacklistStatusBuckets}
            isLoading={summaryLoading || supportDataLoading}
            selectedBucket={statusBucket}
            onBucketSelect={handleStatusBucketChange}
          />
          <BlacklistStats
            stats={summary?.stats}
            isLoading={summaryLoading}
            blacklistStatusBuckets={blacklistStatusBuckets}
            supportDataLoading={supportDataLoading}
            onUnfreezableSelect={() => handleStatusBucketChange("no")}
          />
        </div>
      </FreezeWatchSection>

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
        <div className="pharos-card-shell rounded-xl">
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
