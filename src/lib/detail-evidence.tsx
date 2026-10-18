"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isDetailSnapshotQuery, type ApiMeta } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { selectDetailEvidence, type DetailEvidence } from "@/lib/detail-evidence-selection";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

const DetailEvidenceContext = createContext<{ coinId: string; evidence: DetailEvidence | null; nowMs: number } | null>(null);

/** Display only: storage is deliberately independent of live query admission. */
export function useDetailEvidence(
  coinId: string,
  current: { data: StablecoinLiveSummary | undefined; meta: ApiMeta | null | undefined },
  currentIsUnqualified = false,
) {
  const retained = useContext(DetailEvidenceContext);
  return retained?.coinId === coinId
    ? selectDetailEvidence(current, retained.evidence, retained.nowMs, currentIsUnqualified)
    : { data: current.data, meta: current.meta ?? null, isRetained: false };
}

export function DetailEvidenceProvider({ coinId, children }: { coinId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [retained, setRetained] = useState<{ coinId: string; evidence: DetailEvidence | null; nowMs: number } | null>(null);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const interval = setInterval(() => setRetained((previous) => previous ? { ...previous, nowMs: Date.now() } : previous), 60_000);
    void import("@/lib/detail-evidence-persistence").then(async (storage) => {
      if (disposed) return;
      const queryKey = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(coinId).queryKey;
      const persist = () => {
        const state = queryClient.getQueryState<DetailEvidence>(queryKey);
        // The build seed is not a successful live read; never copy it to disk.
        if (state?.status === "success" && state.data && state.dataUpdateCount > 0 && !isDetailSnapshotQuery(queryClient, queryKey)) {
          void storage.persistDetailEvidence(coinId, state.data);
        }
      };
      unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success"
          && event.query.queryHash === JSON.stringify(queryKey)) persist();
      });
      const saved = await storage.restoreDetailEvidence(coinId);
      if (!disposed) {
        setRetained({ coinId, evidence: saved, nowMs: Date.now() });
        // A fast live read may have settled before the lazy storage import.
        persist();
      }
    }).catch(() => {
      // Denied/corrupt storage never becomes an API success or blocks fetching.
    });
    return () => { disposed = true; unsubscribe?.(); clearInterval(interval); };
  }, [coinId, queryClient]);
  return <DetailEvidenceContext.Provider value={retained}>{children}</DetailEvidenceContext.Provider>;
}
