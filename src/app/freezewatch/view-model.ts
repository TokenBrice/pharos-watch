"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { buildBlacklistStatusBuckets, type BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";
import type {
  BlacklistStablecoin,
  BlacklistEventType,
  BlacklistSortDirection,
  BlacklistSortKey,
  StablecoinData,
} from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { type BlacklistStatusBucketKey } from "@/lib/blacklist-status-buckets";

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
  page: number;
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
  const rawPage = params.get("page");
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
  const parsed = Number(rawPage);
  const page = rawPage && Number.isFinite(parsed) && parsed >= 1 ? Math.max(1, Math.floor(parsed)) : 1;
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
    page,
    searchQuery,
    statusBucket,
  };
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
  const { data: stablecoinData, isLoading: supportStablecoinsLoading } = useStablecoins();
  const { data: reportCardsData, isLoading: supportReportCardsLoading } = useReportCardsV9();
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
    () => (stablecoinData ? buildBlacklistStatusBuckets(stablecoinData.peggedAssets, reportCardMap) : null),
    [reportCardMap, stablecoinData],
  );

  const { stablecoinFilter, chainFilter, eventTypeFilter, sortKey, sortDirection, page, searchQuery, statusBucket } =
    parsedFilters;
  const drilldownRef = useRef<HTMLDivElement>(null);
  const previousStatusBucketRef = useRef<BlacklistStatusBucketKey | null>(statusBucket);

  const [searchInput, setSearchInput] = useState(() => searchQuery);
  const searchSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  useEffect(
    () => () => {
      if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current);
    },
    [],
  );

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
    meta: pageMeta,
  } = useBlacklistEventsPage({
    stablecoin: stablecoinFilter,
    chainName: selectedChainName,
    eventType: eventTypeFilter,
    query: searchQuery,
    sortBy: sortKey,
    sortDirection,
    limit: pageSize,
    offset,
    includeTotal: true,
  });
  const events = pageData?.events ?? [];
  const error = summaryError ?? pageError;
  const dataUpdatedAt = Math.max(summaryUpdatedAt, pageUpdatedAt);
  const freshnessMeta = summaryMeta ?? pageMeta;

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

        if (next.page > 1) params.set("page", String(next.page));
        else params.delete("page");

        const query = next.searchQuery.trim();
        if (query) params.set("q", query);
        else params.delete("q");

        if (next.statusBucket) params.set("status", next.statusBucket);
        else params.delete("status");
      });
    },
    [parsedFilters, replaceParams],
  );

  useEffect(() => {
    if (statusBucket && previousStatusBucketRef.current !== statusBucket) {
      drilldownRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    previousStatusBucketRef.current = statusBucket;
  }, [statusBucket]);

  const handleStablecoinChange = useCallback(
    (v: BlacklistStablecoin | "all") => {
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "stablecoin", filter_value: v });
      updateFilters({ stablecoinFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleChainChange = useCallback(
    (v: string) => {
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "chain", filter_value: v });
      updateFilters({ chainFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleEventTypeChange = useCallback(
    (v: BlacklistEventType | "all") => {
      trackEvent("filter_applied", { page: "freezewatch", filter_type: "event_type", filter_value: v });
      updateFilters({ eventTypeFilter: v, page: 1 });
    },
    [updateFilters],
  );

  const handleSearchChange = useCallback(
    (v: string) => {
      setSearchInput(v);
      if (searchSyncTimer.current) clearTimeout(searchSyncTimer.current);
      searchSyncTimer.current = setTimeout(() => {
        trackSearch("freezewatch", v.length);
        updateFilters({ searchQuery: v, page: 1 });
      }, 300);
    },
    [updateFilters],
  );

  const handleSortChange = useCallback(
    (nextSortKey: BlacklistSortKey, nextSortDirection: BlacklistSortDirection) => {
      trackEvent("sort_changed", {
        page: "freezewatch",
        sort_by: `${nextSortKey}:${nextSortDirection}`,
      });
      updateFilters({ sortKey: nextSortKey, sortDirection: nextSortDirection, page: 1 });
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
  const clampedPage = Math.min(page, totalPages);
  const rangeStart = total === 0 ? 0 : (clampedPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(clampedPage * PAGE_SIZE, total);

  const handlePreviousPage = useCallback(() => {
    const nextPage = Math.max(1, clampedPage - 1);
    updateFilters({ page: nextPage });
  }, [clampedPage, updateFilters]);

  const handleNextPage = useCallback(() => {
    const nextPage = Math.min(totalPages, clampedPage + 1);
    updateFilters({ page: nextPage });
  }, [clampedPage, totalPages, updateFilters]);

  return {
    summary,
    summaryLoading,
    error,
    dataUpdatedAt,
    freshnessMeta,
    stablecoins: stablecoinData?.peggedAssets as StablecoinData[] | undefined,
    stablecoinFxFallbackRates: stablecoinData?.fxFallbackRates,
    reportCardMap,
    reportCardsResponse: reportCardsData,
    blacklistStatusBuckets,
    supportDataLoading: supportStablecoinsLoading || supportReportCardsLoading,
    refetchSummary,
    refetchPage,
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
    events,
    drilldownRef,
    handleStablecoinChange,
    handleChainChange,
    handleEventTypeChange,
    handleSearchChange,
    handleSortChange,
    handleStatusBucketChange,
    handleStatusBucketClear,
    handlePreviousPage,
    handleNextPage,
    clampedPage,
    total,
    totalPages,
    rangeStart,
    rangeEnd,
  };
}
