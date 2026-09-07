"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { RequestFailure, requestResponse } from "@/lib/request";
import { STATUS_PRIORITY } from "@/lib/status/dashboard-presentation";
import {
  getEndpointProbeDescriptors,
  getProbePaths,
  type EndpointDefinition,
  type EndpointProbeGroup,
} from "@shared/lib/api-endpoints";
import { PER_COIN_CACHE_TTL_SECONDS } from "@shared/lib/api-cache-profiles";
import { isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import type { EndpointProbeResult } from "@shared/types";
import { usePollingQuery } from "./use-api-query";
import { CRON_1MIN, CRON_15MIN } from "@/lib/cron-intervals";

/** Endpoint definitions grouped by status-page probe group. */
export const ENDPOINT_GROUPS = {
  public: getProbePaths("public"),
  admin: getProbePaths("admin"),
  manual: getProbePaths("manual"),
} as const;
/**
 * The public status page only needs a small, representative canary set. Keep
 * this list explicit so adding a public endpoint does not increase every
 * visitor's browser fan-out.
 */
const PUBLIC_STATUS_CANARY_PATHS = [
  "/api/health",
  "/api/stablecoins",
  "/api/peg-summary",
  "/api/dex-liquidity",
  "/api/report-cards/v9",
] as const;

/** Only public + admin endpoints are probed. manual endpoints are
 *  action paths and must NOT be auto-probed from the dashboard loop. */
const ALL_ENDPOINTS = [...ENDPOINT_GROUPS.public, ...ENDPOINT_GROUPS.admin];
const PUBLIC_ENDPOINTS: readonly string[] = PUBLIC_STATUS_CANARY_PATHS;
const CRITICAL_ENDPOINTS = [...getEndpointProbeDescriptors("public"), ...getEndpointProbeDescriptors("admin")]
  .filter((descriptor) => descriptor.probeSemanticKind === "health" || descriptor.probeSemanticKind === "status")
  .map((descriptor) => descriptor.path);

const ADMIN_PATHS = new Set<string>([...ENDPOINT_GROUPS.admin]);
const PUBLIC_PROBE_TIMEOUT_MS = 5_000;
const ADMIN_PROBE_TIMEOUT_MS = 20_000;
const SCHEDULED_DETAIL_REFRESH_GRACE_SECONDS = 2 * PER_COIN_CACHE_TTL_SECONDS;
export const ENDPOINT_PROBE_CONCURRENCY = 6;

type ProbeSemanticKind = NonNullable<EndpointDefinition["probeSemanticKind"]>;

function getProbeTimeoutMs(path: string): number {
  return ADMIN_PATHS.has(path) ? ADMIN_PROBE_TIMEOUT_MS : PUBLIC_PROBE_TIMEOUT_MS;
}

function buildProbeRequest(path: string): {
  path: string;
  headers?: HeadersInit;
} {
  if (!ADMIN_PATHS.has(path)) {
    return { path };
  }
  return {
    path: buildAdminApiPath(path),
  };
}

function getProbeErrorMessage(err: unknown): string {
  if (err instanceof RequestFailure && err.kind === "timeout") return "Browser probe timed out";
  if (err instanceof RequestFailure) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

function isSemanticStatus(value: unknown): value is NonNullable<EndpointProbeResult["semanticStatus"]> {
  return value === "healthy" || value === "degraded" || value === "stale";
}

function extractFreshnessWarningSemantics(response: Response): Partial<EndpointProbeResult> | null {
  const warning = typeof response.headers?.get === "function" ? response.headers.get("Warning") : null;
  if (!warning) return null;
  if (warning.trim() === '110 - "Stablecoin detail cache is stale; refresh scheduled"') {
    const rawDataAge = response.headers.get("X-Data-Age");
    const dataAge = rawDataAge != null && rawDataAge.trim() !== "" ? Number(rawDataAge) : Number.NaN;
    if (
      Number.isFinite(dataAge) &&
      dataAge >= 0 &&
      dataAge <= SCHEDULED_DETAIL_REFRESH_GRACE_SECONDS
    ) {
      return null;
    }
  }
  const isFreshnessWarning = isFreshnessWarningHeader(warning);
  if (!isFreshnessWarning) return null;

  const explicitStatus = /Response is stale/i.test(warning)
    ? "stale"
    : /Response is degraded/i.test(warning)
      ? "degraded"
      : null;

  return {
    semanticStatus: explicitStatus ?? "stale",
    semanticScope: "freshness",
    semanticDetail: warning,
  };
}

function mergeSemanticFields(
  primary: Partial<EndpointProbeResult> | undefined,
  freshness: Partial<EndpointProbeResult> | null,
): Partial<EndpointProbeResult> | undefined {
  if (!freshness?.semanticStatus) return primary;
  if (!primary?.semanticStatus) return freshness;
  const primaryRank = STATUS_PRIORITY[primary.semanticStatus];
  const freshnessRank = STATUS_PRIORITY[freshness.semanticStatus];
  if (freshnessRank > primaryRank) {
    return freshness;
  }
  return {
    ...primary,
    semanticDetail: primary.semanticDetail ?? freshness.semanticDetail,
  };
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Best effort only. The probe already has the transport status it needs.
  }
}

function extractHealthProbeSemantics(body: unknown): Partial<EndpointProbeResult> | null {
  if (!body || typeof body !== "object") return null;

  const status = "status" in body ? body.status : null;
  if (!isSemanticStatus(status)) return null;

  const warnings =
    "warnings" in body && Array.isArray(body.warnings)
      ? body.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
  const blacklist = "blacklist" in body && body.blacklist && typeof body.blacklist === "object" ? body.blacklist : null;
  const mintBurn = "mintBurn" in body && body.mintBurn && typeof body.mintBurn === "object" ? body.mintBurn : null;
  const missingAmounts =
    blacklist && "missingAmounts" in blacklist && typeof blacklist.missingAmounts === "number"
      ? blacklist.missingAmounts
      : 0;
  const missingRatio =
    blacklist && "missingRatio" in blacklist && typeof blacklist.missingRatio === "number" ? blacklist.missingRatio : 0;
  const recentMissingAmounts =
    blacklist && "recentMissingAmounts" in blacklist && typeof blacklist.recentMissingAmounts === "number"
      ? blacklist.recentMissingAmounts
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
      (getBlacklistGapStatus({ missingRatio, recentMissingAmounts }) !== "healthy"
        ? `Blacklist gaps missing amounts: ${missingAmounts}.`
        : null),
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
          (cause): cause is { message?: string } => !!cause && typeof cause === "object" && "message" in cause,
        )
      : null;
  const message = firstCause?.message;

  return {
    semanticStatus: status,
    semanticScope: "status",
    semanticDetail: typeof message === "string" ? message : null,
  };
}

const SEMANTIC_PROBE_PARSERS = new Map<ProbeSemanticKind, (body: unknown) => Partial<EndpointProbeResult> | null>([
  ["health", extractHealthProbeSemantics],
  ["status", extractStatusProbeSemantics],
]);

const PROBE_DESCRIPTOR_GROUPS = ["public", "admin", "manual"] as const satisfies readonly EndpointProbeGroup[];
const PROBE_SEMANTIC_KIND_BY_PATH = new Map<string, ProbeSemanticKind>();

for (const group of PROBE_DESCRIPTOR_GROUPS) {
  for (const descriptor of getEndpointProbeDescriptors(group)) {
    if (descriptor.probeSemanticKind) {
      PROBE_SEMANTIC_KIND_BY_PATH.set(descriptor.path, descriptor.probeSemanticKind);
    }
  }
}

async function runProbeFetch(
  path: string,
  handleResponse: (response: Response, latencyMs: number) => Promise<EndpointProbeResult>,
  signal?: AbortSignal,
): Promise<EndpointProbeResult> {
  const timeoutMs = getProbeTimeoutMs(path);
  const start = performance.now();

  try {
    const request = buildProbeRequest(path);
    const result = await requestResponse(
      buildRequestUrl(request.path),
      {
        signal,
        timeoutMs,
        allowHttpError: true,
        init: { headers: request.headers },
      },
      (response) => handleResponse(response, Math.round(performance.now() - start)),
    );
    return result.data;
  } catch (err) {
    if (signal?.aborted && err instanceof RequestFailure && err.kind === "aborted") throw err;
    const latencyMs = Math.round(performance.now() - start);
    return {
      path,
      status: null,
      latencyMs,
      error: getProbeErrorMessage(err),
    };
  }
}

async function probeEndpoint(path: string, signal?: AbortSignal): Promise<EndpointProbeResult> {
  return runProbeFetch(
    path,
    async (res, latencyMs) => {
      const semanticKind = PROBE_SEMANTIC_KIND_BY_PATH.get(path);
      const parser = semanticKind ? SEMANTIC_PROBE_PARSERS.get(semanticKind) : undefined;
      let semanticFields: Partial<EndpointProbeResult> | undefined;

      if (parser && res.ok && typeof res.json === "function") {
        try {
          const parsed = parser(await res.json());
          semanticFields = parsed ?? {
            semanticStatus: "stale",
            semanticScope: semanticKind,
            semanticDetail: `Response did not match the ${semanticKind} probe contract.`,
            error: `Invalid ${semanticKind} probe response`,
          };
        } catch {
          semanticFields = {
            semanticStatus: "stale",
            semanticScope: semanticKind,
            semanticDetail: `Response was not valid JSON for the ${semanticKind} probe.`,
            error: `Invalid JSON from ${semanticKind} probe`,
          };
        }
      } else {
        // This fan-out probe loop only needs transport reachability for non-semantic routes.
        // Cancel unread bodies so one browser session does not strand slots across repeated runs.
        await discardResponseBody(res);
      }
      semanticFields = mergeSemanticFields(semanticFields, extractFreshnessWarningSemantics(res));

      return { path, status: res.status, latencyMs, ...semanticFields };
    },
    signal,
  );
}

export async function collectEndpointProbes(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<EndpointProbeResult[]> {
  if (paths.length === 0) return [];

  const results = new Array<EndpointProbeResult>(paths.length);
  let nextIndex = 0;
  const workerCount = Math.min(ENDPOINT_PROBE_CONCURRENCY, paths.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < paths.length) {
        signal?.throwIfAborted();
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await probeEndpoint(paths[currentIndex]!, signal);
      }
    }),
  );

  return results;
}

/**
 * Probes all API endpoints in parallel.
 * Operator probes refresh every minute; the public status page uses the
 * 15-minute self-check producer cadence.
 */
export type EndpointProbeMode = "full" | "critical";

function useEndpointProbeQuery(
  key: readonly unknown[],
  paths: readonly string[],
  enabled: boolean,
  producerIntervalMs = CRON_1MIN,
): UseQueryResult<EndpointProbeResult[], Error> {
  return usePollingQuery(
    key,
    ({ signal }) => collectEndpointProbes(paths, signal),
    producerIntervalMs,
    { enabled, retry: 0 },
  );
}

export function useEndpointProbes(
  options: { enabled?: boolean; mode?: EndpointProbeMode } = {},
): UseQueryResult<EndpointProbeResult[], Error> {
  const mode = options.mode ?? "full";
  const paths = mode === "critical" ? CRITICAL_ENDPOINTS : ALL_ENDPOINTS;
  return useEndpointProbeQuery(
    mode === "critical" ? ["endpoint-probes", "ops-proxy", "critical"] : ["endpoint-probes", "ops-proxy"],
    paths,
    options.enabled ?? true,
  );
}

export function usePublicEndpointProbes(
  options: { enabled?: boolean } = {},
): UseQueryResult<EndpointProbeResult[], Error> {
  return useEndpointProbeQuery(
    ["endpoint-probes", "public"],
    PUBLIC_ENDPOINTS,
    options.enabled ?? true,
    CRON_15MIN,
  );
}
