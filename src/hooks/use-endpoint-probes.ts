"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { getProbePaths } from "@shared/lib/api-endpoints";
import type { EndpointProbeResult } from "@shared/types";
import { CRON_1MIN, createPollingQueryOptions } from "./use-api-query";

/** Endpoint definitions grouped by status-page probe group. */
export const ENDPOINT_GROUPS = {
  public: getProbePaths("public"),
  admin: getProbePaths("admin"),
  manual: getProbePaths("manual"),
} as const;

/** Only public + admin endpoints are probed. manual endpoints are
 *  action paths and must NOT be auto-probed from the dashboard loop. */
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
  return useQuery<EndpointProbeResult[], Error>(createPollingQueryOptions(
    ["endpoint-probes", adminKey],
    () => Promise.all(ALL_ENDPOINTS.map((path) => probeEndpoint(path, adminKey))),
    CRON_1MIN,
    { enabled: !!adminKey, retry: 0 },
  ));
}
