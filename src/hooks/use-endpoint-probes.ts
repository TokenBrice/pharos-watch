"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { EndpointProbeResult } from "@/lib/types";

/** Endpoint definitions grouped by type */
export const ENDPOINT_GROUPS = {
  public: [
    "/api/stablecoins",
    "/api/stablecoin/1",
    "/api/stablecoin-charts",
    "/api/peg-summary",
    "/api/health",
    "/api/blacklist",
    "/api/depeg-events",
    "/api/usds-status",
    "/api/bluechip-ratings",
    "/api/dex-liquidity",
    "/api/dex-liquidity-history?stablecoin=1",
    "/api/supply-history?stablecoin=1",
    "/api/daily-digest",
    "/api/digest-archive",
    "/api/stability-index",
    "/api/report-cards",
  ],
  admin: [
    "/api/status",
    "/api/debug-sync-state",
  ],
  inlineAdmin: [
    "/api/trigger-digest",
    "/api/reset-blacklist-sync",
    "/api/backfill-depegs",
    "/api/backfill-supply-history",
    "/api/backfill-cg-prices",
    "/api/backfill-stability-index",
    "/api/audit-depeg-history?dry-run=true",
  ],
} as const;

/** Only public + admin endpoints are probed. inlineAdmin endpoints are
 *  manual actions and must NOT be auto-probed from the dashboard loop. */
const ALL_ENDPOINTS = [
  ...ENDPOINT_GROUPS.public,
  ...ENDPOINT_GROUPS.admin,
];

const ADMIN_PATHS = new Set<string>([...ENDPOINT_GROUPS.admin]);

async function probeEndpoint(
  path: string,
  adminKey: string,
): Promise<EndpointProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = performance.now();

  try {
    const headers: Record<string, string> = {};
    if (ADMIN_PATHS.has(path)) {
      headers["X-Admin-Key"] = adminKey;
    }
    const res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers,
    });
    const latencyMs = Math.round(performance.now() - start);
    return { path, status: res.status, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      path,
      status: null,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probes all API endpoints in parallel.
 * Auto-refreshes every 60s.
 */
export function useEndpointProbes(
  adminKey: string,
): UseQueryResult<EndpointProbeResult[], Error> {
  return useQuery<EndpointProbeResult[], Error>({
    queryKey: ["endpoint-probes", adminKey],
    queryFn: () =>
      Promise.all(ALL_ENDPOINTS.map((p) => probeEndpoint(p, adminKey))),
    enabled: !!adminKey,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 0,
  });
}
