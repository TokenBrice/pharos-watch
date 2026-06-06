"use client";

import { useRouter } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";
import { createApiPollingQueryOptionsWithMeta } from "@/hooks/use-api-query";
import type { SchemaLike } from "@/lib/schema-like";

const PREFETCH_DEBOUNCE_MS = 100;

interface RoutePrefetchDescriptor {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  schema?: SchemaLike<unknown>;
  metaMaxAgeSec?: number;
}

type RoutePrefetchDescriptorFactory = () => RoutePrefetchDescriptor;

const reg = FRONTEND_API_QUERY_RUNTIME_REGISTRY;

const ROUTE_PREFETCH_DESCRIPTORS = {
  "/screener/": [
    () => reg.stablecoins,
    () => reg.pegSummary,
  ],
  "/safety-scores/": [
    () => reg.stablecoins,
    () => reg.reportCards,
  ],
  "/yield/": [
    () => reg.yieldRankings,
  ],
  "/depeg/": [
    () => reg.pegSummary,
    () => reg.stressSignals,
  ],
  "/liquidity/": [
    () => reg.dexLiquidity,
  ],
  "/flows/": [
    () => reg.mintBurnFlows(),
  ],
} satisfies Record<string, readonly RoutePrefetchDescriptorFactory[]>;

function prefetchRouteDescriptor(qc: QueryClient, descriptor: RoutePrefetchDescriptor) {
  void qc.prefetchQuery(
    createApiPollingQueryOptionsWithMeta(
      descriptor.queryKey,
      descriptor.path,
      descriptor.producerIntervalMs,
      { schema: descriptor.schema, metaMaxAgeSec: descriptor.metaMaxAgeSec },
    ),
  );
}

/**
 * Warms the TanStack cache for one of the top sidebar routes. Each route's
 * descriptor list maps to the meta-envelope path. We dispatch `prefetchQuery`
 * individually so differently-typed descriptor schemas never have to share a
 * query-result tuple type.
 */
const ROUTE_WARMERS = Object.fromEntries(
  Object.entries(ROUTE_PREFETCH_DESCRIPTORS).map(([route, descriptors]) => [
    route,
    (qc: QueryClient) => {
      for (const getDescriptor of descriptors) {
        prefetchRouteDescriptor(qc, getDescriptor());
      }
    },
  ]),
) as Record<string, (qc: QueryClient) => void>;

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
      const timeout = timeoutRef.current;
      if (timeout) {
        clearTimeout(timeout);
        timeoutRef.current = null;
      }
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
