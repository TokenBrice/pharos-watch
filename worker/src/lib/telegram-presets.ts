import { getCirculatingRaw } from "@shared/lib/supply";
import {
  WORKER_ACTIVE_STABLECOINS,
  WORKER_TRACKED_META_BY_ID,
  WORKER_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  TELEGRAM_PRESET_DEFINITIONS,
  type TelegramPresetDefinition,
  type TelegramPresetId,
} from "@shared/lib/telegram-presets";

export {
  TELEGRAM_PRESET_LABEL_BY_ID,
  type TelegramPresetDefinition,
  type TelegramPresetId,
} from "@shared/lib/telegram-presets";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "./stablecoins-cache";

/** Matches the ResolvedCoin shape from telegram-alerts.ts — duplicated here to avoid a circular import. */
interface ResolvedCoin { id: string; symbol: string; name: string }

export interface ResolvedTelegramPreset {
  definition: TelegramPresetDefinition;
  stablecoinIds: string[];
  coins: ResolvedCoin[];
}

interface TelegramPresetResolveError {
  kind: "error";
  reason: "stablecoins-cache-unavailable";
}

interface TelegramPresetResolveOk {
  kind: "ok";
  presets: ResolvedTelegramPreset[];
}

export type TelegramPresetResolveResult =
  | TelegramPresetResolveError
  | TelegramPresetResolveOk;

export interface TelegramPresetResolveOptions {
  getStablecoinsCacheResult?: () => Promise<StablecoinsCacheLoadResult>;
}

const PRESET_BY_ID: ReadonlyMap<TelegramPresetId, TelegramPresetDefinition> = new Map(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

const PRESET_ALIAS_TO_ID = (() => {
  const map = new Map<string, TelegramPresetId>();
  for (const definition of TELEGRAM_PRESET_DEFINITIONS) {
    map.set(definition.id, definition.id);
    map.set(definition.id.replace(/top(\d+)$/, "top-$1"), definition.id);
  }
  return map;
})();

const CANONICAL_ORDER_INDEX = new Map(
  WORKER_TRACKED_STABLECOINS.map((stablecoin, index) => [stablecoin.id, index] as const),
);

export function listTelegramPresets(): TelegramPresetDefinition[] {
  return [...TELEGRAM_PRESET_DEFINITIONS];
}

export function resolveTelegramPresetAlias(token: string): TelegramPresetId | null {
  return PRESET_ALIAS_TO_ID.get(token.toLowerCase()) ?? null;
}

function compareStablecoinIdsByMarketCap(
  a: string,
  b: string,
  marketCapsById: ReadonlyMap<string, number>,
): number {
  const aMcap = marketCapsById.get(a) ?? 0;
  const bMcap = marketCapsById.get(b) ?? 0;
  if (bMcap !== aMcap) {
    return bMcap - aMcap;
  }
  return (CANONICAL_ORDER_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (CANONICAL_ORDER_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER);
}

function idsToResolvedCoins(ids: string[]): ResolvedCoin[] {
  return ids.flatMap((id) => {
    const meta = WORKER_TRACKED_META_BY_ID.get(id);
    if (!meta) return [];
    return [{ id: meta.id, symbol: meta.symbol, name: meta.name }];
  });
}

export async function resolveTelegramPresetTargets(
  db: D1Database,
  presetIds: readonly TelegramPresetId[],
  options: TelegramPresetResolveOptions = {},
): Promise<TelegramPresetResolveResult> {
  const cacheResult = options.getStablecoinsCacheResult
    ? await options.getStablecoinsCacheResult()
    : await loadStablecoinsCache(db, { mode: "strict" });
  if (cacheResult.kind !== "ok") {
    return {
      kind: "error",
      reason: "stablecoins-cache-unavailable",
    };
  }

  const marketCapsById = new Map(
    cacheResult.payload.peggedAssets.map((asset) => [asset.id, getCirculatingRaw(asset)] as const),
  );

  const presets: ResolvedTelegramPreset[] = presetIds.flatMap((presetId) => {
    const definition = PRESET_BY_ID.get(presetId);
    if (!definition) return [];

    let stablecoinIds: string[];
    if (definition.kind === "peg-top") {
      stablecoinIds = WORKER_ACTIVE_STABLECOINS
        .filter((stablecoin) => {
          if (definition.pegCurrency != null) {
            return stablecoin.pegCurrency === definition.pegCurrency;
          }
          if (definition.excludePegCurrency != null) {
            return stablecoin.pegCurrency !== definition.excludePegCurrency;
          }
          return true;
        })
        .map((stablecoin) => stablecoin.id)
        .sort((a, b) => compareStablecoinIdsByMarketCap(a, b, marketCapsById))
        .slice(0, definition.topN);
    } else {
      stablecoinIds = WORKER_ACTIVE_STABLECOINS
        .filter((stablecoin) => (marketCapsById.get(stablecoin.id) ?? 0) >= (definition.minMarketCapUsd ?? 0))
        .map((stablecoin) => stablecoin.id)
        .sort((a, b) => compareStablecoinIdsByMarketCap(a, b, marketCapsById));
    }

    return [{
      definition,
      stablecoinIds,
      coins: idsToResolvedCoins(stablecoinIds),
    }];
  });

  return {
    kind: "ok",
    presets,
  };
}
