import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { ReserveAdapterDefinition } from "./reserve-adapters/index";
import type { ReserveSyncStateRecord } from "../lib/live-reserves-store";

export const CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig);
export type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
export type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

export interface ReserveAttemptFailureSummary {
  source: "primary" | "fallback";
  label: string;
  message: string;
}

export interface ReserveAdapterAttemptChainError extends Error {
  attemptSummaries: ReserveAttemptFailureSummary[];
}

export type ReserveFailureCategory =
  | "adapter-config"
  | "circuit-open"
  | "network"
  | "upstream-http"
  | "parser-drift"
  | "parse-failure"
  | "validation"
  | "storage-write"
  | "unknown";

export function breakerKeyForConfig(config: LiveReserveConfig): string {
  return `live-reserves:${config.breakerScope ?? config.adapter}`;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function buildSharedSourceCacheKey(
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
): string | null {
  if (adapter.sharedSourceMode !== "source-invariant") {
    return null;
  }

  const primary = config.inputs.primary;
  if (primary.kind !== "http-json" && primary.kind !== "http-html") {
    return null;
  }

  return canonicalStringify({
    adapter: config.adapter,
    version: config.version,
    semantics: config.semantics,
    inputs: {
      primary,
      fallbacks: config.inputs.fallbacks ?? null,
    },
    params: config.params ?? null,
  });
}

export function buildReserveSyncStateRecord(args: {
  stablecoinId: string;
  config: LiveReserveConfig;
  breakerKey: string;
  previousLastSuccessAt: number | null;
  previousLastSuccessAttemptId?: string | null;
  attemptId: string;
  now: number;
  status: ReserveSyncStateRecord["lastStatus"];
  warnings?: ReserveSyncStateRecord["warnings"];
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  lastSuccessAt?: number | null;
  lastSuccessAttemptId?: string | null;
}): ReserveSyncStateRecord {
  const warnings = args.warnings ?? [];
  return {
    stablecoinId: args.stablecoinId,
    adapterKey: args.config.adapter,
    breakerKey: args.breakerKey,
    lastAttemptedAt: args.now,
    lastSuccessAt: args.lastSuccessAt ?? args.previousLastSuccessAt,
    lastStatus: args.status,
    warningCount: warnings.length,
    warnings,
    lastError: args.lastError ?? null,
    metadata: args.metadata ?? {},
    lastAttemptId: args.attemptId,
    pendingAttemptId: args.attemptId,
    lastSuccessAttemptId: args.lastSuccessAttemptId ?? args.previousLastSuccessAttemptId ?? null,
  };
}

export function classifyFailure(reason: string, lastError: string | null): ReserveFailureCategory {
  if (reason === "unknown-adapter") return "adapter-config";
  if (reason === "circuit-open") return "circuit-open";
  if (reason === "storage-write-timeout" || reason === "success-finalize-rejected") return "storage-write";
  if (reason === "validation-failed" || reason === "fatal-warning" || reason === "empty-slices") return "validation";

  const message = (lastError ?? "").toLowerCase();
  if (message.includes("adapter params invalid") || message.includes("adapter requires")) {
    return "adapter-config";
  }
  if (reason === "adapter-exception" && message.includes("invalid reserve output")) {
    return "validation";
  }
  if (message.includes("layout-changed")) return "parser-drift";
  if (message.includes("parse-failed") || message.includes("json parse failed")) return "parse-failure";
  if (message.includes("d1 write timeout") || message.includes("sqlite") || message.includes("database")) return "storage-write";
  if (/\bhttp\s+[45]\d{2}\b/.test(message)) return "upstream-http";
  if (
    message.includes("fetch failed")
    || message.includes("no-response")
    || message.includes("adapter-timeout")
    || message.includes("timed out")
    || message.includes("aborted")
    || message.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

function toAttemptMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeReserveInput(
  input: LiveReserveConfig["inputs"]["primary"],
  source: ReserveAttemptFailureSummary["source"],
  fallbackIndex?: number,
): string {
  if (source === "fallback") {
    return `fallback#${(fallbackIndex ?? 0) + 1}:${input.kind}`;
  }
  return `primary:${input.kind}`;
}

export function buildReserveAdapterAttemptChainError(
  config: LiveReserveConfig,
  primaryError: unknown,
  fallbackAttempts: Array<{
    input: LiveReserveConfig["inputs"]["primary"];
    error: unknown;
    index: number;
  }>,
): ReserveAdapterAttemptChainError {
  const attemptSummaries: ReserveAttemptFailureSummary[] = [
    {
      source: "primary",
      label: describeReserveInput(config.inputs.primary, "primary"),
      message: toAttemptMessage(primaryError),
    },
    ...fallbackAttempts.map((attempt) => ({
      source: "fallback" as const,
      label: describeReserveInput(attempt.input, "fallback", attempt.index),
      message: toAttemptMessage(attempt.error),
    })),
  ];

  const error = new Error(
    attemptSummaries.map((attempt) => `${attempt.label}: ${attempt.message}`).join(" | "),
  ) as ReserveAdapterAttemptChainError;
  error.name = "ReserveAdapterAttemptChainError";
  error.attemptSummaries = attemptSummaries;
  return error;
}

export function isReserveAdapterAttemptChainError(error: unknown): error is ReserveAdapterAttemptChainError {
  return (
    error instanceof Error
    && Array.isArray((error as Partial<ReserveAdapterAttemptChainError>).attemptSummaries)
  );
}
