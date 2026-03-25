"use client";

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { UsdsStatusCard } from "@/components/usds-status-card";
import { EurcBlacklistCard } from "@/components/eurc-blacklist-card";
import { BlacklistStats } from "@/components/blacklist-stats";
import { BlacklistChart } from "@/components/blacklist-chart";
import { BlacklistFilters } from "@/components/blacklist-filters";
import { BlacklistTable } from "@/components/blacklist-table";
import { TablePagination } from "@/components/table-pagination";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Input } from "@/components/ui/input";
import { useUrlFilters } from "@/hooks/use-url-filters";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistStablecoin,
  type BlacklistEventType,
  type BlacklistSortDirection,
  type BlacklistSortKey,
} from "@shared/types";
import { trackEvent, trackSearch } from "@/lib/analytics";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set<BlacklistStablecoin | "all">(["all", ...BLACKLIST_STABLECOINS]);
const VALID_EVENT_TYPES = new Set(["all", "blacklist", "unblacklist", "destroy"]);
const VALID_SORT_KEYS = new Set<BlacklistSortKey>(["date", "stablecoin", "chain", "event"]);
const VALID_SORT_DIRECTIONS = new Set<BlacklistSortDirection>(["asc", "desc"]);

type FilterState = {
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  sortKey: BlacklistSortKey;
  sortDirection: BlacklistSortDirection;
  page: number;
  searchQuery: string;
};

function parseFilters(search: string): FilterState {
  const params = new URLSearchParams(search);
  const rawStablecoin = params.get("stablecoin") ?? "all";
  const rawChain = params.get("chain") ?? "all";
  const rawEventType = params.get("event") ?? "all";
  const rawSortBy = params.get("sortBy") ?? "date";
  const rawSortDirection = params.get("sortDirection") ?? "desc";
  const rawPage = params.get("page");
  const rawQuery = params.get("q") ?? "";
  const normalizedStablecoin = rawStablecoin === "all" ? "all" : rawStablecoin.toUpperCase();

  const stablecoinFilter = (
    VALID_STABLECOINS.has(normalizedStablecoin as BlacklistStablecoin | "all") ? normalizedStablecoin : "all"
  ) as BlacklistStablecoin | "all";
  const chainFilter = rawChain || "all";
  const eventTypeFilter = (VALID_EVENT_TYPES.has(rawEventType) ? rawEventType : "all") as BlacklistEventType | "all";
  const sortKey = (VALID_SORT_KEYS.has(rawSortBy as BlacklistSortKey) ? rawSortBy : "date") as BlacklistSortKey;
  const sortDirection = (
    VALID_SORT_DIRECTIONS.has(rawSortDirection as BlacklistSortDirection) ? rawSortDirection : "desc"
  ) as BlacklistSortDirection;
  const page = rawPage ? Math.max(1, Number.parseInt(rawPage, 10) || 1) : 1;
  const searchQuery = rawQuery === "all" ? "" : rawQuery;

  return {
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    sortKey,
    sortDirection,
    page,
    searchQuery,
  };
}

function BlacklistPageInner() {
  const {
    data: summary,
    isLoading: summaryLoading,
    error: summaryError,
    dataUpdatedAt: summaryUpdatedAt,
    refetch: refetchSummary,
  } = useBlacklistSummary();
  const { searchParams, replaceParams } = useUrlFilters();
  const parsedFilters = useMemo(() => parseFilters(searchParams.toString()), [searchParams]);

  const { stablecoinFilter, chainFilter, eventTypeFilter, sortKey, sortDirection, page, searchQuery } = parsedFilters;

  // Local search state for instant input, debounced sync to URL + API
  const [searchInput, setSearchInput] = useState(() => searchQuery);
  const searchSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    // Sync URL → local when navigating back/forward
    setSearchInput(searchQuery);
  }, [searchQuery]);
  const selectedChainName = useMemo(
    () => summary?.chains.find((chain) => chain.id === chainFilter)?.name ?? "all",
    [summary?.chains, chainFilter],
  );
  const pageSize = PAGE_SIZE;
  const offset = (page - 1) * pageSize;
  const {
    data: pageData,
    isLoading: pageLoading,
    error: pageError,
    dataUpdatedAt: pageUpdatedAt,
    refetch: refetchPage,
  } = useBlacklistEventsPage({
    stablecoin: stablecoinFilter,
    chainName: selectedChainName,
    eventType: eventTypeFilter,
    query: searchQuery,
    sortBy: sortKey,
    sortDirection,
    limit: pageSize,
    offset,
  });
  const events = pageData?.events ?? [];
  const error = summaryError ?? pageError;
  const dataUpdatedAt = Math.max(summaryUpdatedAt, pageUpdatedAt);

  const updateFilters = useCallback(
    (updates: Partial<FilterState>) => {
      const next: FilterState = {
        ...parsedFilters,
        ...updates,
      };
      replaceParams((params) => {
        if (next.stablecoinFilter !== "all") params.set("stablecoin", next.stablecoinFilter);
        else params.delete("stablecoin");

        if (next.chainFilter !== "all") params.set("chain", next.chainFilter);
        else params.delete("chain");

        if (next.eventTypeFilter !== "all") params.set("event", next.eventTypeFilter);
        else params.delete("event");

        if (next.sortKey !== "date") params.set("sortBy", next.sortKey);
        else params.delete("sortBy");

        if (next.sortDirection !== "desc") params.set("sortDirection", next.sortDirection);
        else params.delete("sortDirection");

        if (next.page > 1) params.set("page", String(next.page));
        else params.delete("page");

        const query = next.searchQuery.trim();
        if (query) params.set("q", query);
        else params.delete("q");
      });
    },
    [parsedFilters, replaceParams],
  );

  const handleStablecoinChange = useCallback(
    (v: BlacklistStablecoin | "all") => {
      trackEvent("filter_applied", { page: "blacklist", filter_type: "stablecoin", filter_value: v });
      updateFilters({ stablecoinFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleChainChange = useCallback(
    (v: string) => {
      trackEvent("filter_applied", { page: "blacklist", filter_type: "chain", filter_value: v });
      updateFilters({ chainFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleEventTypeChange = useCallback(
    (v: BlacklistEventType | "all") => {
      trackEvent("filter_applied", { page: "blacklist", filter_type: "event_type", filter_value: v });
      updateFilters({ eventTypeFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleSearchChange = useCallback(
    (v: string) => {
      setSearchInput(v);
      if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current);
      searchSyncTimer.current = setTimeout(() => {
        trackSearch("blacklist", v.length);
        updateFilters({ searchQuery: v, page: 1 });
      }, 300);
    },
    [updateFilters],
  );

  const handleSortChange = useCallback(
    (nextSortKey: BlacklistSortKey, nextSortDirection: BlacklistSortDirection) => {
      trackEvent("sort_changed", {
        page: "blacklist",
        sort_by: `${nextSortKey}:${nextSortDirection}`,
      });
      updateFilters({ sortKey: nextSortKey, sortDirection: nextSortDirection, page: 1 });
    },
    [updateFilters],
  );

  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const rangeStart = total === 0 ? 0 : (clampedPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(clampedPage * PAGE_SIZE, total);

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
      <StaleDataBanner queries={[{ preset: "blacklist", dataUpdatedAt, error, hasData: !!summary || events.length > 0 }]} />

      <BlacklistStats stats={summary?.stats} isLoading={summaryLoading} />

      <BlacklistChart chart={summary?.chart} isLoading={summaryLoading} />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <BlacklistFilters
          chains={summary?.chains ?? []}
          stablecoinFilter={stablecoinFilter}
          chainFilter={chainFilter}
          eventTypeFilter={eventTypeFilter}
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
        pageSize={PAGE_SIZE}
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
          onPrevious={() => {
            const nextPage = Math.max(1, clampedPage - 1);
            updateFilters({ page: nextPage });
          }}
          onNext={() => {
            const nextPage = Math.min(totalPages, clampedPage + 1);
            updateFilters({ page: nextPage });
          }}
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
