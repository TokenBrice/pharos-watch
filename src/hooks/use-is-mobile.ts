"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Live media-query subscription. Renders `serverSnapshot` on the server and
 * during hydration, then switches to the live `matchMedia` result. Environments
 * without `matchMedia` never receive change notifications and read as `false`.
 */
export function useMediaQuery(query: string, serverSnapshot = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    [query],
  );
  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True when the viewport is narrower than `breakpoint` px. */
export function useIsMobile(breakpoint = 640, serverSnapshot = false): boolean {
  return useMediaQuery(`(max-width: ${breakpoint - 1}px)`, serverSnapshot);
}
