import type { CronResult } from "../lib/db";
import { route } from "../router";
import { sendAlert } from "../lib/alerts";
import { getProbePaths } from "@shared/lib/api-endpoints";
import { evaluateStatusAndPersist } from "../api/status";
import {
  buildDiscrepancy,
  markDiscrepancyAlertSent,
  STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC,
  STATUS_DISCREPANCY_ALERT_STREAK,
  updateDiscrepancyObservation,
  writeStatusProbeRun,
  type StatusLevel,
} from "../lib/status-reliability";

interface ProbeResult {
  path: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

const PUBLIC_PROBE_PATHS = getProbePaths("public");
const ADMIN_PROBE_PATHS = getProbePaths("admin").filter((path) => path !== "/api/status");

const CRITICAL_PROBE_PATHS = [
  ...PUBLIC_PROBE_PATHS,
  ...ADMIN_PROBE_PATHS,
];

function percentile95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function classifyProbeStatus(sampleCount: number, failCount: number, p95LatencyMs: number): StatusLevel {
  if (sampleCount === 0) return "stale";
  if (failCount === 0 && p95LatencyMs <= 3000) return "healthy";
  if (failCount <= Math.max(1, Math.floor(sampleCount * 0.1)) && p95LatencyMs <= 6000) return "degraded";
  return "stale";
}

async function probePath(
  db: D1Database,
  path: string,
  adminKey: string | undefined,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const url = new URL(`https://api.pharos.watch${path}`);
    const headers = new Headers();
    if (ADMIN_PROBE_PATHS.includes(path) && adminKey) {
      headers.set("X-Admin-Key", adminKey);
    }
    const request = new Request(url.toString(), { method: "GET", headers, signal });
    const probeCtx = {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const res = await route(url, db, probeCtx, request, adminKey);
    const status = res?.status ?? 404;
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
  signal?: AbortSignal,
): Promise<CronResult> {
  const now = Math.floor(Date.now() / 1000);
  const probes = await Promise.all(
    CRITICAL_PROBE_PATHS.map((path) => probePath(db, path, adminKey, signal))
  );

  const sampleCount = probes.length;
  const passCount = probes.filter((probe) => probe.ok).length;
  const failCount = sampleCount - passCount;
  const p95LatencyMs = percentile95(probes.map((probe) => probe.latencyMs));
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

  const discrepancyState = await updateDiscrepancyObservation(db, now, discrepancyObservation.hasDivergence);
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

  const shouldAlert =
    discrepancy.hasDivergence &&
    discrepancyState.consecutiveDivergent >= STATUS_DISCREPANCY_ALERT_STREAK &&
    (
      discrepancyState.lastAlertAt == null ||
      now - discrepancyState.lastAlertAt >= STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC
    );

  let alertSent = false;
  if (shouldAlert) {
    alertSent = await sendAlert(
      "Status divergence detected",
      `effective=${effectiveStatus}, raw=${raw.rawOverallStatus}, probe=${probeStatus}, ` +
      `delta=${discrepancy.severityDelta}, streak=${discrepancyState.consecutiveDivergent}`,
    );
    if (alertSent) {
      await markDiscrepancyAlertSent(db, now);
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
      probeStatus,
      rawOverallStatus: raw.rawOverallStatus,
      effectiveStatus,
      discrepancy,
      discrepancyStreak: discrepancyState.consecutiveDivergent,
      alertAttempted: shouldAlert,
      alertSent,
    }),
  };
}
