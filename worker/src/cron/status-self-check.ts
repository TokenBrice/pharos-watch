import type { CronResult } from "../lib/db";
import { sendAlert } from "../lib/alerts";
import { getProbePaths } from "@shared/lib/api-endpoints";
import { evaluateStatusAndPersist } from "../api/status";
import { route } from "../router";
import {
  buildDiscrepancy,
  markProbeFailureAlertSent,
  markDiscrepancyAlertSent,
  STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC,
  STATUS_DISCREPANCY_ALERT_STREAK,
  updateDiscrepancyObservation,
  writeStatusProbeRun,
  type StatusLevel,
} from "../lib/status-reliability";
import type { MintBurnFreshnessConfig } from "../lib/mint-burn-health-config";

interface ProbeResult {
  path: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

interface ProbeLatencySummary {
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

const PUBLIC_PROBE_PATHS = getProbePaths("public");
const ADMIN_PROBE_PATHS = getProbePaths("admin").filter((path) => path !== "/api/status");

const CRITICAL_PROBE_PATHS = [
  ...PUBLIC_PROBE_PATHS,
  ...ADMIN_PROBE_PATHS,
];

const DEFAULT_SELF_URL = "https://api.pharos.watch";
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_FAILURE_ALERT_THRESHOLD = 3;

function percentile95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
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
    p95Ms: percentile95(latencies),
    maxMs: probes.length > 0 ? Math.max(...latencies) : 0,
  };
}

function getSlowestProbes(probes: ProbeResult[], limit = 3): Array<{
  path: string;
  status: number;
  latencyMs: number;
  error: string | null;
}> {
  return [...probes]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, limit)
    .map((probe) => ({
      path: probe.path,
      status: probe.status,
      latencyMs: probe.latencyMs,
      error: probe.error ?? null,
    }));
}

function classifyProbeStatus(sampleCount: number, failCount: number, p95LatencyMs: number): StatusLevel {
  if (sampleCount === 0) return "stale";
  if (failCount === 0 && p95LatencyMs <= 3000) return "healthy";
  if (failCount <= Math.max(1, Math.floor(sampleCount * 0.1)) && p95LatencyMs <= 6000) return "degraded";
  return "stale";
}

function resolveProbeBaseUrl(selfUrl?: string): URL {
  const trimmed = selfUrl?.trim();
  if (!trimmed) {
    return new URL(DEFAULT_SELF_URL);
  }

  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return new URL(DEFAULT_SELF_URL);
  }
}

function shouldUseInternalProbe(probeBaseUrl: URL, ctx?: ExecutionContext): boolean {
  return !!ctx && probeBaseUrl.origin === DEFAULT_SELF_URL;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Non-blocking: some runtimes may expose already-consumed or non-cancelable bodies.
  }
}

async function probePathExternally(
  path: string,
  probeBaseUrl: URL,
  adminKey: string | undefined,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort("probe-timeout");
  }, PROBE_TIMEOUT_MS);
  const forwardAbort = () => timeoutController.abort(signal?.reason);

  try {
    if (signal?.aborted) {
      forwardAbort();
    } else if (signal) {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }

    const url = new URL(path, probeBaseUrl);
    const headers = new Headers();
    if (ADMIN_PROBE_PATHS.includes(path) && adminKey) {
      headers.set("X-Admin-Key", adminKey);
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: timeoutController.signal,
    });
    const status = res.status;
    await cancelResponseBody(res);
    return {
      path,
      status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ok: status >= 200 && status < 300,
    };
  } catch (error) {
    return {
      path,
      status: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ok: false,
      error: timedOut ? "timeout" : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function probePathInternally(
  db: D1Database,
  path: string,
  probeBaseUrl: URL,
  adminKey: string | undefined,
  ctx: ExecutionContext,
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const url = new URL(path, probeBaseUrl);
    const headers = new Headers();
    if (ADMIN_PROBE_PATHS.includes(path) && adminKey) {
      headers.set("X-Admin-Key", adminKey);
    }

    const request = new Request(url.toString(), {
      method: "GET",
      headers,
    });
    const response = await route(
      url,
      db,
      ctx,
      request,
      adminKey,
      undefined,
      mintBurnFreshnessConfig,
    );
    if (!response) {
      return {
        path,
        status: 404,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ok: false,
        error: "route-not-found",
      };
    }
    const status = response.status;
    await cancelResponseBody(response);
    return {
      path,
      status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ok: status >= 200 && status < 300,
    };
  } catch (error) {
    return {
      path,
      status: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runStatusSelfCheck(
  db: D1Database,
  adminKey?: string,
  selfUrl?: string,
  signal?: AbortSignal,
  ctx?: ExecutionContext,
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig,
): Promise<CronResult> {
  const probeBaseUrl = resolveProbeBaseUrl(selfUrl);
  const probeMode = shouldUseInternalProbe(probeBaseUrl, ctx) ? "internal-router" : "external-http";
  const probes: ProbeResult[] = [];
  for (const path of CRITICAL_PROBE_PATHS) {
    if (signal?.aborted) break;
    probes.push(
      probeMode === "internal-router" && ctx
        ? await probePathInternally(db, path, probeBaseUrl, adminKey, ctx, mintBurnFreshnessConfig)
        : await probePathExternally(path, probeBaseUrl, adminKey, signal)
    );
  }
  const now = Math.floor(Date.now() / 1000);

  const sampleCount = probes.length;
  const passCount = probes.filter((probe) => probe.ok).length;
  const failCount = sampleCount - passCount;
  const hasProbeFailure = failCount > 0;
  const latencySummary = buildLatencySummary(probes);
  const slowestProbes = getSlowestProbes(probes);
  const p95LatencyMs = latencySummary.p95Ms;
  const probeStatus = classifyProbeStatus(sampleCount, failCount, p95LatencyMs);

  await writeStatusProbeRun(db, now, {
    status: probeStatus,
    sampleCount,
    passCount,
    failCount,
    p95LatencyMs,
    details: {
      failed: probes
        .filter((probe) => !probe.ok)
        .slice(0, 10)
        .map((probe) => ({
          path: probe.path,
          status: probe.status,
          latencyMs: probe.latencyMs,
          error: probe.error ?? null,
        })),
      latencySummary,
      slowestProbes,
      probeBaseUrl: probeBaseUrl.origin,
      probeMode,
    },
  });

  const { raw, effectiveStatus } = await evaluateStatusAndPersist(db, now);
  const discrepancyObservation = buildDiscrepancy(
    effectiveStatus,
    {
      timestamp: now,
      status: probeStatus,
      sampleCount,
      passCount,
      failCount,
      p95LatencyMs,
    },
    now,
    0,
  );

  const discrepancyState = await updateDiscrepancyObservation(
    db,
    now,
    discrepancyObservation.hasDivergence,
    hasProbeFailure,
  );
  const discrepancy = buildDiscrepancy(
    effectiveStatus,
    {
      timestamp: now,
      status: probeStatus,
      sampleCount,
      passCount,
      failCount,
      p95LatencyMs,
    },
    now,
    discrepancyState.consecutiveDivergent,
  );

  const shouldDiscrepancyAlert =
    discrepancy.hasDivergence &&
    discrepancyState.consecutiveDivergent >= STATUS_DISCREPANCY_ALERT_STREAK &&
    (
      discrepancyState.lastAlertAt == null ||
      now - discrepancyState.lastAlertAt >= STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC
    );
  const shouldProbeFailureAlert =
    hasProbeFailure &&
    discrepancyState.consecutiveProbeFailures >= PROBE_FAILURE_ALERT_THRESHOLD &&
    (
      discrepancyState.lastProbeAlertAt == null ||
      now - discrepancyState.lastProbeAlertAt >= STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC
    );

  let discrepancyAlertSent = false;
  if (shouldDiscrepancyAlert) {
    discrepancyAlertSent = await sendAlert(
      "Status divergence detected",
      `effective=${effectiveStatus}, raw=${raw.rawOverallStatus}, probe=${probeStatus}, ` +
      `delta=${discrepancy.severityDelta}, streak=${discrepancyState.consecutiveDivergent}`,
    );
    if (discrepancyAlertSent) {
      await markDiscrepancyAlertSent(db, now);
    }
  }

  let probeFailureAlertSent = false;
  if (shouldProbeFailureAlert) {
    probeFailureAlertSent = await sendAlert(
      "Status probe failures detected",
      `probe=${probeStatus}, failures=${failCount}/${sampleCount}, streak=${discrepancyState.consecutiveProbeFailures}`,
    );
    if (probeFailureAlertSent) {
      await markProbeFailureAlertSent(db, now);
    }
  }

  return {
    status: discrepancy.hasDivergence || probeStatus !== "healthy" ? "degraded" : "ok",
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
      discrepancy,
      discrepancyStreak: discrepancyState.consecutiveDivergent,
      slowestProbes,
      probeBaseUrl: probeBaseUrl.origin,
      probeMode,
      probeFailureStreak: discrepancyState.consecutiveProbeFailures,
      alertAttempted: shouldDiscrepancyAlert,
      alertSent: discrepancyAlertSent,
      probeFailureAlertAttempted: shouldProbeFailureAlert,
      probeFailureAlertSent,
    }),
  };
}
