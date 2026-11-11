import { YIELD_HISTORY_IDENTITY_TRANSITIONS } from "./yield-config/yield-history-identity-transitions";

export const LEGACY_BEST_YIELD_SOURCE_KEY = "legacy-best";

/**
 * A "genuine" source switch: there is a recorded previous best source key, it is
 * not the legacy-best sentinel, and it differs from the current source key. This
 * is the rule that gates published source-switch signals, so it lives once here.
 */
export function isRealSourceSwitch(
  previousBestSourceKey: string | null | undefined,
  currentSourceKey: string,
): boolean {
  return (
    previousBestSourceKey != null &&
    previousBestSourceKey !== LEGACY_BEST_YIELD_SOURCE_KEY &&
    previousBestSourceKey !== currentSourceKey
  );
}

export const YIELD_HISTORY_OWNERSHIP_HANDOFFS: Record<string, string[]> =
  YIELD_HISTORY_IDENTITY_TRANSITIONS.ownershipHandoffs;

function getSuppressedYieldHistorySourceKeys(stablecoinId: string): string[] {
  return YIELD_HISTORY_OWNERSHIP_HANDOFFS[stablecoinId] ?? [];
}

export function isSuppressedYieldHistoryRow(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  const suppressedSourceKeys = getSuppressedYieldHistorySourceKeys(stablecoinId);
  if (suppressedSourceKeys.length === 0) return false;
  if (sourceKey == null) return true;
  if (sourceKey === LEGACY_BEST_YIELD_SOURCE_KEY) return true;
  return suppressedSourceKeys.includes(sourceKey);
}
