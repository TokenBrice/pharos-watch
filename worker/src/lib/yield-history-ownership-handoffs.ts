import { buildOnChainSourceKey } from "./yield-utils";

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
  "avusd-avant": [
    buildOnChainSourceKey("avusd-avant"),
    "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",
    "c74227a1-e738-4021-bbe1-13363815aecb",
  ],
  "dusd-dtrinity": [
    "defillama-weighted:dtrinity-sdusd",
    "78049985-79a8-4343-8618-3c27d41d5054",
    "f42cf641-393d-4671-895a-3c85cf7b1a57",
    "664664bb-31e0-4e65-808d-6dc82bdb05bb",
  ],
  "reusd-re-protocol": [
    "protocol-api:re-protocol-reusde",
  ],
};

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
