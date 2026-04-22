import { buildOnChainSourceKey } from "./yield-utils";

export const LEGACY_BEST_YIELD_SOURCE_KEY = "legacy-best";

export const YIELD_HISTORY_OWNERSHIP_HANDOFFS: Record<string, string[]> = {
  "usde-ethena": [
    buildOnChainSourceKey("usde-ethena"),
    "66985a81-9c51-46ca-9977-42b4fe7bc6df",
  ],
  "usds-sky": [
    buildOnChainSourceKey("usds-sky"),
    "d8c4eff5-c8a9-46fc-a888-057c4c668e72",
  ],
  "dai-makerdao": [
    buildOnChainSourceKey("dai-makerdao"),
    "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",
  ],
  "frxusd-frax": [
    buildOnChainSourceKey("frxusd-frax"),
    "42523cca-14b0-44f6-95fb-4781069520a5",
  ],
  "crvusd-curve": [
    "5fd328af-4203-471b-bd16-1705c726d926",
    "onchain:crvusd-curve:scrvusd-current-rate",
  ],
};

export function getSuppressedYieldHistorySourceKeys(stablecoinId: string): string[] {
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
