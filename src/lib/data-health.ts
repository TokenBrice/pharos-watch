import type { ApiMeta } from "@/lib/api";
import { ApiFetchError } from "@/lib/api";

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

function pickBaseState(meta: ApiMeta | null | undefined, ageMs: number | null, staleTime: number): DataHealthState {
  if (meta?.status === "stale") return "stale";
  if (meta?.status === "degraded" || meta?.warning) return "degraded";
  if (ageMs === null) return "unavailable";
  if (ageMs <= staleTime) return "fresh";
  if (ageMs <= 1.5 * staleTime) return "degraded";
  return "stale";
}

export function deriveDataHealth(input: QueryHealthInput): DataHealthInfo {
  const hasData = input.hasData ?? input.dataUpdatedAt > 0;
  const ageMs = input.dataUpdatedAt > 0 ? Date.now() - input.dataUpdatedAt : null;
  const baseState = pickBaseState(input.meta, ageMs, input.staleTime);

  if (input.error && !hasData) {
    if (isUnavailableError(input.error)) {
      return {
        label: input.label,
        state: "unavailable",
        message: "Data is not yet available.",
        dataUpdatedAt: input.dataUpdatedAt,
        ageMs,
        staleTime: input.staleTime,
        meta: input.meta ?? null,
      };
    }

    return {
      label: input.label,
      state: "error",
      message: "Failed to load data.",
      dataUpdatedAt: input.dataUpdatedAt,
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
      dataUpdatedAt: input.dataUpdatedAt,
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
      dataUpdatedAt: input.dataUpdatedAt,
      ageMs,
      staleTime: input.staleTime,
      meta: input.meta ?? null,
    };
  }

  const message =
    baseState === "fresh"
      ? "Data is fresh."
      : baseState === "degraded"
        ? "Data is delayed or from a degraded source."
        : "Data is stale.";

  return {
    label: input.label,
    state: baseState,
    message,
    dataUpdatedAt: input.dataUpdatedAt,
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

export function formatHealthAge(ms: number | null): string {
  if (ms == null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
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
