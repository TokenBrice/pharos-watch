/**
 * Six chains the funding page can display. Keep in lockstep with
 * `buildExplorerUrl` (shared/lib/explorer.ts); if a chain is added
 * here but explorer.ts has no case, donor list entries on that chain
 * will render without a link.
 */
export type FundingChain =
  | "ethereum"
  | "base"
  | "optimism"
  | "arbitrum"
  | "polygon"
  | "gnosis";

export type CostCategory = "team" | "infra";

export interface CostLineItem {
  label: string;
  category: CostCategory;
  usd_per_month: number;
  note?: string;
}

export interface CostsFile {
  /** UTC unix seconds of the last review. Surfaced in the Monthly costs card details. */
  last_reviewed_at: number;
  items: CostLineItem[];
}

/**
 * One donation row. Written by the funding-update skill or by hand.
 *
 * - `kind: "founder"` rows are excluded from the community lifetime total
 *   and donor list. The public cost-breakdown footer derives the open
 *   monthly funding gap from costs minus community support.
 * - `kind: "pool"` (e.g. Giveth payout contract) counts as community;
 *   `display` should read "via Giveth" rather than the raw contract address.
 * - `kind: "community"` is everything else (default).
 *
 * `usd_at_receipt` is computed once at insertion time — no historical-price
 * pipeline at runtime. Stablecoin donations are priced at $1. ETH and other
 * native / whitelisted assets are priced via the CoinGecko `/coins/{id}/history`
 * endpoint for the transfer's UTC block date, with the skill recording the
 * source in `price_note`.
 */
export interface Donation {
  chain: FundingChain;
  tx_hash: string;
  block_timestamp: number; // UTC unix seconds
  from_address: string; // lowercased
  display: string; // ENS name, custom label, or truncated address
  kind: "founder" | "pool" | "community";
  asset_symbol: string; // 'ETH', 'USDC', 'xDAI', ...
  amount_decimal: number;
  usd_at_receipt: number;
  price_note: string; // 'stablecoin-1-to-1' | 'coingecko-historical-YYYY-MM-DD' | 'manual-<source>'
}

export interface DonationsFile {
  /** UTC unix seconds of the last run of the funding-update skill. */
  last_updated_at: number;
  donations: Donation[];
}
