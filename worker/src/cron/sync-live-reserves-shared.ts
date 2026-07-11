import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters-definitions";
import type { LiveReserveEvidenceClass } from "@shared/types/live-reserves";
import type { ReserveAdapterDefinition } from "./reserve-adapters/index";
import type { ReserveSyncStateRecord } from "../lib/live-reserves-store";
import { toErrorMessage } from "../lib/error-utils";
import { fnv1aHash } from "../lib/hash";

export const CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig);
export type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
export type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

const EVIDENCE_CLASS_SYNC_PRIORITY: Record<LiveReserveEvidenceClass, number> = {
  "independent": 0,
  "static-validated": 1,
  "weak-live-probe": 2,
};

/**
 * Builds the base sync queue order so run-budget truncation drops the
 * least valuable work first:
 *
 * 1. Evidence class: `independent` adapters (score-grade collateral evidence)
 *    run before `static-validated`, which run before `weak-live-probe`.
 * 2. Source-invariant grouping: coins sharing a `source-invariant` adapter
 *    (one fetch serves every coin) are made contiguous within their
 *    evidence-class segment, anchored at the group's first occurrence, so the
 *    already-paid shared fetch is reused immediately instead of the queue
 *    tail paying full price after the budget is gone.
 * 3. Otherwise the existing deterministic registry order is preserved.
 */
export function orderConfiguredCoinsForSync(
  configuredCoins: readonly ConfiguredCoin[],
): ConfiguredCoin[] {
  const groupAnchorIndexes = new Map<string, number>();
  const entries = configuredCoins.map((coin, index) => {
    const config = coin.liveReservesConfig!;
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
    const groupKey = definition.sharedSourceMode === "source-invariant"
      ? `adapter:${config.adapter}`
      : `coin:${coin.id}`;
    if (!groupAnchorIndexes.has(groupKey)) {
      groupAnchorIndexes.set(groupKey, index);
    }
    return {
      coin,
      index,
      priority: EVIDENCE_CLASS_SYNC_PRIORITY[definition.evidenceClass],
      groupKey,
    };
  });

  return entries
    .sort((a, b) => (
      a.priority - b.priority
      || groupAnchorIndexes.get(a.groupKey)! - groupAnchorIndexes.get(b.groupKey)!
      || a.index - b.index
    ))
    .map((entry) => entry.coin);
}

export const SYNC_ORDERED_CONFIGURED_COINS = orderConfiguredCoinsForSync(CONFIGURED_COINS);
export const LIVE_RESERVE_QUEUE_HASH = fnv1aHash(JSON.stringify(
  SYNC_ORDERED_CONFIGURED_COINS.map((coin) => ({
    id: coin.id,
    adapter: coin.liveReservesConfig?.adapter ?? null,
    version: coin.liveReservesConfig?.version ?? null,
    breakerScope: coin.liveReservesConfig?.breakerScope ?? null,
  })),
));
export const CONFIGURED_LIVE_RESERVE_BREAKER_KEYS = new Set(
  CONFIGURED_COINS.map((coin) => breakerKeyForConfig(coin.liveReservesConfig!)),
);

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
      message: toErrorMessage(primaryError),
    },
    ...fallbackAttempts.map((attempt) => ({
      source: "fallback" as const,
      label: describeReserveInput(attempt.input, "fallback", attempt.index),
      message: toErrorMessage(attempt.error),
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
