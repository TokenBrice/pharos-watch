"use client";

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { trackSearch } from "@/lib/analytics";
import { useUrlFilters } from "@/hooks/use-url-filters";

/**
 * Shared debounced URL-search pattern used by compliance and liquidity clients.
 *
 * Returns `{searchInput, setSearchInput, deferredSearch}`.
 * After `delayMs` of inactivity, syncs `deferredSearch` to the `?q=` URL
 * param and fires a `trackSearch` analytics event when non-empty.
 *
 * Do NOT fold freezewatch in — its debounce shape and absence of
 * useDeferredValue differ.
 */
export function useUrlSearchSync(
  pageName: string,
  delayMs = 300,
): { searchInput: string; setSearchInput: (v: string) => void; deferredSearch: string } {
  const { getParam, setParam } = useUrlFilters();
  const urlSearch = getParam("q");
  const [searchDraft, setSearchDraft] = useState(() => ({ value: urlSearch, baseUrlSearch: urlSearch }));
  const searchInput = searchDraft.baseUrlSearch === urlSearch ? searchDraft.value : urlSearch;
  const setSearchInput = useCallback((value: string) => {
    setSearchDraft({ value, baseUrlSearch: urlSearch });
  }, [urlSearch]);
  const deferredSearch = useDeferredValue(searchInput);
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    urlSyncTimer.current = setTimeout(() => {
      setParam("q", deferredSearch);
      if (deferredSearch) trackSearch(pageName, deferredSearch.length);
    }, delayMs);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [deferredSearch, setParam, pageName, delayMs]);
  return { searchInput, setSearchInput, deferredSearch };
}
