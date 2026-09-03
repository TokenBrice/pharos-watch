import type { CronResult } from "../lib/cron-logger";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { toErrorMessage } from "@shared/lib/error-utils";
import { API_ORIGIN, OPS_API_ORIGIN, SITE_API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import { STATUS_PROBE_THRESHOLDS } from "@shared/lib/status-thresholds";
import { cancelResponseBodyQuietly } from "../lib/response-body";

import { getProbePaths } from "@shared/lib/api-endpoints";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import type { StatusProbeComparison, StatusProbePlaneSummary, StatusProbeSummary } from "@shared/types/status";
import { computeRawStatus } from "../lib/status-evaluation";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { writeStatusRawSnapshot } from "../lib/status/raw-snapshot";
import { loadStatusSupplements } from "../lib/status/supplements";
import type { MintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { route } from "../router";
import {
  buildDiscrepancy,
  reconcileStatusState,
  updateDiscrepancyObservation,
  writeStatusProbeRun,
  type StatusLevel,
} from "../lib/status-reliability";
import { hasDivergence } from "../lib/status-discrepancy-view";
import type { CloudflareD1StatusBindings, CloudflareD1StatusConfig } from "../lib/env";
import type { WorkerCanaryMode } from "../lib/canary-checks";
import { refreshD1CapacityMonitoring } from "../lib/status/d1-capacity-monitor";
import { refreshD1TableGrowthSnapshot } from "../lib/status/d1-usage";

interface ProbeResult {
  path: string;
  label: string;
  plane: "internal" | "external";
  lane: "self-check" | "public-api" | "site-api" | "ops-api";
  origin: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  bootstrapMiss?: boolean;
  semanticStatus?: StatusLevel;
}

interface ProbeLatencySummary {
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

interface ProbeRow {
  path: string;
  label: string;
  plane: ProbeResult["plane"];
  lane: ProbeResult["lane"];
  origin: string;
  status: number;
  latencyMs: number;
  error: string | null;
}

interface ProbeStats {
  connectivityProbes: ProbeResult[];
  passCount: number;
  failCount: number;
  latencySummary: ProbeLatencySummary;
  status: StatusLevel;
}

interface ExternalProductionProbeTarget {
  label: string;
  lane: ProbeResult["lane"];
  origin: string;
  path: string;
  headers?: Record<string, string>;
  expectedStatuses?: readonly number[];
  expectedFailureMessage?: string;
}

export interface StatusSelfCheckOptions {
  selfUrl?: string;
  signal?: AbortSignal;
  ctx?: ExecutionContext;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
  siteApiSharedSecret?: string | null;
  d1StatusConfig?: CloudflareD1StatusConfig;
  coingeckoApiKey?: string | null;
  cloudflareD1StatusBindings?: CloudflareD1StatusBindings;
  workerCanaryMode?: WorkerCanaryMode;
}

interface CollectedStatusSelfCheckProbes {
  probeBaseUrl: URL;
  probeMode: "internal-router" | "external-http";
  probeSelection: ReturnType<typeof selectStatusProbePathsForRun>;
  internalProbes: ProbeResult[];
  externalProbes: ProbeResult[];
  probes: ProbeResult[];
  internalSummary: StatusProbePlaneSummary | null;
  externalSummary: StatusProbePlaneSummary | null;
  internalExternalDiscrepancy: StatusProbeComparison;
}

const PUBLIC_PROBE_PATHS = getProbePaths("public");
const ADMIN_PROBE_PATHS = getProbePaths("admin").filter((path) => path !== "/api/status");

const CRITICAL_PROBE_PATHS = [...PUBLIC_PROBE_PATHS, ...ADMIN_PROBE_PATHS];

const DEFAULT_SELF_URL = API_ORIGIN;
const HEALTH_PROBE_PATH = "/api/health";
const STATUS_SELF_CHECK_INTERVAL_SEC = 15 * 60;
export const STATUS_DEEP_PROBE_ROTATION_BUCKETS = 3;
export const STATUS_DEEP_PROBE_FULL_SWEEP_WINDOW_SEC =
  STATUS_SELF_CHECK_INTERVAL_SEC * STATUS_DEEP_PROBE_ROTATION_BUCKETS;
const PROBE_TIMEOUT_MS = 10_000;
const OPS_API_ACCESS_GATE_EXPECTED_STATUSES = [302, 403] as const;
const SITE_API_ACCESS_GATE_EXPECTED_STATUSES = [401, 403] as const;
const BOOTSTRAP_CACHE_PRODUCER_BY_PATH: Record<string, string> = {
  "/api/usds-status": "sync-usds-status",
  "/api/bluechip-ratings": "sync-bluechip",
  "/api/yield-rankings": "sync-yield-data",
};
const PROBE_STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

const UNKNOWN_PROBE_SEVERITY = -1;

export async function isBootstrapCacheMiss(db: D1Database, path: string, status: number): Promise<boolean> {
  if (status !== 503) return false;
  const producerJob = BOOTSTRAP_CACHE_PRODUCER_BY_PATH[path];
  if (!producerJob) return false;
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS cnt FROM cron_runs WHERE job = ?")
      .bind(producerJob)
      .first<{ cnt: number | null }>();
    return (row?.cnt ?? 0) === 0;
  } catch {
    /* non-blocking: observability only */
    return false;
  }
}

function percentile(latencies: number[], quantile: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const bounded = Math.min(1, Math.max(0, quantile));
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * bounded));
  return sorted[idx];
}

function buildLatencySummary(probes: ProbeResult[]): ProbeLatencySummary {
  const latencies = probes.map((probe) => probe.latencyMs);
  return {
    minMs: probes.length > 0 ? Math.min(...latencies) : 0,
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: probes.length > 0 ? Math.max(...latencies) : 0,
  };
}

function computeProbeStats(probes: ProbeResult[]): ProbeStats {
  const connectivityProbes = probes.filter((probe) => !probe.error?.startsWith("reported-"));
  const passCount = connectivityProbes.filter((probe) => probe.ok).length;
  const failCount = connectivityProbes.length - passCount;
  const latencySummary = buildLatencySummary(connectivityProbes);
  const semanticProbeStatus = probes.reduce<StatusLevel>(
    (worst, probe) => (probe.semanticStatus ? maxProbeStatus(worst, probe.semanticStatus) : worst),
    "healthy",
  );
  return {
    connectivityProbes,
    passCount,
    failCount,
    latencySummary,
    status: maxProbeStatus(
      classifyProbeStatus(connectivityProbes.length, failCount, latencySummary.p95Ms),
      semanticProbeStatus,
    ),
  };
}

function summarizeProbePlane(probes: ProbeResult[]): StatusProbePlaneSummary | null {
  if (probes.length === 0) return null;
  const { passCount, failCount, latencySummary, status } = computeProbeStats(probes);
  return {
    status,
    sampleCount: probes.length,
    passCount,
    failCount,
    p95LatencyMs: latencySummary.p95Ms,
    origins: [...new Set(probes.map((probe) => probe.origin))],
  };
}

function toProbeRow(probe: ProbeResult): ProbeRow {
  return {
    path: probe.path,
    label: probe.label,
    plane: probe.plane,
    lane: probe.lane,
    origin: probe.origin,
    status: probe.status,
    latencyMs: probe.latencyMs,
    error: probe.error ?? null,
  };
}

function probeSummarySeverity(summary: StatusProbePlaneSummary | null): number {
  if (!summary || summary.status === "unknown") return UNKNOWN_PROBE_SEVERITY;
  return PROBE_STATUS_SEVERITY[summary.status];
}

function buildInternalExternalDiscrepancy(
  internal: StatusProbePlaneSummary | null,
  external: StatusProbePlaneSummary | null,
): StatusProbeComparison {
  const internalStatus = internal?.status ?? "unknown";
  const externalStatus = external?.status ?? "unknown";
  const internalSeverity = probeSummarySeverity(internal);
  const externalSeverity = probeSummarySeverity(external);
  const severityDelta = externalSeverity - internalSeverity;
  const reason: StatusProbeComparison["reason"] = !internal
    ? "internal-missing"
    : !external
      ? "external-missing"
      : severityDelta > 0
        ? "external-worse"
        : severityDelta < 0
          ? "internal-worse"
          : "in-sync";
  const planesDiverge = internal != null && external != null && severityDelta !== 0;

  return {
    hasDivergence: planesDiverge,
    severityDelta,
    internalStatus,
    externalStatus,
    reason,
    details: planesDiverge ? `internal=${internalStatus}, external=${externalStatus}, delta=${severityDelta}` : null,
  };
}

function getSlowestProbes(probes: ProbeResult[], limit = 3): ProbeRow[] {
  return [...probes]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, limit)
    .map(toProbeRow);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function selectStatusProbePathsForRun(
  nowSec: number,
  paths = CRITICAL_PROBE_PATHS,
): {
  paths: string[];
  rotationBucket: number;
  rotationBucketCount: number;
  fullSweepWindowSec: number;
  deepProbeCount: number;
  selectedDeepProbeCount: number;
} {
  const candidates = uniquePaths(paths);
  const deepProbePaths = candidates.filter((path) => path !== HEALTH_PROBE_PATH);
  const rotationBucketCount = Math.max(1, Math.min(STATUS_DEEP_PROBE_ROTATION_BUCKETS, deepProbePaths.length || 1));
  const rotationBucket =
    deepProbePaths.length === 0 ? 0 : Math.floor(nowSec / STATUS_SELF_CHECK_INTERVAL_SEC) % rotationBucketCount;
  const selectedDeepProbePaths = deepProbePaths.filter(
    (_path, index) => index % rotationBucketCount === rotationBucket,
  );

  return {
    paths: [HEALTH_PROBE_PATH, ...selectedDeepProbePaths],
    rotationBucket,
    rotationBucketCount,
    fullSweepWindowSec: rotationBucketCount * STATUS_SELF_CHECK_INTERVAL_SEC,
    deepProbeCount: deepProbePaths.length,
    selectedDeepProbeCount: selectedDeepProbePaths.length,
  };
}

export function classifyProbeStatus(sampleCount: number, failCount: number, p95LatencyMs: number): StatusLevel {
  if (sampleCount === 0) return "stale";
  const { healthyMaxFailCount, healthyP95MaxMs, degradedMaxFailRatio, degradedP95MaxMs } = STATUS_PROBE_THRESHOLDS;
  if (failCount <= healthyMaxFailCount && p95LatencyMs <= healthyP95MaxMs) return "healthy";
  const degradedFailCap = Math.max(healthyMaxFailCount, Math.floor(sampleCount * degradedMaxFailRatio));
  if (failCount <= degradedFailCap && p95LatencyMs <= degradedP95MaxMs) return "degraded";
  return "stale";
}

function maxProbeStatus(left: StatusLevel, right: StatusLevel): StatusLevel {
  return PROBE_STATUS_SEVERITY[left] >= PROBE_STATUS_SEVERITY[right] ? left : right;
}

function resolveProbeBaseUrl(selfUrl?: string): URL {
  try {
    return new URL(resolveOrigin(selfUrl, DEFAULT_SELF_URL));
  } catch {
    /* expected: malformed SELF_URL env var */
    return new URL(DEFAULT_SELF_URL);
  }
}

async function evaluateProbeResponse(
  path: string,
  response: Response,
): Promise<Pick<ProbeResult, "ok" | "error" | "semanticStatus">> {
  const httpOk = response.status >= 200 && response.status < 300;
  if (path !== HEALTH_PROBE_PATH || !httpOk) {
    await cancelResponseBodyQuietly(response);
    return { ok: httpOk };
  }

  try {
    const payload = (await response.json()) as { status?: unknown };
    if (payload.status === "healthy") {
      return {
        ok: true,
        semanticStatus: "healthy",
      };
    }
    if (payload.status === "degraded" || payload.status === "stale") {
      return {
        ok: false,
        error: `reported-${payload.status}`,
        semanticStatus: payload.status,
      };
    }
    return {
      ok: false,
      error: "invalid-health-status",
      semanticStatus: "stale",
    };
  } catch {
    /* degraded: health endpoint returned unparseable JSON */
    return {
      ok: false,
      error: "invalid-health-payload",
      semanticStatus: "stale",
    };
  }
}

function buildProbeResult(config: {
  path: string;
  label?: string;
  plane: ProbeResult["plane"];
  lane: ProbeResult["lane"];
  origin: string;
  startedAt: number;
  status: number;
  ok: boolean;
  error?: string;
  bootstrapMiss?: boolean;
  semanticStatus?: StatusLevel;
}): ProbeResult {
  return {
    path: config.path,
    label: config.label ?? config.path,
    plane: config.plane,
    lane: config.lane,
    origin: config.origin,
    status: config.status,
    latencyMs: Math.max(0, Date.now() - config.startedAt),
    ok: config.ok,
    ...(config.error ? { error: config.error } : {}),
    ...(config.bootstrapMiss ? { bootstrapMiss: true } : {}),
    ...(config.semanticStatus ? { semanticStatus: config.semanticStatus } : {}),
  };
}

async function probePathExternally(
  path: string,
  probeBaseUrl: URL,
  config: {
    label?: string;
    plane: ProbeResult["plane"];
    lane: ProbeResult["lane"];
    expectedStatuses?: readonly number[];
    expectedFailureMessage?: string;
    headers?: HeadersInit;
  },
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeout = createTimeoutSignal({
    timeoutMs: PROBE_TIMEOUT_MS,
    timeoutReason: "probe-timeout",
    parentSignal: signal,
  });

  try {
    const url = new URL(path, probeBaseUrl);
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: config.headers,
      redirect: "manual",
      signal: timeout.signal,
    });
    const status = res.status;
    if (config.expectedStatuses) {
      const ok = config.expectedStatuses.includes(status);
      await cancelResponseBodyQuietly(res);
      return buildProbeResult({
        path,
        label: config.label,
        plane: config.plane,
        lane: config.lane,
        origin: probeBaseUrl.origin,
        startedAt,
        status,
        ok,
        error: ok ? undefined : (config.expectedFailureMessage ?? `unexpected-status-${status}`),
      });
    }
    const semantic = await evaluateProbeResponse(path, res);
    return buildProbeResult({
      path,
      label: config.label,
      plane: config.plane,
      lane: config.lane,
      origin: probeBaseUrl.origin,
      startedAt,
      status,
      ok: semantic.ok,
      error: semantic.error,
      semanticStatus: semantic.semanticStatus,
    });
  } catch (error) {
    return buildProbeResult({
      path,
      label: config.label,
      plane: config.plane,
      lane: config.lane,
      origin: probeBaseUrl.origin,
      startedAt,
      status: 0,
      ok: false,
      error: timeout.isTimedOut() ? "timeout" : toErrorMessage(error),
    });
  } finally {
    timeout.dispose();
  }
}

async function probePathInternally(
  db: D1Database,
  path: string,
  probeBaseUrl: URL,
  ctx: ExecutionContext,
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const isAdminPath = ADMIN_PROBE_PATHS.includes(path);
    const url = new URL(path, isAdminPath ? DEFAULT_SELF_URL : probeBaseUrl);
    const headers = new Headers();
    if (isAdminPath) {
      headers.set("Cf-Access-Authenticated-User-Email", "internal-status-self-check@pharos.watch");
    }

    const request = new Request(url.toString(), {
      method: "GET",
      headers,
    });
    const response = await route({
      url,
      db,
      execCtx: ctx,
      request,
      trustedAdmin: isAdminPath,
      mintBurnFreshnessConfig,
    });
    if (!response) {
      return buildProbeResult({
        path,
        plane: "internal",
        lane: "self-check",
        origin: probeBaseUrl.origin,
        startedAt,
        status: 404,
        ok: false,
        error: "route-not-found",
      });
    }
    const status = response.status;
    const bootstrapMiss = await isBootstrapCacheMiss(db, path, status);
    if (bootstrapMiss) {
      await cancelResponseBodyQuietly(response);
      return buildProbeResult({
        path,
        plane: "internal",
        lane: "self-check",
        origin: probeBaseUrl.origin,
        startedAt,
        status,
        ok: true,
        error: "bootstrap-cache-miss",
        bootstrapMiss: true,
      });
    }
    const semantic = await evaluateProbeResponse(path, response);
    return buildProbeResult({
      path,
      plane: "internal",
      lane: "self-check",
      origin: probeBaseUrl.origin,
      startedAt,
      status,
      ok: semantic.ok,
      error: semantic.error,
      semanticStatus: semantic.semanticStatus,
    });
  } catch (error) {
    return buildProbeResult({
      path,
      plane: "internal",
      lane: "self-check",
      origin: probeBaseUrl.origin,
      startedAt,
      status: 0,
      ok: false,
      error: toErrorMessage(error),
    });
  }
}

function buildExternalProductionProbeTargets(siteApiSharedSecret?: string | null): ExternalProductionProbeTarget[] {
  const targets: ExternalProductionProbeTarget[] = [
    {
      label: "public-api-health",
      lane: "public-api",
      origin: API_ORIGIN,
      path: HEALTH_PROBE_PATH,
    },
  ];

  const siteSecret = siteApiSharedSecret?.trim();
  if (siteSecret) {
    targets.push({
      label: "site-api-health",
      lane: "site-api",
      origin: SITE_API_ORIGIN,
      path: HEALTH_PROBE_PATH,
      headers: {
        [SITE_DATA_PROXY_SECRET_HEADER]: siteSecret,
      },
    });
  } else {
    targets.push({
      label: "site-api-access-gate",
      lane: "site-api",
      origin: SITE_API_ORIGIN,
      path: HEALTH_PROBE_PATH,
      expectedStatuses: SITE_API_ACCESS_GATE_EXPECTED_STATUSES,
      expectedFailureMessage: "site-api-access-gate-open-or-unreachable",
    });
  }

  targets.push({
    label: "ops-api-access-gate",
    lane: "ops-api",
    origin: OPS_API_ORIGIN,
    path: "/api/status-history?limit=1",
    expectedStatuses: OPS_API_ACCESS_GATE_EXPECTED_STATUSES,
    expectedFailureMessage: "ops-api-access-gate-open-or-unreachable",
  });

  return targets;
}

async function runExternalProductionProbes(
  siteApiSharedSecret: string | null | undefined,
  signal?: AbortSignal,
): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];
  for (const target of buildExternalProductionProbeTargets(siteApiSharedSecret)) {
    if (signal?.aborted) break;
    probes.push(
      await probePathExternally(
        target.path,
        new URL(target.origin),
        {
          label: target.label,
          plane: "external",
          lane: target.lane,
          headers: target.headers,
          expectedStatuses: target.expectedStatuses,
          expectedFailureMessage: target.expectedFailureMessage,
        },
        signal,
      ),
    );
  }
  return probes;
}

async function collectStatusSelfCheckProbes(
  db: D1Database,
  now: number,
  options: Pick<
    StatusSelfCheckOptions,
    "selfUrl" | "signal" | "ctx" | "mintBurnFreshnessConfig" | "siteApiSharedSecret"
  >,
): Promise<CollectedStatusSelfCheckProbes> {
  const { selfUrl, signal, ctx, mintBurnFreshnessConfig, siteApiSharedSecret } = options;
  const probeBaseUrl = resolveProbeBaseUrl(selfUrl);
  const probeMode = ctx ? "internal-router" : "external-http";
  const probeSelection = selectStatusProbePathsForRun(now);
  const internalProbes: ProbeResult[] = [];

  for (const path of probeSelection.paths) {
    if (signal?.aborted) break;
    internalProbes.push(
      ctx
        ? await probePathInternally(db, path, probeBaseUrl, ctx, mintBurnFreshnessConfig)
        : await probePathExternally(
            path,
            probeBaseUrl,
            {
              plane: "internal",
              lane: "self-check",
            },
            signal,
          ),
    );
  }

  const externalProbes = await runExternalProductionProbes(siteApiSharedSecret, signal);
  const probes: ProbeResult[] = [...internalProbes, ...externalProbes];
  const internalSummary = summarizeProbePlane(internalProbes);
  const externalSummary = summarizeProbePlane(externalProbes);
  return {
    probeBaseUrl,
    probeMode,
    probeSelection,
    internalProbes,
    externalProbes,
    probes,
    internalSummary,
    externalSummary,
    internalExternalDiscrepancy: buildInternalExternalDiscrepancy(internalSummary, externalSummary),
  };
}

export async function runStatusSelfCheck(db: D1Database, options: StatusSelfCheckOptions = {}): Promise<CronResult> {
  const now = Math.floor(Date.now() / 1000);
  const d1CapacityMonitoring = options.d1StatusConfig
    ? await refreshD1CapacityMonitoring(db, options.d1StatusConfig, now)
    : null;
  let d1TableGrowthMonitoring: Record<string, unknown> | null = null;
  try {
    const snapshot = await refreshD1TableGrowthSnapshot(db, now);
    d1TableGrowthMonitoring = snapshot
      ? {
          checkedAt: snapshot.checkedAt,
          previousCheckedAt: snapshot.previousCheckedAt,
          tableCount: snapshot.tables.length,
          topGrowers: snapshot.topGrowers,
        }
      : null;
  } catch (error) {
    d1TableGrowthMonitoring = {
      checkedAt: null,
      error: toErrorMessage(error),
    };
  }
  const {
    probeBaseUrl,
    probeMode,
    probeSelection,
    probes,
    internalSummary,
    externalSummary,
    internalExternalDiscrepancy,
  } = await collectStatusSelfCheckProbes(db, now, options);

  const sampleCount = probes.length;
  const bootstrapMisses = probes.filter((probe) => probe.bootstrapMiss === true);
  const { passCount, failCount, latencySummary, status: probeStatus } = computeProbeStats(probes);
  const hasProbeFailure = failCount > 0 || internalExternalDiscrepancy.hasDivergence;
  const slowestProbes = getSlowestProbes(probes);
  const p95LatencyMs = latencySummary.p95Ms;
  const planes = {
    internal: internalSummary,
    external: externalSummary,
  };
  const probeRotation = {
    bucket: probeSelection.rotationBucket,
    bucketCount: probeSelection.rotationBucketCount,
    fullSweepWindowSec: probeSelection.fullSweepWindowSec,
    deepProbeCount: probeSelection.deepProbeCount,
    selectedDeepProbeCount: probeSelection.selectedDeepProbeCount,
  };
  const probeSummary = {
    timestamp: now,
    status: probeStatus,
    sampleCount,
    passCount,
    failCount,
    p95LatencyMs,
  } satisfies StatusProbeSummary;

  const probePersistenceSucceeded = await writeStatusProbeRun(db, now, {
    status: probeSummary.status,
    sampleCount: probeSummary.sampleCount,
    passCount: probeSummary.passCount,
    failCount: probeSummary.failCount,
    p95LatencyMs: probeSummary.p95LatencyMs ?? 0,
    details: {
      failed: probes
        .filter((probe) => !probe.ok)
        .slice(0, 10)
        .map(toProbeRow),
      bootstrapMisses: bootstrapMisses.map((probe) => ({
        path: probe.path,
        status: probe.status,
        latencyMs: probe.latencyMs,
      })),
      latencySummary,
      slowestProbes,
      planes,
      internalExternalDiscrepancy,
      probeRotation,
      probeBaseUrl: probeBaseUrl.origin,
      probeMode,
    },
  });

  const raw = await computeRawStatus(db, now);
  const persistedStatus = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
  const { effectiveStatus, persistenceSucceeded: statusPersistenceSucceeded } = persistedStatus;
  const cloudflareD1StatusBindings = options.cloudflareD1StatusBindings
    ?? (options.d1StatusConfig
      ? {
          CLOUDFLARE_ACCOUNT_ID: options.d1StatusConfig.accountId,
          CLOUDFLARE_D1_STATUS_API_TOKEN: options.d1StatusConfig.apiToken,
          CLOUDFLARE_D1_DATABASE_ID: options.d1StatusConfig.databaseId,
        }
      : undefined);
  const [publicHealthAssessment, supplements] = await Promise.all([
    assessPublicHealth(db, now, { logPrefix: "status-self-check" }),
    loadStatusSupplements(
      db,
      now,
      raw.crons,
      options.coingeckoApiKey,
      cloudflareD1StatusBindings,
      options.workerCanaryMode ?? "off",
    ),
  ]);
  const rawSnapshotPersistenceSucceeded = await writeStatusRawSnapshot(db, now, raw, {
    publicHealth: buildPublicHealthResponse(publicHealthAssessment, now),
    supplements,
  });
  const discrepancyObserved = hasDivergence(effectiveStatus, probeSummary, now);

  const discrepancyState = await updateDiscrepancyObservation(db, now, discrepancyObserved, hasProbeFailure);
  const discrepancy = buildDiscrepancy(effectiveStatus, probeSummary, now, discrepancyState.consecutiveDivergent);

  return {
    status: probeStatus === "stale" ? "degraded" : "ok",
    itemCount: sampleCount,
    metadata: JSON.stringify({
      sampleCount,
      passCount,
      failCount,
      p95LatencyMs,
      latencySummary,
      probeStatus,
      rawOverallStatus: raw.rawOverallStatus,
      effectiveStatus,
      probePersistenceSucceeded,
      statusPersistenceSucceeded,
      rawSnapshotPersistenceSucceeded,
      discrepancyPersistenceSucceeded: discrepancyState.persistenceSucceeded,
      discrepancy,
      discrepancyStreak: discrepancyState.consecutiveDivergent,
      probePlanes: planes,
      internalExternalDiscrepancy,
      slowestProbes,
      probeRotation,
      probeBaseUrl: probeBaseUrl.origin,
      probeMode,
      probeFailureStreak: discrepancyState.consecutiveProbeFailures,
      freshnessDiagnostics: raw.freshnessDiagnostics,
      d1CapacityMonitoring,
      d1TableGrowthMonitoring,
    }),
  };
}
