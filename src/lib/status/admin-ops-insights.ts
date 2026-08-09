import type { HealthResponse, StatusResponse } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { numberValue as readNumber, readRecord } from "@shared/lib/type-guards";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";

type CronStatus = StatusResponse["crons"][string];

export interface ReserveRecoveryForecast {
  state: "clear" | "catching-up" | "watch" | "blocked";
  headline: string;
  detail: string;
  nextRunAt: number | null;
  resumeCursor: string | null;
  estimatedRunsToClear: number | null;
  lastThroughput: number | null;
}

export interface ActionReadinessCheck {
  id: string;
  label: string;
  state: "ready" | "watch" | "blocked";
  detail: string;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getCronNextRunAt(cron: CronStatus | undefined): number | null {
  if (!cron?.lastRun) return null;
  return cron.lastRun.startedAt + cron.expectedIntervalSec;
}

export function buildReserveRecoveryForecast(data: StatusResponse): ReserveRecoveryForecast {
  const reserve = data.reserveComposition;
  const cron = data.crons["sync-live-reserves"];
  const metadata = readRecord(cron?.lastRun?.metadata);
  const synced = readNumber(metadata?.synced) ?? cron?.lastRun?.itemCount ?? null;
  const total = readNumber(metadata?.total);
  const throughput = synced != null && synced > 0 ? synced : null;
  const estimatedRunsToClear =
    reserve.deferredCoins > 0 && throughput != null ? Math.max(1, Math.ceil(reserve.deferredCoins / throughput)) : null;
  const nextRunAt = getCronNextRunAt(cron);
  const resumeCursor = reserve.nextCursorStablecoinId ?? readString(metadata?.nextCursorStablecoinId);

  if (cron?.inFlight?.stale || reserve.cursorTailError) {
    return {
      state: "blocked",
      headline: "Reserve recovery needs operator attention",
      detail: cron?.inFlight?.stale
        ? "The live reserve lane has a stale in-flight lease; verify the lease before waiting on another pass."
        : `The deferred cursor tail failed: ${reserve.cursorTailError}`,
      nextRunAt,
      resumeCursor,
      estimatedRunsToClear,
      lastThroughput: throughput,
    };
  }

  if (reserve.deferredCoins > 0 || reserve.runBudgetTruncated) {
    const throughputLabel =
      throughput != null
        ? `Last completed run processed ${throughput}${total != null ? `/${total}` : ""} coin(s).`
        : "Last-run throughput is not available.";
    const runsLabel =
      estimatedRunsToClear != null
        ? `Estimated ${estimatedRunsToClear} scheduled run${estimatedRunsToClear === 1 ? "" : "s"} to drain the deferred queue.`
        : "Run estimate unavailable until a completed pass reports throughput.";

    return {
      state: "catching-up",
      headline: "Waiting for the live-reserve lane to catch up",
      detail: `${reserve.deferredCoins} coin(s) remain deferred${resumeCursor ? ` from ${resumeCursor}` : ""}. ${throughputLabel} ${runsLabel}`,
      nextRunAt,
      resumeCursor,
      estimatedRunsToClear,
      lastThroughput: throughput,
    };
  }

  if (
    reserve.writeTimeoutUncertain > 0 ||
    reserve.cursorTailState === "recording" ||
    reserve.cursorTailState === "incomplete"
  ) {
    return {
      state: "watch",
      headline: "Reserve recovery is not blocked, but writes need confirmation",
      detail: `${reserve.writeTimeoutUncertain} uncertain write(s); cursor tail ${reserve.cursorTailState ?? "clear"}. Wait for the next clean pass before treating score inputs as fully restored.`,
      nextRunAt,
      resumeCursor,
      estimatedRunsToClear,
      lastThroughput: throughput,
    };
  }

  if (reserve.status !== "healthy") {
    return {
      state: "watch",
      headline: "Reserve evidence is degraded without an active deferred queue",
      detail: "No run-budget cursor is pending, but reserve coverage is still below the healthy threshold.",
      nextRunAt,
      resumeCursor,
      estimatedRunsToClear,
      lastThroughput: throughput,
    };
  }

  return {
    state: "clear",
    headline: "Reserve recovery queue is clear",
    detail: "No deferred reserve cursor, stale write, or run-budget truncation is active.",
    nextRunAt,
    resumeCursor,
    estimatedRunsToClear,
    lastThroughput: throughput,
  };
}

export function buildActionReadinessChecks({
  data,
  healthData,
  clientDataStale,
  recommendedActions,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  clientDataStale: boolean;
  recommendedActions: StatusActionRecommendation[];
}): ActionReadinessCheck[] {
  const reserve = data.reserveComposition;
  const reserveCron = data.crons["sync-live-reserves"];
  const reserveForecast = buildReserveRecoveryForecast(data);

  return [
    {
      id: "fresh-status-view",
      label: "Dashboard data",
      state: clientDataStale ? "watch" : "ready",
      detail: clientDataStale
        ? "At least one required status, health, or critical browser-probe signal is missing or outside its polling budget; refresh before acting."
        : "Status, public health, and critical browser-probe evidence are fresh enough for triage.",
    },
    {
      id: "public-health",
      label: "Public health",
      state:
        healthData == null
          ? "watch"
          : healthData.status === "stale"
            ? "blocked"
            : healthData.status === "degraded"
              ? "watch"
              : "ready",
      detail:
        healthData == null
          ? "Public /api/health has not loaded in this browser session."
          : `Public /api/health is ${healthData.status}.`,
    },
    {
      id: "d1-writes",
      label: "D1 write path",
      state: !data.dbHealthy || reserve.writeTimeoutUncertain > 0 ? "blocked" : "ready",
      detail: !data.dbHealthy
        ? "Status reports D1 unhealthy; avoid write-heavy recovery actions."
        : reserve.writeTimeoutUncertain > 0
          ? `${reserve.writeTimeoutUncertain} live reserve write outcome(s) are uncertain.`
          : "D1 is healthy and no uncertain live-reserve writes are active.",
    },
    {
      id: "reserve-lane",
      label: "Reserve lane",
      state: reserveForecast.state === "blocked" ? "blocked" : reserveCron?.inFlight ? "watch" : "ready",
      detail: reserveCron?.inFlight
        ? `sync-live-reserves is running${reserveCron.inFlight.stage ? ` at ${reserveCron.inFlight.stage}` : ""}.`
        : reserveForecast.headline,
    },
    {
      id: "reserve-cursor",
      label: "Reserve cursor",
      state:
        reserveForecast.state === "blocked"
          ? "blocked"
          : reserveForecast.state === "catching-up" || reserveForecast.state === "watch"
            ? "watch"
            : "ready",
      detail: reserveForecast.resumeCursor
        ? `Next pass resumes at ${reserveForecast.resumeCursor}; ${reserve.deferredCoins} coin(s) deferred.`
        : reserveForecast.detail,
    },
    {
      id: "manual-actions",
      label: "Manual actions",
      state: recommendedActions.length > 0 ? "watch" : "ready",
      detail:
        recommendedActions.length > 0
          ? `${recommendedActions.length} recommended action(s) are active; inspect before running broad recovery.`
          : "No manual recovery action is currently recommended by the status model.",
    },
  ];
}

export function formatNextRunWindow(nextRunAt: number | null, nowSeconds: number): string {
  if (nextRunAt == null) return "next run unknown";
  if (nextRunAt <= nowSeconds) return "next run due now";
  return `next run in ${formatElapsedSeconds(nextRunAt - nowSeconds)}`;
}
