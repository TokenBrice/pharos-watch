import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { ReserveAdapterDefinition } from "./reserve-adapters/index";
import type { ReserveSyncStateRecord } from "../lib/live-reserves-store";

export const CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig);
export type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
export type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

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

  return JSON.stringify({
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
