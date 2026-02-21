"use client";

import { useMemo, useCallback, Suspense } from "react";
import Link from "next/link";
import { useMintBurnEvents } from "@/hooks/use-mint-burn-events";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { MintBurnStats } from "@/components/mint-burn-stats";
import { MintBurnChart } from "@/components/mint-burn-chart";
import { MintBurnFilters } from "@/components/mint-burn-filters";
import { MintBurnTable } from "@/components/mint-burn-table";
import { Button } from "@/components/ui/button";
import type { MintBurnStablecoin, MintBurnEventType } from "@/lib/types";

const PAGE_SIZE = 50;

const VALID_STABLECOINS = new Set(["all", "USDC", "USDT"]);
const VALID_EVENT_TYPES = new Set(["all", "mint", "burn"]);

function MintPageInner() {
  const { data, isLoading, isError, error } = useMintBurnEvents();
  const events = data?.events;

  const { getParam, setParams: updateParams } = useUrlFilters();

  const rawStablecoin = getParam("stablecoin", "all");
  const rawChain = getParam("chain", "all");
  const rawEventType = getParam("event", "all");
  const rawPage = getParam("page");

  const stablecoinFilter = (VALID_STABLECOINS.has(rawStablecoin) ? rawStablecoin : "all") as MintBurnStablecoin | "all";
  const chainFilter = rawChain;
  const eventTypeFilter = (VALID_EVENT_TYPES.has(rawEventType) ? rawEventType : "all") as MintBurnEventType | "all";
  const page = rawPage ? Math.max(1, parseInt(rawPage, 10) || 1) : 1;

  const handleStablecoinChange = useCallback((v: MintBurnStablecoin | "all") => {
    updateParams({ stablecoin: v, page: "1" });
  }, [updateParams]);
  const handleChainChange = useCallback((v: string) => {
    updateParams({ chain: v, page: "1" });
  }, [updateParams]);
  const handleEventTypeChange = useCallback((v: MintBurnEventType | "all") => {
    updateParams({ event: v, page: "1" });
  }, [updateParams]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((evt) => {
      if (stablecoinFilter !== "all" && evt.stablecoin !== stablecoinFilter) return false;
      if (chainFilter !== "all" && evt.chainId !== chainFilter) return false;
      if (eventTypeFilter !== "all" && evt.eventType !== eventTypeFilter) return false;
      return true;
    });
  }, [events, stablecoinFilter, chainFilter, eventTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Mint & Burn Tracker</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Mint & Burn Tracker</h1>
        <p className="text-sm text-muted-foreground">
          On-chain USDC and USDT issuance and redemption events.
        </p>
      </div>

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Signal lost. {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}

      <MintBurnStats events={events} isLoading={isLoading} />

      <MintBurnChart events={events} isLoading={isLoading} />

      <MintBurnFilters
        events={events}
        stablecoinFilter={stablecoinFilter}
        chainFilter={chainFilter}
        eventTypeFilter={eventTypeFilter}
        onStablecoinChange={handleStablecoinChange}
        onChainChange={handleChainChange}
        onEventTypeChange={handleEventTypeChange}
      />

      <MintBurnTable
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
    </div>
  );
}

export default function MintPage() {
  return (
    <Suspense>
      <MintPageInner />
    </Suspense>
  );
}
