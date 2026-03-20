"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath, buildAdminFetchInit, getAdminQueryScope, type AdminAccess } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { getProbePaths } from "@shared/lib/api-endpoints";
import type { EndpointProbeResult } from "@shared/types";
import { usePollingQuery } from "./use-api-query";
import { CRON_1MIN } from "@/lib/cron-intervals";

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
const PUBLIC_ENDPOINTS = [
  ...ENDPOINT_GROUPS.public,
];

const ADMIN_PATHS = new Set<string>([...ENDPOINT_GROUPS.admin]);

function isSemanticStatus(value: unknown): value is NonNullable<EndpointProbeResult["semanticStatus"]> {
  return value === "healthy" || value === "degraded" || value === "stale";
}

function extractHealthProbeSemantics(body: unknown): Partial<EndpointProbeResult> | null {
  if (!body || typeof body !== "object") return null;

  const status = "status" in body ? body.status : null;
  if (!isSemanticStatus(status)) return null;

  const warnings = "warnings" in body && Array.isArray(body.warnings)
    ? body.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const blacklist = "blacklist" in body && body.blacklist && typeof body.blacklist === "object"
    ? body.blacklist
    : null;
  const mintBurn = "mintBurn" in body && body.mintBurn && typeof body.mintBurn === "object"
    ? body.mintBurn
    : null;
  const missingAmounts =
    blacklist && "missingAmounts" in blacklist && typeof blacklist.missingAmounts === "number"
      ? blacklist.missingAmounts
      : 0;
  const mintBurnWarning =
    mintBurn &&
    "sync" in mintBurn &&
    mintBurn.sync &&
    typeof mintBurn.sync === "object" &&
    "warning" in mintBurn.sync &&
    typeof mintBurn.sync.warning === "string"
      ? mintBurn.sync.warning
      : null;

  return {
    semanticStatus: status,
    semanticScope: "health",
    semanticDetail:
      warnings[0] ??
      mintBurnWarning ??
      (missingAmounts > 0 ? `Blacklist gaps missing amounts: ${missingAmounts}.` : null),
  };
}

function extractStatusProbeSemantics(body: unknown): Partial<EndpointProbeResult> | null {
  if (!body || typeof body !== "object") return null;

  const status = "overallStatus" in body ? body.overallStatus : null;
  if (!isSemanticStatus(status)) return null;

  const firstCause =
    "causes" in body &&
    body.causes &&
    typeof body.causes === "object" &&
    "overall" in body.causes &&
    Array.isArray(body.causes.overall)
      ? body.causes.overall.find(
          (cause): cause is { message?: string } =>
            !!cause && typeof cause === "object" && ("message" in cause),
        )
      : null;
  const message = firstCause?.message;

  return {
    semanticStatus: status,
    semanticScope: "status",
    semanticDetail: typeof message === "string" ? message : null,
  };
}

const SEMANTIC_PROBE_PARSERS = new Map<
  string,
  (body: unknown) => Partial<EndpointProbeResult> | null
>([
  ["/api/health", extractHealthProbeSemantics],
  ["/api/status", extractStatusProbeSemantics],
]);

async function probeEndpoint(
  path: string,
  adminAccess?: AdminAccess,
): Promise<EndpointProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = performance.now();

  try {
    const requestPath = ADMIN_PATHS.has(path)
      ? buildAdminApiPath(path, adminAccess!)
      : path;
    const requestInit = ADMIN_PATHS.has(path)
      ? buildAdminFetchInit()
      : undefined;
    const res = await fetch(buildRequestUrl(requestPath), {
      signal: controller.signal,
      headers: requestInit?.headers,
    });
    const latencyMs = Math.round(performance.now() - start);
    const parser = SEMANTIC_PROBE_PARSERS.get(path);
    let semanticFields: Partial<EndpointProbeResult> | undefined;

    if (parser && res.ok && typeof res.json === "function") {
      try {
        semanticFields = parser(await res.json()) ?? undefined;
      } catch {
        semanticFields = undefined;
      }
    }

    return { path, status: res.status, latencyMs, ...semanticFields };
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
  adminAccess: AdminAccess,
): UseQueryResult<EndpointProbeResult[], Error> {
  return usePollingQuery(
    ["endpoint-probes", getAdminQueryScope()],
    () => Promise.all(ALL_ENDPOINTS.map((path) => probeEndpoint(path, adminAccess))),
    CRON_1MIN,
    { enabled: true, retry: 0 },
  );
}

export function usePublicEndpointProbes(): UseQueryResult<EndpointProbeResult[], Error> {
  return usePollingQuery(
    ["endpoint-probes", "public"],
    () => Promise.all(PUBLIC_ENDPOINTS.map((path) => probeEndpoint(path))),
    CRON_1MIN,
    { enabled: true, retry: 0 },
  );
}
