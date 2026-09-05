"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import type { BlacklistStablecoin, BlacklistEventType } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

const EVENT_TYPE_FILTER_OPTIONS: { value: BlacklistEventType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "blacklist", label: "Freeze" },
  { value: "unblacklist", label: "Release" },
  { value: "destroy", label: "Wipe" },
];

const ALL_STABLECOIN_FILTER_OPTIONS = ["all", ...BLACKLIST_STABLECOINS] as const;

// Raw stablecoin tickers are their own labels; only the "all" sentinel differs.
function formatStablecoinFilterLabel(value: BlacklistStablecoin | "all"): string {
  return value === "all" ? "All" : value;
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
  const { stablecoinOptions, withoutEvents } = useMemo(() => {
    const visibleOptions: Array<BlacklistStablecoin | "all"> = ["all"];
    const withoutE: BlacklistStablecoin[] = [];
    for (const coin of BLACKLIST_STABLECOINS) {
      const count = perCoinTotalEvents?.[coin] ?? 0;
      (count > 0 ? visibleOptions : withoutE).push(coin);
    }
    return {
      stablecoinOptions: perCoinTotalEvents == null ? ALL_STABLECOIN_FILTER_OPTIONS : visibleOptions,
      withoutEvents: withoutE,
    };
  }, [perCoinTotalEvents]);

  const chainOptions = useMemo(
    () => [{ value: "all", label: "All" }, ...chains.map((chain) => ({ value: chain.id, label: chain.name }))],
    [chains],
  );

  const hasEventCounts = perCoinTotalEvents != null;
  const selectionHiddenByDefault =
    stablecoinFilter !== "all" && withoutEvents.includes(stablecoinFilter as BlacklistStablecoin);
  const [showWithoutEvents, setShowWithoutEvents] = useState(selectionHiddenByDefault);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:gap-6">
      <div className="space-y-1.5">
        <span className="pharos-kicker">Stablecoin</span>
        <ControlPillToggle
          className="flex w-full flex-wrap justify-start gap-1.5"
          ariaLabel="Filter by stablecoin"
          options={stablecoinOptions}
          value={stablecoinFilter}
          onChange={onStablecoinChange}
          formatLabel={formatStablecoinFilterLabel}
          buttonClassName="min-h-11 px-3 sm:min-h-8"
        />
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
              <div id="blacklist-no-events-filter-group" className="opacity-80">
                <ControlPillToggle
                  className="flex w-full flex-wrap justify-start gap-1.5"
                  ariaLabel="Filter by stablecoin without recorded events"
                  options={withoutEvents}
                  value={stablecoinFilter}
                  onChange={onStablecoinChange}
                  formatLabel={formatStablecoinFilterLabel}
                  buttonClassName="min-h-11 px-3 sm:min-h-8"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Chain</span>
        <ControlPillToggle
          className="flex w-full flex-wrap justify-start gap-1.5"
          ariaLabel="Filter by chain"
          options={chainOptions}
          value={chainFilter}
          onChange={onChainChange}
          buttonClassName="min-h-11 px-3 sm:min-h-8"
        />
      </div>
      <div className="space-y-1.5">
        <span className="pharos-kicker">Event Type</span>
        <ControlPillToggle
          className="flex w-full flex-wrap justify-start gap-1.5"
          ariaLabel="Filter by event type"
          options={EVENT_TYPE_FILTER_OPTIONS}
          value={eventTypeFilter}
          onChange={onEventTypeChange}
          buttonClassName="min-h-11 px-3 sm:min-h-8"
        />
      </div>
    </div>
  );
}
