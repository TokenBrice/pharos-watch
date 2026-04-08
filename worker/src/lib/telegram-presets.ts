import { getCirculatingRaw } from "@shared/lib/supply";
import {
  ACTIVE_STABLECOINS,
  TRACKED_STABLECOINS,
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins";
import { loadStablecoinsCache } from "./stablecoins-cache";

/** Matches the ResolvedCoin shape from telegram-alerts.ts — duplicated here to avoid a circular import. */
interface ResolvedCoin { id: string; symbol: string; name: string }

export type TelegramPresetId =
  | "usd-top10"
  | "usd-top25"
  | "usd-top50"
  | "eur-top10"
  | "gold-top5"
  | "mcap-ge-1b"
  | "mcap-ge-100m";

export interface TelegramPresetDefinition {
  id: TelegramPresetId;
  label: string;
  description: string;
  category: "peg-leaders" | "market-cap";
  kind: "peg-top" | "market-cap";
  pegCurrency?: "USD" | "EUR" | "GOLD";
  topN?: number;
  minMarketCapUsd?: number;
}

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

const TELEGRAM_PRESET_DEFINITIONS: TelegramPresetDefinition[] = [
  {
    id: "usd-top10",
    label: "USD Top 10",
    description: "Top 10 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 10,
  },
  {
    id: "usd-top25",
    label: "USD Top 25",
    description: "Top 25 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 25,
  },
  {
    id: "usd-top50",
    label: "USD Top 50",
    description: "Top 50 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 50,
  },
  {
    id: "eur-top10",
    label: "EUR Top 10",
    description: "Top EUR stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "EUR",
    topN: 10,
  },
  {
    id: "gold-top5",
    label: "Gold Top 5",
    description: "Top gold-pegged stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "GOLD",
    topN: 5,
  },
  {
    id: "mcap-ge-1b",
    label: "Market Cap >= $1B",
    description: "Tracked stablecoins with current market cap at or above $1B.",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 1_000_000_000,
  },
  {
    id: "mcap-ge-100m",
    label: "Market Cap >= $100M",
    description: "Tracked stablecoins with current market cap at or above $100M.",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 100_000_000,
  },
];

const PRESET_BY_ID = new Map(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

const CANONICAL_ORDER_INDEX = new Map(
  TRACKED_STABLECOINS.map((stablecoin, index) => [stablecoin.id, index] as const),
);

export function listTelegramPresets(): TelegramPresetDefinition[] {
  return TELEGRAM_PRESET_DEFINITIONS;
}

export function isTelegramPresetAlias(token: string): token is TelegramPresetId {
  return PRESET_BY_ID.has(token.toLowerCase() as TelegramPresetId);
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
    const meta = TRACKED_META_BY_ID.get(id);
    if (!meta) return [];
    return [{ id: meta.id, symbol: meta.symbol, name: meta.name }];
  });
}

export async function resolveTelegramPresetTargets(
  db: D1Database,
  presetIds: readonly TelegramPresetId[],
): Promise<TelegramPresetResolveResult> {
  const cacheResult = await loadStablecoinsCache(db, { mode: "strict" });
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
      stablecoinIds = ACTIVE_STABLECOINS
        .filter((stablecoin) => stablecoin.flags.pegCurrency === definition.pegCurrency)
        .map((stablecoin) => stablecoin.id)
        .sort((a, b) => compareStablecoinIdsByMarketCap(a, b, marketCapsById))
        .slice(0, definition.topN);
    } else {
      stablecoinIds = ACTIVE_STABLECOINS
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
