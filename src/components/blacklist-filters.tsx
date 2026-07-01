"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BlacklistStablecoin, BlacklistEventType } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-11 px-3 sm:min-h-8",
        active && "pharos-control-pill-active",
      )}
    >
      {children}
    </button>
  );
}

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
        <div className="flex w-full flex-wrap justify-start gap-1.5" role="group" aria-label="Filter by stablecoin">
          <FilterPill active={stablecoinFilter === "all"} onClick={() => onStablecoinChange("all")}>
            All
          </FilterPill>
          {(hasEventCounts ? withEvents : BLACKLIST_STABLECOINS).map((stablecoin) => (
            <FilterPill
              key={stablecoin}
              active={stablecoinFilter === stablecoin}
              onClick={() => onStablecoinChange(stablecoin)}
            >
              {stablecoin}
            </FilterPill>
          ))}
        </div>
        {hasEventCounts && withoutEvents.length > 0 ? (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowWithoutEvents((v) => !v)}
              aria-expanded={showWithoutEvents}
              aria-controls="blacklist-no-events-filter-group"
              className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0 sm:py-0"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showWithoutEvents ? "rotate-0" : "-rotate-90"}`}
                aria-hidden="true"
              />
              {showWithoutEvents ? "Hide" : "Show"} tracked without events yet ({withoutEvents.length})
            </button>
            {showWithoutEvents ? (
              <div
                id="blacklist-no-events-filter-group"
                className="flex w-full flex-wrap justify-start gap-1.5 opacity-80"
                role="group"
                aria-label="Filter by stablecoin without recorded events"
              >
                {withoutEvents.map((stablecoin) => (
                  <FilterPill
                    key={stablecoin}
                    active={stablecoinFilter === stablecoin}
                    onClick={() => onStablecoinChange(stablecoin)}
                  >
                    {stablecoin}
                  </FilterPill>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Chain</span>
        <div className="flex w-full flex-wrap justify-start gap-1.5" role="group" aria-label="Filter by chain">
          <FilterPill active={chainFilter === "all"} onClick={() => onChainChange("all")}>
            All
          </FilterPill>
          {chains.map((chain) => (
            <FilterPill key={chain.id} active={chainFilter === chain.id} onClick={() => onChainChange(chain.id)}>
              {chain.name}
            </FilterPill>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Event Type</span>
        <div className="flex w-full flex-wrap justify-start gap-1.5" role="group" aria-label="Filter by event type">
          <FilterPill active={eventTypeFilter === "all"} onClick={() => onEventTypeChange("all")}>
            All
          </FilterPill>
          <FilterPill active={eventTypeFilter === "blacklist"} onClick={() => onEventTypeChange("blacklist")}>
            Freeze
          </FilterPill>
          <FilterPill active={eventTypeFilter === "unblacklist"} onClick={() => onEventTypeChange("unblacklist")}>
            Release
          </FilterPill>
          <FilterPill active={eventTypeFilter === "destroy"} onClick={() => onEventTypeChange("destroy")}>
            Wipe
          </FilterPill>
        </div>
      </div>
    </div>
  );
}
