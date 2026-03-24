"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistStablecoin,
  type BlacklistEventType,
} from "@shared/types";

interface BlacklistFiltersProps {
  chains: Array<{ id: string; name: string }>;
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  onStablecoinChange: (value: BlacklistStablecoin | "all") => void;
  onChainChange: (value: string) => void;
  onEventTypeChange: (value: BlacklistEventType | "all") => void;
}

export function BlacklistFilters({
  chains,
  stablecoinFilter,
  chainFilter,
  eventTypeFilter,
  onStablecoinChange,
  onChainChange,
  onEventTypeChange,
}: BlacklistFiltersProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:gap-6">
      <div className="space-y-1.5">
        <span className="pharos-kicker">Stablecoin</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="w-full flex-wrap justify-start"
          value={stablecoinFilter}
          onValueChange={(v) => {
            if (v) onStablecoinChange(v as BlacklistStablecoin | "all");
          }}
        >
          <ToggleGroupItem value="all" className="min-h-11 sm:min-h-8">
            All
          </ToggleGroupItem>
          {BLACKLIST_STABLECOINS.map((stablecoin) => (
            <ToggleGroupItem key={stablecoin} value={stablecoin} className="min-h-11 sm:min-h-8">
              {stablecoin}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Chain</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="w-full flex-wrap justify-start"
          value={chainFilter}
          onValueChange={(v) => {
            if (v) onChainChange(v);
          }}
        >
          <ToggleGroupItem value="all" className="min-h-11 sm:min-h-8">
            All
          </ToggleGroupItem>
          {chains.map((chain) => (
            <ToggleGroupItem key={chain.id} value={chain.id} className="min-h-11 sm:min-h-8">
              {chain.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Event Type</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="w-full flex-wrap justify-start"
          value={eventTypeFilter}
          onValueChange={(v) => {
            if (v) onEventTypeChange(v as BlacklistEventType | "all");
          }}
        >
          <ToggleGroupItem value="all" className="min-h-11 sm:min-h-8">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="blacklist" className="min-h-11 sm:min-h-8">
            Blacklist
          </ToggleGroupItem>
          <ToggleGroupItem value="unblacklist" className="min-h-11 sm:min-h-8">
            Unblacklist
          </ToggleGroupItem>
          <ToggleGroupItem value="destroy" className="min-h-11 sm:min-h-8">
            Destroy
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
