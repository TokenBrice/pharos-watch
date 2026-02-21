"use client";

import { useMemo } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MintBurnEvent, MintBurnStablecoin, MintBurnEventType } from "@/lib/types";

interface MintBurnFiltersProps {
  events: MintBurnEvent[] | undefined;
  stablecoinFilter: MintBurnStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: MintBurnEventType | "all";
  onStablecoinChange: (value: MintBurnStablecoin | "all") => void;
  onChainChange: (value: string) => void;
  onEventTypeChange: (value: MintBurnEventType | "all") => void;
}

export function MintBurnFilters({
  events,
  stablecoinFilter,
  chainFilter,
  eventTypeFilter,
  onStablecoinChange,
  onChainChange,
  onEventTypeChange,
}: MintBurnFiltersProps) {
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
    <div className="flex flex-wrap gap-4 sm:gap-6">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={stablecoinFilter}
          onValueChange={(v) => { if (v) onStablecoinChange(v as MintBurnStablecoin | "all"); }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="USDC">USDC</ToggleGroupItem>
          <ToggleGroupItem value="USDT">USDT</ToggleGroupItem>
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
          onValueChange={(v) => { if (v) onEventTypeChange(v as MintBurnEventType | "all"); }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="mint">Mint</ToggleGroupItem>
          <ToggleGroupItem value="burn">Burn</ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
