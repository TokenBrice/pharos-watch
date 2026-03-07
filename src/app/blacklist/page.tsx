"use client";

import { useMemo, useCallback } from "react";
import { Search } from "lucide-react";
import { useBlacklistEvents } from "@/hooks/use-blacklist-events";
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
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistEventType } from "@shared/types";
import { trackEvent, trackSearch } from "@/lib/analytics";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set<BlacklistStablecoin | "all">(["all", ...BLACKLIST_STABLECOINS]);
const VALID_EVENT_TYPES = new Set(["all", "blacklist", "unblacklist", "destroy"]);

type FilterState = {
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  page: number;
  searchQuery: string;
};

function parseFilters(search: string): FilterState {
  const params = new URLSearchParams(search);
  const rawStablecoin = params.get("stablecoin") ?? "all";
  const rawChain = params.get("chain") ?? "all";
  const rawEventType = params.get("event") ?? "all";
  const rawPage = params.get("page");
  const rawQuery = params.get("q") ?? "";
  const normalizedStablecoin = rawStablecoin === "all" ? "all" : rawStablecoin.toUpperCase();

  const stablecoinFilter = (
    VALID_STABLECOINS.has(normalizedStablecoin as BlacklistStablecoin | "all") ? normalizedStablecoin : "all"
  ) as BlacklistStablecoin | "all";
  const chainFilter = rawChain || "all";
  const eventTypeFilter = (VALID_EVENT_TYPES.has(rawEventType) ? rawEventType : "all") as BlacklistEventType | "all";
  const page = rawPage ? Math.max(1, Number.parseInt(rawPage, 10) || 1) : 1;
  const searchQuery = rawQuery === "all" ? "" : rawQuery;

  return {
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    page,
    searchQuery,
  };
}

function BlacklistPageInner() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useBlacklistEvents();
  const events = data?.events;
  const { searchParams, replaceParams } = useUrlFilters();
  const parsedFilters = useMemo(() => parseFilters(searchParams.toString()), [searchParams]);

  const { stablecoinFilter, chainFilter, eventTypeFilter, page, searchQuery } = parsedFilters;

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
      trackSearch("blacklist", v.length);
      updateFilters({ searchQuery: v, page: 1 });
    },
    [updateFilters],
  );

  const filtered = useMemo(() => {
    if (!events) return [];
    const q = searchQuery.toLowerCase().trim();
    return events.filter((evt) => {
      if (stablecoinFilter !== "all" && evt.stablecoin !== stablecoinFilter) return false;
      if (chainFilter !== "all" && evt.chainId !== chainFilter) return false;
      if (eventTypeFilter !== "all" && evt.eventType !== eventTypeFilter) return false;
      if (q && !evt.address.toLowerCase().includes(q) && !evt.stablecoin.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, stablecoinFilter, chainFilter, eventTypeFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rangeStart = filtered.length === 0 ? 0 : Math.min((page - 1) * PAGE_SIZE + 1, filtered.length);
  const rangeEnd = Math.min(page * PAGE_SIZE, filtered.length);

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
        hasData={!!events?.length}
        onRetry={() => {
          void refetch();
        }}
      />
      <StaleDataBanner queries={[{ preset: "blacklist", dataUpdatedAt, error, hasData: !!events?.length }]} />

      <BlacklistStats events={events} isLoading={isLoading} />

      <BlacklistChart events={events} isLoading={isLoading} />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <BlacklistFilters
          events={events}
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
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8 h-11 sm:h-8 text-sm sm:text-xs"
            aria-label="Search events by address"
          />
        </div>
      </div>

      <BlacklistTable events={filtered} isLoading={isLoading} page={page} pageSize={PAGE_SIZE} />

      {filtered.length > 0 && (
        <TablePagination
          page={page - 1}
          totalPages={totalPages}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={filtered.length}
          onPrevious={() => {
            const nextPage = Math.max(1, page - 1);
            updateFilters({ page: nextPage });
          }}
          onNext={() => {
            const nextPage = Math.min(totalPages, page + 1);
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
