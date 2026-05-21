"use client";

import { useRouter } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";
import {
  createApiPollingQueryOptions,
  createApiPollingQueryOptionsWithMeta,
} from "@/hooks/use-api-query";

const PREFETCH_DEBOUNCE_MS = 100;

/**
 * Warms the TanStack cache for one of the top sidebar routes. Each route's
 * function knows which descriptors map to that route and which ones go through
 * the meta-envelope path. We dispatch `prefetchQuery` individually so the
 * differently-typed `UseQueryOptions` results from `*WithMeta` and the plain
 * factory never have to share a tuple type.
 */
const ROUTE_WARMERS: Record<string, (qc: QueryClient) => void> = {
  "/screener": (qc) => {
    const reg = FRONTEND_API_QUERY_REGISTRY;
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.stablecoins.queryKey,
        reg.stablecoins.path,
        reg.stablecoins.producerIntervalMs,
        { schema: reg.stablecoins.schema, metaMaxAgeSec: reg.stablecoins.metaMaxAgeSec },
      ),
    );
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.pegSummary.queryKey,
        reg.pegSummary.path,
        reg.pegSummary.producerIntervalMs,
        { schema: reg.pegSummary.schema, metaMaxAgeSec: reg.pegSummary.metaMaxAgeSec },
      ),
    );
  },
  "/safety-scores": (qc) => {
    const reg = FRONTEND_API_QUERY_REGISTRY;
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.stablecoins.queryKey,
        reg.stablecoins.path,
        reg.stablecoins.producerIntervalMs,
        { schema: reg.stablecoins.schema, metaMaxAgeSec: reg.stablecoins.metaMaxAgeSec },
      ),
    );
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.reportCards.queryKey,
        reg.reportCards.path,
        reg.reportCards.producerIntervalMs,
        { schema: reg.reportCards.schema, metaMaxAgeSec: reg.reportCards.metaMaxAgeSec },
      ),
    );
  },
  "/yield": (qc) => {
    const reg = FRONTEND_API_QUERY_REGISTRY;
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.yieldRankings.queryKey,
        reg.yieldRankings.path,
        reg.yieldRankings.producerIntervalMs,
        { schema: reg.yieldRankings.schema, metaMaxAgeSec: reg.yieldRankings.metaMaxAgeSec },
      ),
    );
  },
  "/depeg": (qc) => {
    const reg = FRONTEND_API_QUERY_REGISTRY;
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.pegSummary.queryKey,
        reg.pegSummary.path,
        reg.pegSummary.producerIntervalMs,
        { schema: reg.pegSummary.schema, metaMaxAgeSec: reg.pegSummary.metaMaxAgeSec },
      ),
    );
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.stressSignals.queryKey,
        reg.stressSignals.path,
        reg.stressSignals.producerIntervalMs,
        { schema: reg.stressSignals.schema, metaMaxAgeSec: reg.stressSignals.metaMaxAgeSec },
      ),
    );
  },
  "/liquidity": (qc) => {
    const reg = FRONTEND_API_QUERY_REGISTRY;
    void qc.prefetchQuery(
      createApiPollingQueryOptionsWithMeta(
        reg.dexLiquidity.queryKey,
        reg.dexLiquidity.path,
        reg.dexLiquidity.producerIntervalMs,
        { schema: reg.dexLiquidity.schema, metaMaxAgeSec: reg.dexLiquidity.metaMaxAgeSec },
      ),
    );
  },
  "/flows": (qc) => {
    const flows = FRONTEND_API_QUERY_REGISTRY.mintBurnFlows();
    void qc.prefetchQuery(
      createApiPollingQueryOptions(
        flows.queryKey,
        flows.path,
        flows.producerIntervalMs,
        { schema: flows.schema, metaMaxAgeSec: flows.metaMaxAgeSec },
      ),
    );
  },
};

/**
 * Pre-warms the Next.js route bundle plus the TanStack Query cache for the
 * top sidebar links on first hover/focus. Subsequent hovers on the same href
 * in the same session are no-ops, so we never thrash the cache. Calls are
 * debounced by 100ms to absorb cursor sweeps across the nav.
 */
export function useNavPrefetch() {
  const router = useRouter();
  const qc = useQueryClient();
  const visited = useRef(new Set<string>());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const prefetch = useCallback(
    (href: string) => {
      if (visited.current.has(href)) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        router.prefetch(href);
        const warmer = ROUTE_WARMERS[href];
        if (warmer) {
          // Best-effort cache warm — `prefetchQuery` swallows errors and we
          // don't await it, so a slow network never blocks the UI.
          warmer(qc);
        }
        visited.current.add(href);
      }, PREFETCH_DEBOUNCE_MS);
    },
    [router, qc],
  );

  return { prefetch };
}
