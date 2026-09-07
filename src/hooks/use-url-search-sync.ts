"use client";

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { trackSearch } from "@/lib/analytics";

interface UrlSearchController {
  getParam: (key: string, defaultValue?: string) => string;
  setParam: (key: string, value: string) => void;
}

/**
 * Shared debounced URL-search pattern used by compliance and liquidity clients.
 *
 * Returns `{searchInput, setSearchInput, deferredSearch}`.
 * After `delayMs` of inactivity, syncs `deferredSearch` to the `?q=` URL
 * param. Only manual input schedules the separately debounced search event;
 * initial URL state and browser navigation are not searches.
 *
 * Do NOT fold freezewatch in — its debounce shape and absence of
 * useDeferredValue differ.
 */
export function useUrlSearchSync(
  pageName: string,
  { getParam, setParam }: UrlSearchController,
  delayMs = 300,
): { searchInput: string; setSearchInput: (v: string) => void; deferredSearch: string } {
  const urlSearch = getParam("q");
  const [searchDraft, setSearchDraft] = useState(() => ({ value: urlSearch, baseUrlSearch: urlSearch }));
  const searchInput = searchDraft.baseUrlSearch === urlSearch ? searchDraft.value : urlSearch;
  const setSearchInput = useCallback((value: string) => {
    setSearchDraft({ value, baseUrlSearch: urlSearch });
    trackSearch(pageName, value.length);
  }, [pageName, urlSearch]);
  const deferredSearch = useDeferredValue(searchInput);
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    urlSyncTimer.current = setTimeout(() => {
      setParam("q", deferredSearch);
    }, delayMs);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [deferredSearch, setParam, delayMs]);
  return { searchInput, setSearchInput, deferredSearch };
}
