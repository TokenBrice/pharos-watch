import searchableCoinsAsset from "../data/stablecoins/coins.telegram-mini-app.generated.json";
import { TELEGRAM_PRESET_DEFINITIONS } from "./telegram-presets";

export interface TelegramMiniAppCatalogCoin {
  stablecoinId: string;
  symbol: string;
  name: string;
  peg: string;
  status: string;
}

export interface TelegramMiniAppCatalogPreset {
  id: string;
  label: string;
  description: string;
}

export interface TelegramMiniAppCatalog {
  recommendedPresets: readonly TelegramMiniAppCatalogPreset[];
  searchableCoins: readonly TelegramMiniAppCatalogCoin[];
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const recommendedPresets = TELEGRAM_PRESET_DEFINITIONS.map((preset) =>
  Object.freeze({
    id: preset.id,
    label: preset.label,
    description: preset.description,
  }),
);

const searchableCoins = (searchableCoinsAsset as TelegramMiniAppCatalogCoin[]).map((coin) =>
  Object.freeze({ ...coin }),
);

/**
 * Immutable catalog bundled into the static Mini App chunk. Next.js fingerprints
 * that chunk, so the browser and Telegram WebView can cache these bytes across
 * every session and mutation instead of receiving them from the Worker.
 */
export const TELEGRAM_MINI_APP_CATALOG: TelegramMiniAppCatalog = Object.freeze({
  recommendedPresets: Object.freeze(recommendedPresets),
  searchableCoins: Object.freeze(searchableCoins),
});

/** Content-derived version shared by the Worker and the static client build. */
export const TELEGRAM_MINI_APP_CATALOG_VERSION = `catalog-v1-${fnv1a32(JSON.stringify(TELEGRAM_MINI_APP_CATALOG))}`;
