"use client";

import { useCallback, useMemo } from "react";
import { useUrlState } from "@/hooks/use-url-state";
import { trackEvent } from "@/lib/analytics";
import type { UrlStateSchema } from "@/lib/url-state";

export const MAX_YIELD_COMPARE_IDS = 4;

interface YieldCompareUrlState {
  compare: string[];
}

const YIELD_COMPARE_URL_STATE_SCHEMA: UrlStateSchema<YieldCompareUrlState> = {
  compare: {
    kind: "enumList",
    defaultValue: [],
    maxItems: MAX_YIELD_COMPARE_IDS,
  },
};

export interface UseYieldCompareSelectionResult {
  ids: string[];
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  clear: () => void;
  canAdd: boolean;
}

/**
 * Tracks the compare drawer selection in the `?compare=` URL param.
 * Capped at MAX_YIELD_COMPARE_IDS entries; toggling a new id past the cap is a no-op.
 */
export function useYieldCompareSelection(): UseYieldCompareSelectionResult {
  const { state, replaceState } = useUrlState(YIELD_COMPARE_URL_STATE_SCHEMA);
  const ids = state.compare;
  const idSet = useMemo(() => new Set(ids), [ids]);

  const has = useCallback((id: string) => idSet.has(id), [idSet]);

  const writeIds = useCallback(
    (nextIds: string[]) => {
      replaceState({ compare: nextIds });
    },
    [replaceState],
  );

  const toggle = useCallback(
    (id: string) => {
      if (idSet.has(id)) {
        const nextIds = ids.filter((existing) => existing !== id);
        writeIds(nextIds);
        trackEvent("yield_compare_changed", {
          action: "removed",
          coin_count: nextIds.length,
          coin_id: id,
        });
        return;
      }
      if (ids.length >= MAX_YIELD_COMPARE_IDS) return;
      const nextIds = [...ids, id];
      writeIds(nextIds);
      trackEvent("yield_compare_changed", {
        action: "added",
        coin_count: nextIds.length,
        coin_id: id,
      });
    },
    [ids, idSet, writeIds],
  );

  const clear = useCallback(() => {
    if (ids.length === 0) return;
    writeIds([]);
    trackEvent("yield_compare_changed", {
      action: "cleared",
      coin_count: 0,
      coin_id: "",
    });
  }, [ids.length, writeIds]);

  const canAdd = ids.length < MAX_YIELD_COMPARE_IDS;

  return { ids, has, toggle, clear, canAdd };
}
