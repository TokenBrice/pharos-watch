import type { PegCurrency } from "@shared/types";

export type StablecoinRemovalReason = "no-live-data" | "no-issued-token" | "wound-down" | "catalog-review";

export const STABLECOIN_REMOVAL_REASON_LABELS: Record<StablecoinRemovalReason, string> = {
  "no-live-data": "No dependable price or supply source",
  "no-issued-token": "No live issued token",
  "wound-down": "Wound down",
  "catalog-review": "Removed in a catalog review",
};

export interface RemovedStablecoin {
  /** Retired registry ID; its old `/stablecoin/<id>/` URL redirects (see `public/_redirects`). */
  id: string;
  name: string;
  symbol: string;
  pegCurrency: PegCurrency;
  /** UTC date of the commit that removed the registry record. */
  removedAt: string;
  reason: StablecoinRemovalReason;
}

/**
 * Coins once tracked and later removed from the registry, from the removal
 * commits' own rationale. Old profile URLs 301 to the coin's peg hub when that
 * hub is built, otherwise to `/coverage/`, where this list is rendered.
 */
export const REMOVED_STABLECOINS: readonly RemovedStablecoin[] = [
  { id: "xai-silo-finance", name: "XAI Silo Finance", symbol: "XAI", pegCurrency: "USD", removedAt: "2026-07-28", reason: "wound-down" },
  { id: "krwo-gimswap", name: "KRWO", symbol: "KRWO", pegCurrency: "KRW", removedAt: "2026-07-19", reason: "no-live-data" },
  { id: "mmxn-moneta-digital", name: "Moneta Digital", symbol: "MMXN", pegCurrency: "MXN", removedAt: "2026-07-19", reason: "no-issued-token" },
  { id: "mnee-mnee", name: "MNEE USD", symbol: "MNEE", pegCurrency: "USD", removedAt: "2026-07-19", reason: "no-live-data" },
  { id: "phpm-mento", name: "Mento Philippine Peso", symbol: "PHPm", pegCurrency: "PHP", removedAt: "2026-07-19", reason: "no-live-data" },
  { id: "usd-nubank", name: "Nubank USD Stablecoin", symbol: "USD-NU", pegCurrency: "USD", removedAt: "2026-07-19", reason: "no-issued-token" },
  { id: "usp-pareto-credit", name: "Pareto USP", symbol: "USP", pegCurrency: "USD", removedAt: "2026-07-19", reason: "no-live-data" },
  { id: "veur-vnx", name: "VNX EURO", symbol: "VEUR", pegCurrency: "EUR", removedAt: "2026-07-19", reason: "no-live-data" },
  { id: "eura-angle", name: "EURA", symbol: "EURA", pegCurrency: "EUR", removedAt: "2026-05-12", reason: "wound-down" },
  { id: "phpc-coins-ph", name: "PHPC Stablecoin", symbol: "PHPC", pegCurrency: "PHP", removedAt: "2026-05-12", reason: "no-live-data" },
  { id: "pusd-pleasing", name: "Pleasing USD", symbol: "PUSD", pegCurrency: "USD", removedAt: "2026-05-12", reason: "no-live-data" },
  { id: "usdw-wisdomtree", name: "WisdomTree Dollar Token", symbol: "USDW", pegCurrency: "USD", removedAt: "2026-05-12", reason: "no-live-data" },
  { id: "wstbt-matrixdock", name: "Wrapped Matrixdock STBT", symbol: "wSTBT", pegCurrency: "USD", removedAt: "2026-05-12", reason: "no-live-data" },
  { id: "shyusd-hylo", name: "Staked hyUSD", symbol: "shyUSD", pegCurrency: "USD", removedAt: "2026-05-11", reason: "no-live-data" },
  { id: "syusd-lucidly", name: "Stable Yield USD", symbol: "syUSD", pegCurrency: "USD", removedAt: "2026-05-11", reason: "no-live-data" },
  { id: "usd-dinari", name: "Dinari USD+", symbol: "USD+", pegCurrency: "USD", removedAt: "2026-03-10", reason: "catalog-review" },
];
