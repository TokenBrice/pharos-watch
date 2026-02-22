"use client";

import { useMemo } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { BlacklistEvent, BlacklistStablecoin, BlacklistEventType } from "@/lib/types";

interface BlacklistFiltersProps {
  events: BlacklistEvent[] | undefined;
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  onStablecoinChange: (value: BlacklistStablecoin | "all") => void;
  onChainChange: (value: string) => void;
  onEventTypeChange: (value: BlacklistEventType | "all") => void;
}

export function BlacklistFilters({
  events,
  stablecoinFilter,
  chainFilter,
  eventTypeFilter,
  onStablecoinChange,
  onChainChange,
  onEventTypeChange,
}: BlacklistFiltersProps) {
  const chains = useMemo(() => {
    if (!events) return [];
    const seen = new Map<string, string>();
    for (const evt of events) {
      if (!seen.has(evt.chainId)) {
        seen.set(evt.chainId, evt.chainName);
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [events]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-6">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={stablecoinFilter}
          onValueChange={(v) => { if (v) onStablecoinChange(v as BlacklistStablecoin | "all"); }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="USDC">USDC</ToggleGroupItem>
          <ToggleGroupItem value="USDT">USDT</ToggleGroupItem>
          <ToggleGroupItem value="PAXG">PAXG</ToggleGroupItem>
          <ToggleGroupItem value="XAUT">XAUT</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chain</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={chainFilter}
          onValueChange={(v) => { if (v) onChainChange(v); }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {chains.map((chain) => (
            <ToggleGroupItem key={chain.id} value={chain.id}>
              {chain.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Event Type</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={eventTypeFilter}
          onValueChange={(v) => { if (v) onEventTypeChange(v as BlacklistEventType | "all"); }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="blacklist">Blacklist</ToggleGroupItem>
          <ToggleGroupItem value="unblacklist">Unblacklist</ToggleGroupItem>
          <ToggleGroupItem value="destroy">Destroy</ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
