"use client";

import { Search } from "lucide-react";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { UsdsStatusCard } from "@/components/usds-status-card";
import { EurcBlacklistCard } from "@/components/eurc-blacklist-card";
import { BlacklistStats } from "@/components/blacklist-stats";
import { BlacklistChart } from "@/components/blacklist-chart";
import { BlacklistStatusCharts } from "@/components/blacklist-status-charts";
import { BlacklistStatusDrilldown } from "@/components/blacklist-status-drilldown";
import { BlacklistFilters } from "@/components/blacklist-filters";
import { BlacklistTable } from "@/components/blacklist-table";
import { TablePagination } from "@/components/table-pagination";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Input } from "@/components/ui/input";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { useBlacklistPageController } from "./view-model";

function BlacklistPageInner() {
  const {
    summary,
    summaryLoading,
    error,
    dataUpdatedAt,
    freshnessMeta,
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
  } = useBlacklistPageController();

  return (
    <FeaturePageShell
      breadcrumbName="Blacklist Tracker"
      path="/blacklist/"
      title="Blacklist Tracker"
      statusBadge={{
        status: "mature",
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
      }}
      methodology={{
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        "Who got frozen. When. Why it matters.",
        "Centralized stablecoin issuers like Circle and Tether can freeze or destroy tokens at any address. This tracker documents every on-chain blacklist, unblacklist, and destroy event, giving you a transparent record of issuer intervention across Ethereum and Tron.",
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

      <BlacklistStats stats={summary?.stats} isLoading={summaryLoading} />

      <BlacklistStatusCharts selectedStatus={statusBucket} onStatusSelect={handleStatusBucketChange} />

      {statusBucket ? (
        <div ref={drilldownRef}>
          <BlacklistStatusDrilldown status={statusBucket} onClear={handleStatusBucketClear} />
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
        <div className="relative w-full sm:w-56">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by address..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8 h-11 sm:h-8 text-sm sm:text-xs"
            aria-label="Search events by address"
          />
        </div>
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

export default function BlacklistPage() {
  return <BlacklistPageInner />;
}
