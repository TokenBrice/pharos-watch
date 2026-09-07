"use client";

import { useCallback, useMemo, useState } from "react";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { useUrlState } from "@/hooks/use-url-state";
import { trackEvent } from "@/lib/analytics";
import {
  COMPARE_COIN_OPTIONS,
  MAX_COMPARE_COINS,
  resolveCompareSelectedIds,
} from "@/lib/compare-config";
import type { CoinOption } from "@/lib/compare-types";
import type { UrlStateSchema } from "@/lib/url-state";

interface CompareUrlState {
  coins: string[];
  range: TimeRangeOption;
}

const COMPARE_URL_STATE_SCHEMA: UrlStateSchema<CompareUrlState> = {
  coins: {
    kind: "enumList",
    defaultValue: [],
    allowedValues: COMPARE_COIN_OPTIONS.map((coin) => coin.id),
    maxItems: MAX_COMPARE_COINS,
    normalizeItem: (value) => resolveCompareSelectedIds(value)[0] ?? null,
  },
  range: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: ["7d", "30d", "90d", "1y", "all"],
  },
};

export function useCompareSelection() {
  const { state, replaceState } = useUrlState(COMPARE_URL_STATE_SCHEMA, {
    normalize: "coins",
  });
  const { coins: selectedIds, range } = state;
  const [flowHours, setFlowHours] = useState<24 | 168 | 720>(24);

  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      trackEvent("time_range_changed", { page: "compare", range: newRange });
      replaceState({ coins: selectedIds, range: newRange });
    },
    [replaceState, selectedIds],
  );

  const setSelectedIds = useCallback(
    (updater: (prev: string[]) => string[]) => {
      const next = updater(selectedIds).slice(0, MAX_COMPARE_COINS);
      replaceState({ coins: next, range });
    },
    [range, replaceState, selectedIds],
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
    replaceState({ coins: coinIds.slice(0, MAX_COMPARE_COINS), range: "all" });
  }, [replaceState]);

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
