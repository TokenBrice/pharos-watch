"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HomepageSnapshot, HomepageLaneMeta } from "@shared/types/homepage";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";

const RetainedHomepageContext = createContext<HomepageSnapshot | null>(null);
export type HomepageEvidenceLane = keyof HomepageSnapshot;

export function isRetainableHomepageLane(meta: HomepageLaneMeta, nowMs: number): boolean {
  return meta.updatedAt !== null && meta.updatedAt > 0
    && nowMs >= meta.updatedAt * 1000
    && nowMs - meta.updatedAt * 1000 <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS;
}

/** Display-only evidence: never an initialData/setQueryData cache shortcut. */
export function reconcileHomepageEvidence(
  live: HomepageSnapshot | undefined,
  retained: HomepageSnapshot | null,
  nowMs: number,
): { data: HomepageSnapshot | undefined; retainedLanes: HomepageEvidenceLane[] } {
  if (!retained) return { data: live, retainedLanes: [] };
  const retainedLanes: HomepageEvidenceLane[] = [];
  function lane<K extends HomepageEvidenceLane>(key: K): HomepageSnapshot[K] {
    const saved = retained![key];
    const current = live?.[key];
    if (saved.data !== null && isRetainableHomepageLane(saved.meta, nowMs)
      && (!current?.data || current.meta.updatedAt === null || current.meta.updatedAt < saved.meta.updatedAt!)) {
      retainedLanes.push(key);
      return {
        ...saved,
        meta: { ...saved.meta, status: "stale", reason: "retained-browser-evidence" },
      } as HomepageSnapshot[K];
    }
    return current ?? {
      data: null,
      meta: { ...saved.meta, status: "stale", reason: "retained-evidence-expired" },
    } as HomepageSnapshot[K];
  }
  const data = { market: lane("market"), psi: lane("psi"), incidents: lane("incidents") };
  return { data, retainedLanes };
}

export function useHomepageEvidence(
  live: HomepageSnapshot | undefined,
  nowMs?: number,
): { data: HomepageSnapshot | undefined; retainedLanes: HomepageEvidenceLane[] } {
  const retained = useContext(RetainedHomepageContext);
  const [browserNowMs, setBrowserNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (nowMs !== undefined) return;
    // Match the hero clock: first render is stable, then expiry ages each minute.
    const timer = setTimeout(() => setBrowserNowMs(Date.now()), 0);
    const interval = setInterval(() => setBrowserNowMs(Date.now()), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [nowMs]);
  const clockMs = nowMs ?? browserNowMs;
  if (clockMs === null) return { data: live, retainedLanes: [] };
  return reconcileHomepageEvidence(live, retained, clockMs);
}

/** Storage/schema loading runs after hydration and never gates a live observer. */
export function HomepageEvidenceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [retained, setRetained] = useState<HomepageSnapshot | null>(null);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/homepage-evidence-persistence").then(async (storage) => {
      if (disposed) return;
      const persist = () => {
        const data = queryClient.getQueryData(storage.HOMEPAGE_EVIDENCE_QUERY_KEY);
        if (data) void storage.persistHomepageEvidence(data);
      };
      unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success"
          && event.query.queryHash === JSON.stringify(storage.HOMEPAGE_EVIDENCE_QUERY_KEY)) persist();
      });
      // A fast live read may have completed before this lazy storage module loaded.
      persist();
      const saved = await storage.restoreHomepageEvidence();
      if (!disposed) setRetained(saved);
    }).catch(() => {
      // Storage unavailable/corrupt is not an API success; normal live reads continue.
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [queryClient]);
  return <RetainedHomepageContext.Provider value={retained}>{children}</RetainedHomepageContext.Provider>;
}
