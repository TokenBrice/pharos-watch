"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReportCardsV9Table } from "@/hooks/api-hooks";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { blacklistSummaryCatchUp } from "@/lib/blacklist-api";
import { buildBlacklistStatusBuckets, type BlacklistStatusBucket } from "@shared/lib/blacklist-status-buckets";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";
import type { StaleQuery } from "@/components/stale-data-banner";
import type {
  BlacklistStablecoin,
  BlacklistEventType,
  BlacklistSortDirection,
  BlacklistSortKey,
} from "@shared/types/blacklist";
import type {
  StablecoinData,
} from "@shared/types/supply";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";
import { type BlacklistStatusBucketKey } from "@shared/lib/blacklist-status-buckets";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set<BlacklistStablecoin | "all">(["all", ...BLACKLIST_STABLECOINS]);
const VALID_EVENT_TYPES = new Set(["all", "blacklist", "unblacklist", "destroy"]);
const VALID_SORT_KEYS = new Set<BlacklistSortKey>(["date", "stablecoin", "chain", "event"]);
const VALID_SORT_DIRECTIONS = new Set<BlacklistSortDirection>(["asc", "desc"]);
const VALID_STATUS_BUCKETS = new Set<BlacklistStatusBucketKey>(["yes", "upstream", "possible", "no"]);

export type FreezeWatchPageFilters = {
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  sortKey: BlacklistSortKey;
  sortDirection: BlacklistSortDirection;
  searchQuery: string;
  statusBucket: BlacklistStatusBucketKey | null;
};

export function parseFreezeWatchPageFilters(search: string): FreezeWatchPageFilters {
  const params = new URLSearchParams(search);
  const rawStablecoin = params.get("stablecoin") ?? params.get("coin") ?? "all";
  const rawChain = params.get("chain") ?? params.get("chainId") ?? "all";
  const rawEventType = params.get("event") ?? "all";
  const rawSortBy = params.get("sortBy") ?? "date";
  const rawSortDirection = params.get("sortDirection") ?? "desc";
  const rawQuery = params.get("q") ?? "";
  const rawStatusBucket = params.get("status");
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
  const searchQuery = rawQuery === "all" ? "" : rawQuery;
  const statusBucket = VALID_STATUS_BUCKETS.has(rawStatusBucket as BlacklistStatusBucketKey)
    ? (rawStatusBucket as BlacklistStatusBucketKey)
    : null;

  return {
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    sortKey,
    sortDirection,
    searchQuery,
    statusBucket,
  };
}

// Complete address formats present in the ledger: EVM (0x + 40 hex) and Tron (T + 33 base58 characters).
const COMPLETE_ADDRESS = /^(?:0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33})$/;

export function isCompleteAddress(value: string): boolean {
  return COMPLETE_ADDRESS.test(value.trim());
}

export type AddressCheck =
  | { kind: "found"; count: number; stablecoin: string; timestamp: number }
  | { kind: "none" };

/**
 * Result of the hero address check. Returns null (no sentence) unless the read
 * settled successfully for exactly this address with the ledger unfiltered;
 * loading, failed or inconsistent reads never produce a result.
 */
export function resolveAddressCheck(input: {
  query: string;
  settled: boolean;
  events: ReadonlyArray<{ address: string; stablecoin: string; timestamp: number }>;
  total: number;
}): AddressCheck | null {
  const query = input.query.trim();
  if (!input.settled || !isCompleteAddress(query)) return null;
  if (input.events.length === 0) return input.total === 0 ? { kind: "none" } : null;
  const matches = input.events.filter((e) => e.address.toLowerCase() === query.toLowerCase());
  if (matches.length !== input.events.length || input.total < matches.length) return null;
  const latest = matches.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  return { kind: "found", count: input.total, stablecoin: latest.stablecoin, timestamp: latest.timestamp };
}

export function useFreezeWatchPageController() {
  const {
    data: summary,
    isLoading: summaryLoading,
    error: summaryError,
    dataUpdatedAt: summaryUpdatedAt,
    refetch: refetchSummary,
    meta: summaryMeta,
  } = useBlacklistSummary();
  const {
    data: stablecoinData,
    isLoading: supportStablecoinsLoading,
    error: supportStablecoinsError,
    dataUpdatedAt: stablecoinsUpdatedAt,
    refetch: refetchStablecoins,
    meta: stablecoinsMeta,
  } = useStablecoins();
  const {
    data: reportCardsData,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCardsV9Table();
  const { searchParams, replaceParams } = useUrlFilters();
  const parsedFilters = useMemo(() => parseFreezeWatchPageFilters(searchParams.toString()), [searchParams]);
  const reportCardMap = useMemo(
    () => {
      if (!reportCardsData) return undefined;
      const projected = buildV9SafetyTableMap(reportCardsData, reportCardsData.safetyScoreIdentity);
      return projected.status === "available" ? projected.value : undefined;
    },
    [reportCardsData],
  );
  const blacklistStatusBuckets = useMemo<BlacklistStatusBucket[] | null>(
    () => (stablecoinData ? buildBlacklistStatusBuckets(stablecoinData.peggedAssets) : null),
    [stablecoinData],
  );

  const { stablecoinFilter, chainFilter, eventTypeFilter, sortKey, sortDirection, searchQuery, statusBucket } =
    parsedFilters;
  const drilldownRef = useRef<HTMLDivElement>(null);
  const previousStatusBucketRef = useRef<BlacklistStatusBucketKey | null>(statusBucket);

  const [searchInput, setSearchInput] = useState(() => searchQuery);
  const [filtersClearedForAddressCheck, setFiltersClearedForAddressCheck] = useState(false);
  const searchSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [syncedSearchQuery, setSyncedSearchQuery] = useState(searchQuery);
  if (syncedSearchQuery !== searchQuery) {
    setSyncedSearchQuery(searchQuery);
    setSearchInput(searchQuery);
  }

  useEffect(
    () => () => {
      if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current);
    },
    [searchQuery],
  );

  const pageSize = PAGE_SIZE;
  const ledgerKey = JSON.stringify([stablecoinFilter, chainFilter, eventTypeFilter, searchQuery, sortKey, sortDirection]);
  const [navigation, setNavigation] = useState<{ key: string; cursors: Array<string | undefined>; index: number }>(
    () => ({ key: ledgerKey, cursors: [undefined], index: 0 }),
  );
  const activeNavigation = useMemo(
    () => navigation.key === ledgerKey
      ? navigation
      : { key: ledgerKey, cursors: [undefined] as Array<string | undefined>, index: 0 },
    [navigation, ledgerKey],
  );
  const page = activeNavigation.index + 1;
  const {
    data: pageData,
    isLoading: pageQueryLoading,
    error: pageError,
    dataUpdatedAt: pageUpdatedAt,
    refetch: refetchPage,
    meta: pageMeta,
  } = useBlacklistEventsPage({
    stablecoin: stablecoinFilter,
    chainId: chainFilter === "all" ? undefined : chainFilter,
    eventType: eventTypeFilter,
    query: searchQuery,
    sortBy: sortKey,
    sortDirection,
    limit: pageSize,
    cursor: activeNavigation.cursors[activeNavigation.index],
    includeTotal: true,
  });
  // Optional drilldown Safety Grades (`reportCards`) stay out of page-top error
  // and freshness notices so an optional drilldown column cannot trigger a red alarm.
  const error = summaryError ?? pageError ?? supportStablecoinsError;
  const freshnessQueries: StaleQuery[] = [
    {
      preset: "blacklist", label: "Blacklist summary", dataUpdatedAt: summaryUpdatedAt,
      error: summaryError, hasData: summary != null, isLoading: summaryLoading, meta: summaryMeta,
      catchUp: summaryMeta ? blacklistSummaryCatchUp(summary?.refresh) : null,
    },
    {
      preset: "blacklist", label: "Blacklist ledger", dataUpdatedAt: pageUpdatedAt,
      error: pageError, hasData: pageData != null, isLoading: pageQueryLoading, meta: pageMeta,
    },
    {
      preset: "stablecoins", label: "Supply", dataUpdatedAt: stablecoinsUpdatedAt,
      error: supportStablecoinsError, hasData: stablecoinData != null,
      isLoading: supportStablecoinsLoading, meta: stablecoinsMeta,
    },
  ];

  const updateFilters = useCallback(
    (updates: Partial<FreezeWatchPageFilters>) => {
      const next: FreezeWatchPageFilters = {
        ...parsedFilters,
        ...updates,
      };
      replaceParams((params) => {
        if (next.stablecoinFilter !== "all") params.set("stablecoin", next.stablecoinFilter);
        else params.delete("stablecoin");

        params.delete("chainId");
        if (next.chainFilter !== "all") params.set("chain", next.chainFilter);
        else params.delete("chain");

        if (next.eventTypeFilter !== "all") params.set("event", next.eventTypeFilter);
        else params.delete("event");

        if (next.sortKey !== "date") params.set("sortBy", next.sortKey);
        else params.delete("sortBy");

        if (next.sortDirection !== "desc") params.set("sortDirection", next.sortDirection);
        else params.delete("sortDirection");

        params.delete("page");

        const query = next.searchQuery.trim();
        if (query) params.set("q", query);
        else params.delete("q");

        if (next.statusBucket) params.set("status", next.statusBucket);
        else params.delete("status");
      });
    },
    [parsedFilters, replaceParams],
  );

  const updateFiltersRef = useRef(updateFilters);
  useEffect(() => {
    updateFiltersRef.current = updateFilters;
  }, [updateFilters]);

  useEffect(() => {
    if (statusBucket && previousStatusBucketRef.current !== statusBucket) {
      drilldownRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    previousStatusBucketRef.current = statusBucket;
  }, [statusBucket]);

  const hasConflictingAddressFilters =
    stablecoinFilter !== "all" ||
    chainFilter !== "all" ||
    eventTypeFilter !== "all" ||
    sortKey !== "date" ||
    sortDirection !== "desc" ||
    page > 1;

  const hasActiveLedgerFilters =
    stablecoinFilter !== "all" ||
    chainFilter !== "all" ||
    eventTypeFilter !== "all" ||
    sortKey !== "date" ||
    sortDirection !== "desc" ||
    searchInput.trim().length > 0 ||
    searchQuery.trim().length > 0;

  const handleStablecoinChange = useCallback(
    (v: BlacklistStablecoin | "all") => {
      setFiltersClearedForAddressCheck(false);
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "stablecoin", filter_value: v });
      updateFilters({ stablecoinFilter: v });
    },
    [updateFilters],
  );

  const handleChainChange = useCallback(
    (v: string) => {
      setFiltersClearedForAddressCheck(false);
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "chain", filter_value: v });
      updateFilters({ chainFilter: v });
    },
    [updateFilters],
  );

  const handleLatticeSelection = useCallback(
    ({ stablecoin, chainId }: { stablecoin: BlacklistStablecoin; chainId: string }) => {
      setFiltersClearedForAddressCheck(false);
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "stablecoin", filter_value: stablecoin });
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "chain", filter_value: chainId });
      updateFilters({ stablecoinFilter: stablecoin, chainFilter: chainId });
    },
    [updateFilters],
  );

  const handleEventTypeChange = useCallback(
    (v: BlacklistEventType | "all") => {
      setFiltersClearedForAddressCheck(false);
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "event_type", filter_value: v });
      updateFilters({ eventTypeFilter: v });
    },
    [updateFilters],
  );

  const handleSearchChange = useCallback(
    (v: string) => {
      setSearchInput(v);
      if (!v.trim()) setFiltersClearedForAddressCheck(false);
      if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current);
      searchSyncTimer.current = setTimeout(() => {
        trackSearch("freezewatch", v.length);
        updateFiltersRef.current({ searchQuery: v });
      }, 300);
    },
    [],
  );

  const runUnfilteredAddressCheck = useCallback(
    (rawAddress: string) => {
      const trimmed = rawAddress.trim();
      if (searchSyncTimer.current) {
        clearTimeout(searchSyncTimer.current);
        searchSyncTimer.current = null;
      }
      setSearchInput(rawAddress);
      const shouldClear = hasConflictingAddressFilters;
      setFiltersClearedForAddressCheck(shouldClear && trimmed.length > 0);
      if (page > 1) {
        setNavigation({ key: ledgerKey, cursors: [undefined], index: 0 });
      }
      if (trimmed.length > 0) {
        trackSearch("freezewatch", trimmed.length);
      }
      updateFilters({
        searchQuery: trimmed,
        ...(shouldClear
          ? {
              stablecoinFilter: "all",
              chainFilter: "all",
              eventTypeFilter: "all",
              sortKey: "date",
              sortDirection: "desc",
            }
          : {}),
      });
    },
    [hasConflictingAddressFilters, ledgerKey, page, updateFilters],
  );

  const handleHeroAddressChange = useCallback(
    (v: string) => {
      if (isCompleteAddress(v) && hasConflictingAddressFilters) {
        runUnfilteredAddressCheck(v);
        return;
      }
      handleSearchChange(v);
    },
    [handleSearchChange, hasConflictingAddressFilters, runUnfilteredAddressCheck],
  );

  const handleHeroAddressSubmit = useCallback(() => {
    runUnfilteredAddressCheck(searchInput);
  }, [runUnfilteredAddressCheck, searchInput]);

  const handleResetFilters = useCallback(() => {
    if (searchSyncTimer.current) {
      clearTimeout(searchSyncTimer.current);
      searchSyncTimer.current = null;
    }
    setSearchInput("");
    setFiltersClearedForAddressCheck(false);
    setNavigation({ key: ledgerKey, cursors: [undefined], index: 0 });
    updateFilters({
      stablecoinFilter: "all",
      chainFilter: "all",
      eventTypeFilter: "all",
      sortKey: "date",
      sortDirection: "desc",
      searchQuery: "",
    });
  }, [ledgerKey, updateFilters]);

  const handleSortChange = useCallback(
    (nextSortKey: BlacklistSortKey, nextSortDirection: BlacklistSortDirection) => {
      setFiltersClearedForAddressCheck(false);
      trackEvent("sort_changed", {
        page: "freezewatch",
        sort_by: `${nextSortKey}:${nextSortDirection}`,
      });
      updateFilters({ sortKey: nextSortKey, sortDirection: nextSortDirection });
    },
    [updateFilters],
  );

  const handleStatusBucketChange = useCallback(
    (status: BlacklistStatusBucketKey) => {
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "blacklist_status", filter_value: status });
      updateFilters({ statusBucket: status });
    },
    [updateFilters],
  );

  const handleStatusBucketClear = useCallback(() => {
    updateFilters({ statusBucket: null });
  }, [updateFilters]);

  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = page;
  const pageLoading = pageQueryLoading;
  const events = pageData?.events ?? [];
  const rangeStart = events.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = events.length === 0 ? 0 : (page - 1) * PAGE_SIZE + events.length;
  const canPreviousPage = activeNavigation.index > 0 && !pageLoading;
  const nextCursor = pageData?.nextCursor;
  const canNextPage = !pageLoading && !!nextCursor;

  const handlePreviousPage = useCallback(() => {
    if (!canPreviousPage) return;
    setNavigation({ ...activeNavigation, index: activeNavigation.index - 1 });
  }, [activeNavigation, canPreviousPage]);

  const handleNextPage = useCallback(() => {
    if (!canNextPage || !nextCursor) return;
    const nextIndex = activeNavigation.index + 1;
    setNavigation({
      key: ledgerKey,
      cursors: [...activeNavigation.cursors.slice(0, nextIndex), nextCursor],
      index: nextIndex,
    });
  }, [activeNavigation, canNextPage, ledgerKey, nextCursor]);

  const refetchSupport = useCallback(() => {
    void refetchStablecoins();
    void refetchReportCards();
  }, [refetchReportCards, refetchStablecoins]);

  return {
    summary,
    summaryLoading,
    summaryError,
    pageError,
    error,
    freshnessQueries,
    sourceGenerations: { stablecoins: stablecoinsMeta?.updatedAt, reportCards: reportCardsMeta?.updatedAt },
    stablecoins: stablecoinData?.peggedAssets as StablecoinData[] | undefined,
    stablecoinFxFallbackRates: stablecoinData?.fxFallbackRates,
    stablecoinsError: supportStablecoinsError,
    reportCardMap,
    reportCardsMethodologyVersion: reportCardsData?.safetyScoreIdentity?.methodologyVersion ?? null,
    blacklistStatusBuckets,
    supportDataLoading: supportStablecoinsLoading,
    refetchSummary,
    refetchPage,
    refetchSupport,
    statusBucket,
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    sortKey,
    sortDirection,
    page,
    pageSize,
    searchInput,
    searchQuery,
    pageLoading,
    // A stale ledger or an inexact total must not back a "no event recorded" sentence.
    pageSettled: pageData != null && !pageError && !pageQueryLoading
      && pageMeta != null && pageMeta.status !== "stale" && pageData.totalExact !== false,
    events,
    drilldownRef,
    hasActiveLedgerFilters,
    hasConflictingAddressFilters,
    filtersClearedForAddressCheck,
    handleStablecoinChange,
    handleChainChange,
    handleLatticeSelection,
    handleEventTypeChange,
    handleSearchChange,
    handleHeroAddressChange,
    handleHeroAddressSubmit,
    handleResetFilters,
    handleSortChange,
    handleStatusBucketChange,
    handleStatusBucketClear,
    handlePreviousPage,
    handleNextPage,
    clampedPage,
    total,
    totalPages,
    canPreviousPage,
    canNextPage,
    rangeStart,
    rangeEnd,
  };
}
