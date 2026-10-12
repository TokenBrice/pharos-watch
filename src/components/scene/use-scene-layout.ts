"use client";

import { useCallback, useSyncExternalStore } from "react";

export type SceneLayout = "narrow" | "wide";

function getServerSnapshot(): null {
  return null;
}

/**
 * Which layout of a scene is live for a media query (`"(max-width: 760px)"`): `null` on the server and during
 * hydration (neither layout may act yet), then `"narrow"` while the query matches and `"wide"` otherwise, following
 * viewport changes. Keep the query a module constant that the scene's CSS breakpoint agrees with.
 */
export function useSceneLayout(narrowQuery: string): SceneLayout | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const query = window.matchMedia(narrowQuery);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    [narrowQuery],
  );
  const getSnapshot = useCallback((): SceneLayout => (window.matchMedia(narrowQuery).matches ? "narrow" : "wide"), [narrowQuery]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
