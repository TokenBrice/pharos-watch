"use client";

import { useMemo, useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { FeatureStatusBadge } from "@/components/feature-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@/lib/blacklist-tracker-version";
import type { BlacklistStablecoin, BlacklistEventType } from "@/lib/types";
import { trackEvent, trackSearch } from "@/lib/analytics";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set(["all", "USDC", "USDT", "PAXG", "XAUT"]);
const VALID_EVENT_TYPES = new Set(["all", "blacklist", "unblacklist", "destroy"]);

type FilterState = {
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  page: number;
  searchQuery: string;
};

const DEFAULT_FILTERS: FilterState = {
  stablecoinFilter: "all",
  chainFilter: "all",
  eventTypeFilter: "all",
  page: 1,
  searchQuery: "",
};

function getInitialFilters(): FilterState {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  return parseFilters(window.location.search);
}

function parseFilters(search: string): FilterState {
  const params = new URLSearchParams(search);
  const rawStablecoin = params.get("stablecoin") ?? "all";
  const rawChain = params.get("chain") ?? "all";
  const rawEventType = params.get("event") ?? "all";
  const rawPage = params.get("page");
  const rawQuery = params.get("q") ?? "";

  const stablecoinFilter = (VALID_STABLECOINS.has(rawStablecoin) ? rawStablecoin : "all") as BlacklistStablecoin | "all";
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

function buildQueryString(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.stablecoinFilter !== "all") params.set("stablecoin", filters.stablecoinFilter);
  if (filters.chainFilter !== "all") params.set("chain", filters.chainFilter);
  if (filters.eventTypeFilter !== "all") params.set("event", filters.eventTypeFilter);
  if (filters.page > 1) params.set("page", String(filters.page));
  const query = filters.searchQuery.trim();
  if (query) params.set("q", query);
  return params.toString();
}

function BlacklistPageInner() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useBlacklistEvents();
  const events = data?.events;

  const [stablecoinFilter, setStablecoinFilter] = useState<BlacklistStablecoin | "all">(
    () => getInitialFilters().stablecoinFilter,
  );
  const [chainFilter, setChainFilter] = useState<string>(
    () => getInitialFilters().chainFilter,
  );
  const [eventTypeFilter, setEventTypeFilter] = useState<BlacklistEventType | "all">(
    () => getInitialFilters().eventTypeFilter,
  );
  const [page, setPage] = useState<number>(() => getInitialFilters().page);
  const [searchQuery, setSearchQuery] = useState<string>(
    () => getInitialFilters().searchQuery,
  );

  const syncFiltersFromLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    const parsed = parseFilters(window.location.search);
    setStablecoinFilter(parsed.stablecoinFilter);
    setChainFilter(parsed.chainFilter);
    setEventTypeFilter(parsed.eventTypeFilter);
    setPage(parsed.page);
    setSearchQuery(parsed.searchQuery);
  }, []);

  useEffect(() => {
    window.addEventListener("popstate", syncFiltersFromLocation);
    return () => window.removeEventListener("popstate", syncFiltersFromLocation);
  }, [syncFiltersFromLocation]);

  const replaceUrl = useCallback((updates: Partial<FilterState>) => {
    if (typeof window === "undefined") return;
    const next: FilterState = {
      stablecoinFilter,
      chainFilter,
      eventTypeFilter,
      page,
      searchQuery,
      ...updates,
    };
    const qs = buildQueryString(next);
    const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }, [stablecoinFilter, chainFilter, eventTypeFilter, page, searchQuery]);

  const handleStablecoinChange = useCallback((v: BlacklistStablecoin | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "stablecoin", filter_value: v });
    setStablecoinFilter(v);
    setPage(1);
    replaceUrl({ stablecoinFilter: v, page: 1 });
  }, [replaceUrl]);

  const handleChainChange = useCallback((v: string) => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "chain", filter_value: v });
    setChainFilter(v);
    setPage(1);
    replaceUrl({ chainFilter: v, page: 1 });
  }, [replaceUrl]);

  const handleEventTypeChange = useCallback((v: BlacklistEventType | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "event_type", filter_value: v });
    setEventTypeFilter(v);
    setPage(1);
    replaceUrl({ eventTypeFilter: v, page: 1 });
  }, [replaceUrl]);

  const handleSearchChange = useCallback((v: string) => {
    trackSearch("blacklist", v.length);
    setSearchQuery(v);
    setPage(1);
    replaceUrl({ searchQuery: v, page: 1 });
  }, [replaceUrl]);

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

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Blacklist Tracker</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">
          Blacklist Tracker <FeatureStatusBadge status="mature" version={BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL} />
        </h1>
        <p className="text-xs text-muted-foreground">
          Methodology {BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}.{" "}
          <Link
            href={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            Version history &rarr;
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          Who got frozen. When. Why it matters.
        </p>
        <p className="text-sm text-muted-foreground">
          Centralized stablecoin issuers like Circle and Tether can freeze or destroy tokens at any address.
          This tracker documents every on-chain blacklist, unblacklist, and destroy event, giving you a
          transparent record of issuer intervention across Ethereum and Tron.
        </p>
      </div>

      <QueryErrorNotice
        error={error}
        hasData={!!events?.length}
        onRetry={() => {
          void refetch();
        }}
      />
      <StaleDataBanner
        queries={[{ preset: "blacklist", dataUpdatedAt, error, hasData: !!events?.length }]}
      />

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

      <BlacklistTable
        events={filtered}
        isLoading={isLoading}
        page={page}
        pageSize={PAGE_SIZE}
      />

      {filtered.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Showing <span className="font-mono">{Math.min((page - 1) * PAGE_SIZE + 1, filtered.length)}</span>&ndash;<span className="font-mono">{Math.min(page * PAGE_SIZE, filtered.length)}</span> of <span className="font-mono">{filtered.length}</span> events
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                const nextPage = Math.max(1, page - 1);
                setPage(nextPage);
                replaceUrl({ page: nextPage });
              }}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                const nextPage = Math.min(totalPages, page + 1);
                setPage(nextPage);
                replaceUrl({ page: nextPage });
              }}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">
        <UsdsStatusCard />
        <EurcBlacklistCard />
      </div>
    </div>
  );
}

export default function BlacklistPage() {
  return <BlacklistPageInner />;
}
