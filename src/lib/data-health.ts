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
  meta: ApiMeta | null | undefined,
  ageMs: number | null,
  staleTime: number,
): Exclude<DataHealthState, "error"> {
  if (meta?.status === "stale") return "stale";
  if (meta?.status === "degraded") return "degraded";
  if (ageMs === null) return "unavailable";
  if (ageMs <= FRESHNESS_RATIOS.FRESH * staleTime) return "fresh";
  if (ageMs <= FRESHNESS_RATIOS.DEGRADED * staleTime) return "degraded";
  return "stale";
}

function getBaseMessage(state: Exclude<DataHealthState, "error">): string {
  if (state === "unavailable") return "Data is not yet available.";
  if (state === "fresh") return "Data is fresh.";
  if (state === "degraded") return "Data is delayed or from a degraded source.";
  return "Data is stale.";
}

export function deriveDataHealth(input: QueryHealthInput): DataHealthInfo {
  const hasData = input.hasData ?? input.dataUpdatedAt > 0;
  const updatedAtMs = input.meta?.updatedAt != null && input.meta.updatedAt > 0
    ? input.meta.updatedAt * 1000
    : input.dataUpdatedAt;
  const ageMs = input.meta?.ageSeconds != null
    ? input.meta.ageSeconds * 1000
    : updatedAtMs > 0
      ? Date.now() - updatedAtMs
      : null;
  const baseState = pickBaseState(input.meta, ageMs, input.staleTime);

  if (input.error && !hasData) {
    if (isUnavailableError(input.error)) {
      return {
        label: input.label,
        state: "unavailable",
        message: "Data is not yet available.",
        dataUpdatedAt: updatedAtMs,
        ageMs,
        staleTime: input.staleTime,
        meta: input.meta ?? null,
      };
    }

    return {
      label: input.label,
      state: "error",
      message: "Failed to load data.",
      dataUpdatedAt: updatedAtMs,
      ageMs,
      staleTime: input.staleTime,
      meta: input.meta ?? null,
    };
  }

  if (input.error && hasData) {
    const state = baseState === "fresh" ? "degraded" : baseState;
    return {
      label: input.label,
      state,
      message: "Using last successful data while refresh retries.",
      dataUpdatedAt: updatedAtMs,
      ageMs,
      staleTime: input.staleTime,
      meta: input.meta ?? null,
    };
  }

  if (!hasData) {
    return {
      label: input.label,
      state: "unavailable",
      message: "Data is not yet available.",
      dataUpdatedAt: updatedAtMs,
      ageMs,
      staleTime: input.staleTime,
      meta: input.meta ?? null,
    };
  }

  const message = getBaseMessage(baseState);

  return {
    label: input.label,
    state: baseState,
    message,
    dataUpdatedAt: updatedAtMs,
    ageMs,
    staleTime: input.staleTime,
    meta: input.meta ?? null,
  };
}

export function mergeHealthStates(entries: DataHealthInfo[]): MergedDataHealth {
  if (entries.length === 0) {
    return { state: "fresh", affectedLabels: [], latestUpdatedAt: null };
  }

  let state: DataHealthState = "fresh";
  let latestUpdatedAt: number | null = null;
  const affectedLabels: string[] = [];

  for (const entry of entries) {
    if (STATE_PRIORITY[entry.state] > STATE_PRIORITY[state]) {
      state = entry.state;
    }
    if (entry.state !== "fresh") {
      affectedLabels.push(entry.label);
    }
    if (entry.dataUpdatedAt > 0 && (latestUpdatedAt === null || entry.dataUpdatedAt > latestUpdatedAt)) {
      latestUpdatedAt = entry.dataUpdatedAt;
    }
  }

  return { state, affectedLabels, latestUpdatedAt };
}

export function formatDataHealthTimestamp(
  timestampMs: number | null,
  locale?: Intl.LocalesArgument,
): string {
  if (!timestampMs || timestampMs <= 0) return "never";
  return new Date(timestampMs).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
