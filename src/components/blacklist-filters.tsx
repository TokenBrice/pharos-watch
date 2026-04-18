"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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
  perCoinTotalEvents?: Partial<Record<BlacklistStablecoin, number>>;
  onStablecoinChange: (value: BlacklistStablecoin | "all") => void;
  onChainChange: (value: string) => void;
  onEventTypeChange: (value: BlacklistEventType | "all") => void;
}

export function BlacklistFilters({
  chains,
  stablecoinFilter,
  chainFilter,
  eventTypeFilter,
  perCoinTotalEvents,
  onStablecoinChange,
  onChainChange,
  onEventTypeChange,
}: BlacklistFiltersProps) {
  const { withEvents, withoutEvents } = useMemo(() => {
    const withE: BlacklistStablecoin[] = [];
    const withoutE: BlacklistStablecoin[] = [];
    for (const coin of BLACKLIST_STABLECOINS) {
      const count = perCoinTotalEvents?.[coin] ?? 0;
      (count > 0 ? withE : withoutE).push(coin);
    }
    return { withEvents: withE, withoutEvents: withoutE };
  }, [perCoinTotalEvents]);

  const hasEventCounts = perCoinTotalEvents != null;
  const selectionHiddenByDefault =
    stablecoinFilter !== "all" && withoutEvents.includes(stablecoinFilter as BlacklistStablecoin);
  const [showWithoutEvents, setShowWithoutEvents] = useState(selectionHiddenByDefault);

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
          aria-label="Filter by stablecoin"
        >
          <ToggleGroupItem value="all" className="min-h-11 sm:min-h-8">
            All
          </ToggleGroupItem>
          {(hasEventCounts ? withEvents : BLACKLIST_STABLECOINS).map((stablecoin) => (
            <ToggleGroupItem key={stablecoin} value={stablecoin} className="min-h-11 sm:min-h-8">
              {stablecoin}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {hasEventCounts && withoutEvents.length > 0 ? (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowWithoutEvents((v) => !v)}
              aria-expanded={showWithoutEvents}
              aria-controls="blacklist-no-events-filter-group"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showWithoutEvents ? "rotate-0" : "-rotate-90"}`}
                aria-hidden="true"
              />
              {showWithoutEvents ? "Hide" : "Show"} tracked without events yet ({withoutEvents.length})
            </button>
            {showWithoutEvents ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                id="blacklist-no-events-filter-group"
                className="w-full flex-wrap justify-start opacity-80"
                value={stablecoinFilter}
                onValueChange={(v) => {
                  if (v) onStablecoinChange(v as BlacklistStablecoin | "all");
                }}
                aria-label="Filter by stablecoin without recorded events"
              >
                {withoutEvents.map((stablecoin) => (
                  <ToggleGroupItem key={stablecoin} value={stablecoin} className="min-h-11 sm:min-h-8">
                    {stablecoin}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
          </div>
        ) : null}
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
          aria-label="Filter by chain"
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
          aria-label="Filter by event type"
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
