"use client";

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { FilterCombobox } from "@/components/filter-combobox";
import { Button } from "@/components/ui/button";
import type { BlacklistStablecoin, BlacklistEventType } from "@shared/types/blacklist";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";

export const TOP_COIN_PILL_LIMIT = 8;

const EVENT_TYPE_FILTER_OPTIONS: { value: BlacklistEventType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "blacklist", label: "Freeze" },
  { value: "unblacklist", label: "Release" },
  { value: "destroy", label: "Wipe" },
];

function formatStablecoinFilterLabel(value: BlacklistStablecoin | "all"): string {
  return value === "all" ? "All" : value;
}

interface BlacklistFiltersProps {
  chains: Array<{ id: string; name: string }>;
  stablecoinFilter: BlacklistStablecoin | "all";
  chainFilter: string;
  eventTypeFilter: BlacklistEventType | "all";
  perCoinTotalEvents?: Partial<Record<BlacklistStablecoin, number>>;
  hasActiveFilters?: boolean;
  onStablecoinChange: (value: BlacklistStablecoin | "all") => void;
  onChainChange: (value: string) => void;
  onEventTypeChange: (value: BlacklistEventType | "all") => void;
  onResetFilters?: () => void;
}

export function BlacklistFilters({
  chains,
  stablecoinFilter,
  chainFilter,
  eventTypeFilter,
  perCoinTotalEvents,
  hasActiveFilters,
  onStablecoinChange,
  onChainChange,
  onEventTypeChange,
  onResetFilters,
}: BlacklistFiltersProps) {
  const { topPillOptions, comboboxOptions } = useMemo(() => {
    const orderIndex = new Map(BLACKLIST_STABLECOINS.map((coin, index) => [coin, index] as const));
    const rankedCoins = [...BLACKLIST_STABLECOINS].sort((a, b) => {
      const countA = perCoinTotalEvents?.[a] ?? -1;
      const countB = perCoinTotalEvents?.[b] ?? -1;
      if (countB !== countA) return countB - countA;
      return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0);
    });

    const topCoins = rankedCoins.slice(0, TOP_COIN_PILL_LIMIT);
    const pills: Array<BlacklistStablecoin | "all"> = ["all", ...topCoins];

    const combobox = [
      { value: "all", label: "All tracked coins" },
      ...rankedCoins.map((coin) => {
        const count = perCoinTotalEvents?.[coin];
        return {
          value: coin,
          label: count == null ? coin : `${coin} (${count.toLocaleString("en-US")})`,
        };
      }),
    ];

    return { topPillOptions: pills, comboboxOptions: combobox };
  }, [perCoinTotalEvents]);

  const chainOptions = useMemo(
    () => [{ value: "all", label: "All" }, ...chains.map((chain) => ({ value: chain.id, label: chain.name }))],
    [chains],
  );

  const showReset =
    typeof onResetFilters === "function" &&
    (hasActiveFilters ?? (stablecoinFilter !== "all" || chainFilter !== "all" || eventTypeFilter !== "all"));

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end lg:gap-6">
      <div className="space-y-1.5">
        <span className="pharos-label">Stablecoin</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <ControlPillToggle
            className="flex flex-wrap justify-start gap-1.5"
            ariaLabel="Filter by stablecoin"
            options={topPillOptions}
            value={stablecoinFilter}
            onChange={onStablecoinChange}
            formatLabel={formatStablecoinFilterLabel}
            buttonClassName="min-h-11 px-3 sm:min-h-8"
          />
          <FilterCombobox
            label="All coins"
            value={stablecoinFilter}
            onValueChange={(nextValue) => onStablecoinChange(nextValue as BlacklistStablecoin | "all")}
            options={comboboxOptions}
            placeholder="All tracked"
            emptyLabel="No tracked stablecoin matches."
            triggerClassName="pharos-control-pill min-h-11 px-3 text-xs sm:min-h-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="pharos-label">Chain</span>
        <ControlPillToggle
          className="flex flex-wrap justify-start gap-1.5"
          ariaLabel="Filter by chain"
          options={chainOptions}
          value={chainFilter}
          onChange={onChainChange}
          buttonClassName="min-h-11 px-3 sm:min-h-8"
        />
      </div>

      <div className="space-y-1.5">
        <span className="pharos-label">Event type</span>
        <ControlPillToggle
          variant="segmented"
          ariaLabel="Filter by event type"
          options={EVENT_TYPE_FILTER_OPTIONS}
          value={eventTypeFilter}
          onChange={onEventTypeChange}
          buttonClassName="min-h-11 px-3 sm:min-h-8"
        />
      </div>

      {showReset ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pharos-focus-ring min-h-11 self-start gap-1.5 sm:min-h-8 lg:self-end"
          onClick={onResetFilters}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Reset filters
        </Button>
      ) : null}
    </div>
  );
}
