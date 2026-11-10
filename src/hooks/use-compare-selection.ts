"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { URL_FILTER_HISTORY_CHANGE_EVENT } from "@/hooks/use-url-filters";
import { useUrlState } from "@/hooks/use-url-state";
import { trackEvent } from "@/lib/analytics";
import { parseComparePrefillHash } from "@/lib/compare-links";
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
  const { state, replaceState, isReady } = useUrlState(COMPARE_URL_STATE_SCHEMA, {
    normalize: "coins",
  });
  const { coins: selectedIds, range } = state;
  const [flowHours, setFlowHours] = useState<24 | 168 | 720>(24);

  // Static links prefill through `#coins=` (see buildComparePrefillUrl). Once
  // the real query is readable, adopt the fragment into `?coins=` (the URL
  // stays the source of truth) unless an explicit selection is already
  // present, and drop the fragment so a reload or share keeps one form.
  const prefillHandled = useRef(false);
  const rangeRef = useRef(range);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);
  useEffect(() => {
    if (!isReady || prefillHandled.current) return;
    prefillHandled.current = true;
    const prefill = parseComparePrefillHash(window.location.hash);
    if (!prefill) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    if (selectedIds.length > 0) return;
    replaceState({ coins: prefill.slice(0, MAX_COMPARE_COINS), range });
  }, [isReady, range, replaceState, selectedIds]);

  // A `#coins=` link into the mounted picker is a same-route navigation, which
  // Next commits with pushState (no `hashchange`), so re-adopt the fragment on
  // every announced URL change instead of only on mount.
  useEffect(() => {
    const adoptPrefill = () => {
      if (!prefillHandled.current) return;
      const prefill = parseComparePrefillHash(window.location.hash);
      if (!prefill) return;
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
      replaceState({ coins: prefill.slice(0, MAX_COMPARE_COINS), range: rangeRef.current });
    };
    window.addEventListener("hashchange", adoptPrefill);
    window.addEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, adoptPrefill);
    return () => {
      window.removeEventListener("hashchange", adoptPrefill);
      window.removeEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, adoptPrefill);
    };
  }, [replaceState]);

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
