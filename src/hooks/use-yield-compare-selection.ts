"use client";

import { useCallback, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent } from "@/lib/analytics";
import { parseIdList } from "@/lib/compare-config";

export const MAX_YIELD_COMPARE_IDS = 4;

const COMPARE_PARAM = "compare";

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
  const { searchParams, replaceParams } = useUrlFilters();

  const rawCompare = searchParams.get(COMPARE_PARAM);
  const ids = useMemo(
    () => parseIdList(rawCompare, { max: MAX_YIELD_COMPARE_IDS }),
    [rawCompare],
  );
  const idSet = useMemo(() => new Set(ids), [ids]);

  const has = useCallback((id: string) => idSet.has(id), [idSet]);

  const writeIds = useCallback(
    (nextIds: string[]) => {
      replaceParams((params) => {
        if (nextIds.length > 0) {
          params.set(COMPARE_PARAM, nextIds.join(","));
        } else {
          params.delete(COMPARE_PARAM);
        }
      });
    },
    [replaceParams],
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
