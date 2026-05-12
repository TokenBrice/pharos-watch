"use client";

import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterSearchInput } from "@/components/filter-search-input";
import { UsdsStatusCard } from "@/components/usds-status-card";
import { EurcBlacklistCard } from "@/components/eurc-blacklist-card";
import { BlacklistStats } from "@/components/blacklist-stats";
import { BlacklistInterventionLedger } from "@/components/blacklist-intervention-ledger";
import { BlacklistChart } from "@/components/blacklist-chart";
import { BlacklistStatusCharts } from "@/components/blacklist-status-charts";
import { BlacklistStatusDrilldown } from "@/components/blacklist-status-drilldown";
import { BlacklistFilters } from "@/components/blacklist-filters";
import { BlacklistTable } from "@/components/blacklist-table";
import { TablePagination } from "@/components/table-pagination";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FreezableSupplyMeter } from "@/components/freezewatch/freezable-supply-meter";
import { InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { useFreezeWatchPageController } from "./view-model";

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

  return (
    <FeaturePageShell
      breadcrumbName="FreezeWatch"
      path="/freezewatch/"
      title="FreezeWatch"
      statusBadge={{
        status: "mature",
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
      }}
      methodology={{
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        "Issuer control over your stablecoin balance — live.",
        "Circle, Tether, Paxos, and other centralized issuers can freeze, unblock, pause, or destroy balances when their contracts give them that control. FreezeWatch records those on-chain actions across supported contracts and chains so you can see which addresses were affected, when it happened, and how much value was involved.",
      ]}
    >
      <QueryErrorNotice
        error={error}
        hasData={!!summary || events.length > 0}
        onRetry={() => {
          void refetchSummary();
          void refetchPage();
        }}
      />
      <StaleDataBanner
        queries={[{ preset: "blacklist", dataUpdatedAt, error, hasData: !!summary || events.length > 0, meta: freshnessMeta }]}
      />

      <FreezableSupplyMeter
        buckets={blacklistStatusBuckets}
        stats={summary?.stats}
        isLoading={summaryLoading || supportDataLoading}
      />

      <InterventionSeismograph
        stats={summary?.stats}
        chart={summary?.chart}
        isLoading={summaryLoading}
      />

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

      <BlacklistStats
        stats={summary?.stats}
        summary={summary}
        freshnessMeta={freshnessMeta}
        isLoading={summaryLoading}
        blacklistStatusBuckets={blacklistStatusBuckets}
        supportDataLoading={supportDataLoading}
        onUnfreezableSelect={() => handleStatusBucketChange("no")}
      />

      <BlacklistInterventionLedger
        stats={summary?.stats}
        chart={summary?.chart}
        buckets={blacklistStatusBuckets}
        isLoading={summaryLoading || supportDataLoading}
      />

      <BlacklistStatusCharts
        buckets={blacklistStatusBuckets}
        isLoading={supportDataLoading}
        selectedStatus={statusBucket}
        onStatusSelect={handleStatusBucketChange}
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
          placeholder="Search by address..."
          className="relative w-full sm:w-56"
          inputClassName="pl-8 h-11 sm:h-8 text-sm sm:text-xs"
          ariaLabel="Search events by address"
        />
      </div>

      <BlacklistTable
        events={events}
        isLoading={pageLoading}
        page={clampedPage}
        pageSize={pageSize}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
      />

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">
        <UsdsStatusCard />
        <EurcBlacklistCard />
      </div>
    </FeaturePageShell>
  );
}
