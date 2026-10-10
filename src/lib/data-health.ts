import type { ApiMeta } from "@/lib/api";
import { ApiFetchError } from "@/lib/api";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

type DataHealthState = "fresh" | "degraded" | "stale" | "unavailable" | "error";

interface QueryHealthInput {
  label: string;
  dataUpdatedAt: number;
  staleTime: number;
  error?: unknown | null;
  hasData?: boolean;
  meta?: ApiMeta | null;
}

export interface DataHealthInfo {
  label: string;
  state: DataHealthState;
  message: string;
  dataUpdatedAt: number;
  ageMs: number | null;
  staleTime: number;
  meta: ApiMeta | null;
  degradationReason?: "age" | "source" | "refresh";
}

interface MergedDataHealth {
  state: DataHealthState;
  affectedLabels: string[];
  latestUpdatedAt: number | null;
}

const STATE_PRIORITY: Record<DataHealthState, number> = {
  error: 5,
  unavailable: 4,
  stale: 3,
  degraded: 2,
  fresh: 1,
};

function isUnavailableError(error: unknown): boolean {
  return error instanceof ApiFetchError && error.status === 503;
}

function pickBaseState(
  ageMs: number | null,
  staleTime: number,
  meta: ApiMeta | null | undefined,
): Exclude<DataHealthState, "error"> {
  if (ageMs === null) return "unavailable";
  const freshBudgetSec = meta && "freshBudgetSec" in meta ? meta.freshBudgetSec : undefined;
  const degradedBudgetSec = meta && "degradedBudgetSec" in meta ? meta.degradedBudgetSec : undefined;
  const freshBudgetMs = typeof freshBudgetSec === "number" && Number.isFinite(freshBudgetSec) && freshBudgetSec >= 0
    ? freshBudgetSec * 1000
    : FRESHNESS_RATIOS.FRESH * staleTime;
  const degradedBudgetMs = typeof degradedBudgetSec === "number" && Number.isFinite(degradedBudgetSec) && degradedBudgetSec >= 0
    ? degradedBudgetSec * 1000
    : FRESHNESS_RATIOS.DEGRADED * staleTime;
  if (ageMs <= freshBudgetMs) return "fresh";
  if (ageMs <= degradedBudgetMs) return "degraded";
  return "stale";
}

function hasServerDegradation(meta: ApiMeta | null | undefined): boolean {
  if (meta?.warning) return true;
  return Object.values(meta?.dependencies ?? {}).some((dependency) => dependency.status !== "fresh");
}

function getBaseMessage(state: Exclude<DataHealthState, "error">): string {
  if (state === "unavailable") return "Data is not yet available.";
  if (state === "fresh") return "Data is fresh.";
  if (state === "degraded") return "Data is delayed or from a degraded source.";
  return "Data is stale.";
}

export function deriveDataHealth(input: QueryHealthInput, nowMs = Date.now()): DataHealthInfo {
  const hasData = input.hasData ?? input.dataUpdatedAt > 0;
  const authorityUnavailable = input.meta?.updatedAt === null;
  const updatedAtMs = authorityUnavailable
    ? 0
    : input.meta?.updatedAt != null && input.meta.updatedAt > 0
      ? input.meta.updatedAt * 1000
      : input.dataUpdatedAt;
  const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : null;
  const classifiedState = authorityUnavailable
    ? input.meta?.status === "stale" ? "stale" : "unavailable"
    : pickBaseState(ageMs, input.staleTime, input.meta);
  const serverFloor = input.meta?.status === "stale"
    ? "stale"
    : input.meta?.status === "degraded" || hasServerDegradation(input.meta)
      ? "degraded"
      : null;
  const baseState = authorityUnavailable || serverFloor === null
    ? classifiedState
    : classifiedState === "unavailable" || STATE_PRIORITY[classifiedState] < STATE_PRIORITY[serverFloor]
      ? serverFloor
      : classifiedState;

  let state: DataHealthState = baseState;
  let message = getBaseMessage(baseState);
  let degradationReason: DataHealthInfo["degradationReason"];
  if (input.error && !hasData) {
    state = isUnavailableError(input.error) ? "unavailable" : "error";
    message = state === "unavailable" ? "Data is not yet available." : "Failed to load data.";
  } else if (input.error && hasData) {
    state = baseState === "fresh" ? "degraded" : baseState;
    message = "Using last successful data while refresh retries.";
    degradationReason = "refresh";
  } else if (!hasData) {
    state = "unavailable";
    message = "Data is not yet available.";
  } else if (baseState === "degraded") {
    degradationReason = classifiedState === "degraded" || input.meta?.warning?.startsWith("110 ")
      ? "age"
      : "source";
  }

  const result: DataHealthInfo = {
    label: input.label,
    state,
    message,
    dataUpdatedAt: updatedAtMs,
    ageMs,
    staleTime: input.staleTime,
    meta: input.meta ?? null,
  };
  if (degradationReason != null) result.degradationReason = degradationReason;
  return result;
}

export function mergeHealthStates(entries: DataHealthInfo[]): MergedDataHealth {
  if (entries.length === 0) {
    return { state: "fresh", affectedLabels: [], latestUpdatedAt: null };
  }

  let state: DataHealthState = "fresh";
  let latestUpdatedAt: number | null = null;
  let latestAffectedUpdatedAt: number | null = null;
  const affectedLabels: string[] = [];

  for (const entry of entries) {
    if (STATE_PRIORITY[entry.state] > STATE_PRIORITY[state]) {
      state = entry.state;
    }
    if (entry.state !== "fresh") {
      affectedLabels.push(entry.label);
      if (
        entry.dataUpdatedAt > 0
        && (latestAffectedUpdatedAt === null || entry.dataUpdatedAt > latestAffectedUpdatedAt)
      ) {
        latestAffectedUpdatedAt = entry.dataUpdatedAt;
      }
    }
    if (entry.dataUpdatedAt > 0 && (latestUpdatedAt === null || entry.dataUpdatedAt > latestUpdatedAt)) {
      latestUpdatedAt = entry.dataUpdatedAt;
    }
  }

  return {
    state,
    affectedLabels,
    latestUpdatedAt: state === "fresh" ? latestUpdatedAt : latestAffectedUpdatedAt,
  };
}

export function formatDataHealthTimestamp(
  timestampMs: number | null,
  locale?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  if (!timestampMs || timestampMs <= 0) return "never";
  return new Date(timestampMs).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}
