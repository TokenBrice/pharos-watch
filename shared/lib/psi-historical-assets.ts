import type { StablecoinMeta } from "../types";

/** Off-catalog historical assets preserving authoritative PSI/monitoring continuity.
 * May appear in public alerts, but not tracked listings or DDR first-seen eligibility. */
export const PSI_HISTORICAL_ASSETS: readonly StablecoinMeta[] = [
  // UST (id=3 on DefiLlama, renamed TerraClassicUSD/USTC post-collapse)
  { id: "ust-terra", llamaId: "3", detailProvider: "defillama", name: "TerraUSD", symbol: "UST", flags: { backing: "algorithmic", pegCurrency: "USD", governance: "decentralized", yieldBearing: false, rwa: false, navToken: false }, geckoId: "terrausd" },
  // IRON Finance (no DL stablecoin id — use geckoId for price backfill via DL coins API)
  // Supply history needs a manual DB insert (~$800M peak, Jun 2021) since neither DL nor CG has mcap data
  { id: "iron-iron-finance", detailProvider: "coingecko", name: "IRON", symbol: "IRON", flags: { backing: "algorithmic", pegCurrency: "USD", governance: "decentralized", yieldBearing: false, rwa: false, navToken: false }, geckoId: "iron-stablecoin" },
];

export const PSI_HISTORICAL_IDS: ReadonlySet<string> = new Set(PSI_HISTORICAL_ASSETS.map((s) => s.id));
export const PSI_HISTORICAL_META_BY_ID: ReadonlyMap<string, StablecoinMeta> = new Map(
  PSI_HISTORICAL_ASSETS.map((s) => [s.id, s]),
);
