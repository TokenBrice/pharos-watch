import searchableCoinsAsset from "../data/stablecoins/coins.telegram-mini-app.generated.json";
import { fnv1a32Hex } from "./fnv1a";
import { TELEGRAM_PRESET_DEFINITIONS } from "./telegram-presets";

export interface TelegramMiniAppCatalogCoin {
  stablecoinId: string;
  symbol: string;
  name: string;
  peg: string;
  /** NAV tokens only: the site's hero peg label ("USDe NAV"), instead of a "{CODE} peg" subtitle. */
  pegLabel?: string;
  status: string;
  /** 1-based position in the curated canonical market-cap order; a sort key, not a published statistic. */
  rank: number;
  /** Wrapped, savings, or vault variant of another coin (`variantOf`); standalone yield-bearing coins stay in the base list. */
  variant: boolean;
  /** True when the coin is yield-bearing (`flags.yieldBearing`). */
  yieldBearing: boolean;
  /** True when a non-suspended live reserve feed adapter is configured. */
  liveReserves: boolean;
  /** True when the coin is indexed by the live issuer freeze/blacklist tracker. */
  freezeTracked: boolean;
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

/**
 * Deterministic semantic compatibility hash over coin eligibility, identity,
 * capability flags, and preset IDs (independent of market-cap `rank` order or
 * display copy). Routine rank/copy updates roll silently with Pages assets
 * without forcing `409 catalog-version-mismatch` interrupts.
 */
export function computeTelegramMiniAppCatalogVersion(catalog: TelegramMiniAppCatalog): string {
  const rows = [...catalog.searchableCoins]
    .sort((a, b) => (a.stablecoinId < b.stablecoinId ? -1 : a.stablecoinId > b.stablecoinId ? 1 : 0))
    .map((coin) => [
      coin.stablecoinId,
      coin.symbol,
      coin.status,
      coin.variant === true,
      coin.yieldBearing === true,
      coin.liveReserves === true,
      coin.freezeTracked === true,
    ]);
  const sortedPresetIds = [...catalog.recommendedPresets.map((preset) => preset.id)].sort();
  return `catalog-v3-${fnv1a32Hex(JSON.stringify([3, rows, sortedPresetIds]))}`;
}

/** Content-derived semantic compatibility version shared by the Worker and the static client build. */
export const TELEGRAM_MINI_APP_CATALOG_VERSION = computeTelegramMiniAppCatalogVersion(TELEGRAM_MINI_APP_CATALOG);
