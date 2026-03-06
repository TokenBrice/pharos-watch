import type { StablecoinMeta } from "../types";

/** Stablecoins no longer actively displayed but still included in PSI computation
 *  for historical accuracy. Must have a valid DefiLlama or CoinGecko ID. */
export const SHADOW_STABLECOINS: StablecoinMeta[] = [
  // UST (id=3 on DefiLlama, renamed TerraClassicUSD/USTC post-collapse)
  { id: "ust-terra", llamaId: "3", detailProvider: "defillama", name: "TerraUSD", symbol: "UST", flags: { backing: "algorithmic", pegCurrency: "USD", governance: "decentralized", yieldBearing: false, rwa: false, navToken: false }, geckoId: "terrausd" },
  // IRON Finance (no DL stablecoin id — use geckoId for price backfill via DL coins API)
  // Supply history needs a manual DB insert (~$800M peak, Jun 2021) since neither DL nor CG has mcap data
  { id: "iron-iron-finance", detailProvider: "coingecko", name: "IRON", symbol: "IRON", flags: { backing: "algorithmic", pegCurrency: "USD", governance: "decentralized", yieldBearing: false, rwa: false, navToken: false }, geckoId: "iron-stablecoin" },
];

export const SHADOW_IDS = new Set(SHADOW_STABLECOINS.map((s) => s.id));
export const SHADOW_META_BY_ID = new Map(SHADOW_STABLECOINS.map((s) => [s.id, s]));
