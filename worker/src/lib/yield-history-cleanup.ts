import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
  isSuppressedYieldHistoryRow,
} from "./yield-history-ownership-handoffs";

export const YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY = "yield-history-cleanup:writer-pause";

export interface YieldHistoryCleanupTarget {
  stablecoinId: string;
  sourceKeys: string[];
}

export interface YieldHistoryWriterPause {
  reason: string;
  pausedAt: number;
  operator: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function listYieldHistoryCleanupTargets(): YieldHistoryCleanupTarget[] {
  return Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS).map(([stablecoinId, sourceKeys]) => ({
    stablecoinId,
    sourceKeys,
  }));
}

export function isYieldHistoryCleanupTargetRow(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  return isSuppressedYieldHistoryRow(stablecoinId, sourceKey);
}

export function parseYieldHistoryWriterPause(
  cached: { value: string; updatedAt: number } | null,
): YieldHistoryWriterPause | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;
    const reason = typeof record.reason === "string" ? record.reason : null;
    const pausedAt = typeof record.pausedAt === "number" ? record.pausedAt : null;
    const operator =
      record.operator == null || typeof record.operator === "string"
        ? (record.operator ?? null)
        : null;
    if (!reason || pausedAt == null) return null;
    return { reason, pausedAt, operator };
  } catch {
    return null;
  }
}

export function buildYieldHistoryWriterPausePayload(
  reason = "yield-history-cleanup",
  operator: string | null = null,
  pausedAt = Math.floor(Date.now() / 1000),
): YieldHistoryWriterPause {
  return {
    reason,
    pausedAt,
    operator,
  };
}

export { LEGACY_BEST_YIELD_SOURCE_KEY };
