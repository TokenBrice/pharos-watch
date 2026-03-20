"use client";

import { useCallback, useMemo, useState } from "react";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent } from "@/lib/analytics";
import {
  COMPARE_COIN_OPTIONS,
  MAX_COMPARE_COINS,
  resolveCompareSelectedIds,
} from "@/lib/compare-config";
import type { CoinOption } from "@/components/coin-selector";

const VALID_COMPARE_RANGES = new Set<TimeRangeOption>(["7d", "30d", "90d", "1y", "all"]);

export function normalizeCompareRange(value: string | null): TimeRangeOption {
  if (value && VALID_COMPARE_RANGES.has(value as TimeRangeOption)) {
    return value as TimeRangeOption;
  }
  return "all";
}

export function useCompareSelection() {
  const { searchParams, replaceParams } = useUrlFilters();

  const selectedIds = useMemo(
    () => resolveCompareSelectedIds(searchParams.get("coins")),
    [searchParams],
  );

  const range = normalizeCompareRange(searchParams.get("range"));
  const [flowHours, setFlowHours] = useState<24 | 168 | 720>(24);

  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      trackEvent("time_range_changed", { page: "compare", range: newRange });
      replaceParams((params) => {
        if (newRange === "all") {
          params.delete("range");
        } else {
          params.set("range", newRange);
        }
      });
    },
    [replaceParams],
  );

  const setSelectedIds = useCallback(
    (updater: (prev: string[]) => string[]) => {
      const next = updater(selectedIds).slice(0, MAX_COMPARE_COINS);
      replaceParams((params) => {
        if (next.length > 0) {
          params.set("coins", next.join(","));
        } else {
          params.delete("coins");
        }

        if (range !== "all") {
          params.set("range", range);
        } else {
          params.delete("range");
        }
      });
    },
    [replaceParams, range, selectedIds],
  );

  const selectedCoins = useMemo(
    () => selectedIds.map((id) => COMPARE_COIN_OPTIONS.find((coin) => coin.id === id) ?? null),
    [selectedIds],
  );

  const disabledIds = useMemo(() => new Set(selectedIds), [selectedIds]);

  const handleSelect = useCallback((slotIndex: number, coin: CoinOption) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      if (slotIndex < prev.length) {
        next[slotIndex] = coin.id;
      } else {
        next.push(coin.id);
      }
      if (next.length >= 2 && prev.length < 2) {
        trackEvent("comparison_created", {
          coin_count: next.length,
          coin_ids: next.slice(0, MAX_COMPARE_COINS).join(","),
        });
      }
      return next;
    });
  }, [setSelectedIds]);

  const handleRemove = useCallback((slotIndex: number) => {
    setSelectedIds((prev) => prev.filter((_, index) => index !== slotIndex));
  }, [setSelectedIds]);

  const applyPreset = useCallback((coinIds: readonly string[], presetTitle: string) => {
    trackEvent("comparison_preset_selected", { preset: presetTitle });
    replaceParams((params) => {
      params.set("coins", coinIds.slice(0, MAX_COMPARE_COINS).join(","));
      params.delete("range");
    });
  }, [replaceParams]);

  return {
    selectedIds,
    range,
    setRange,
    flowHours,
    setFlowHours,
    setSelectedIds,
    selectedCoins,
    disabledIds,
    coinOptions: COMPARE_COIN_OPTIONS,
    handleSelect,
    handleRemove,
    applyPreset,
  };
}
