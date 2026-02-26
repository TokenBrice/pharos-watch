"use client";

import { useMemo, useCallback, Suspense } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { useBlacklistEvents } from "@/hooks/use-blacklist-events";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_20MIN } from "@/hooks/use-api-query";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { UsdsStatusCard } from "@/components/usds-status-card";
import { EurcBlacklistCard } from "@/components/eurc-blacklist-card";
import { BlacklistStats } from "@/components/blacklist-stats";
import { BlacklistChart } from "@/components/blacklist-chart";
import { BlacklistFilters } from "@/components/blacklist-filters";
import { BlacklistTable } from "@/components/blacklist-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BlacklistStablecoin, BlacklistEventType } from "@/lib/types";
import { trackEvent, trackSearch } from "@/lib/analytics";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set(["all", "USDC", "USDT", "PAXG", "XAUT"]);
const VALID_EVENT_TYPES = new Set(["all", "blacklist", "unblacklist", "destroy"]);

function BlacklistPageInner() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useBlacklistEvents();
  const events = data?.events;

  const { getParam, setParams: updateParams } = useUrlFilters();

  const rawStablecoin = getParam("stablecoin", "all");
  const rawChain = getParam("chain", "all");
  const rawEventType = getParam("event", "all");
  const rawPage = getParam("page");
  const searchQuery = getParam("q");

  const stablecoinFilter = (VALID_STABLECOINS.has(rawStablecoin) ? rawStablecoin : "all") as BlacklistStablecoin | "all";
  const chainFilter = rawChain;
  const eventTypeFilter = (VALID_EVENT_TYPES.has(rawEventType) ? rawEventType : "all") as BlacklistEventType | "all";
  const page = rawPage ? Math.max(1, parseInt(rawPage, 10) || 1) : 1;

  const handleStablecoinChange = useCallback((v: BlacklistStablecoin | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "stablecoin", filter_value: v });
    updateParams({ stablecoin: v, page: "1" });
  }, [updateParams]);
  const handleChainChange = useCallback((v: string) => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "chain", filter_value: v });
    updateParams({ chain: v, page: "1" });
  }, [updateParams]);
  const handleEventTypeChange = useCallback((v: BlacklistEventType | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "event_type", filter_value: v });
    updateParams({ event: v, page: "1" });
  }, [updateParams]);
  const handleSearchChange = useCallback((v: string) => {
    trackSearch("blacklist", v.length);
    updateParams({ q: v || "all", page: "1" });
  }, [updateParams]);

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
          <span className="text-foreground">Freeze & Blacklist Tracker</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Freeze & Blacklist Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Who got frozen. When. Why it matters.
        </p>
      </div>

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Signal lost. {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}
      {!isError && (
        <StaleDataBanner
          queries={[{ label: "Blacklist", dataUpdatedAt, staleTime: CRON_20MIN }]}
        />
      )}

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
            className="pl-8 h-8 text-xs"
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
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing <span className="font-mono">{Math.min((page - 1) * PAGE_SIZE + 1, filtered.length)}</span>&ndash;<span className="font-mono">{Math.min(page * PAGE_SIZE, filtered.length)}</span> of <span className="font-mono">{filtered.length}</span> events
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateParams({ page: String(Math.max(1, page - 1)) })}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateParams({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-5">
        <UsdsStatusCard />
        <EurcBlacklistCard />
      </div>
    </div>
  );
}

export default function BlacklistPage() {
  return (
    <Suspense>
      <BlacklistPageInner />
    </Suspense>
  );
}
