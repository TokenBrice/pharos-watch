import { z } from "zod";
import { CHAIN_META } from "../chains";

const FUNDING_CHAIN_VALUES = [
  "ethereum",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "gnosis",
] as const;

const UnixSecondsSchema = z.number().finite().int().min(946_684_800).max(4_102_444_800);
const NonNegativeFiniteSchema = z.number().finite().nonnegative();

const FundingChainSchema = z.enum(FUNDING_CHAIN_VALUES).refine(
  (chain) => Object.prototype.hasOwnProperty.call(CHAIN_META, chain),
  "Funding chain is not registered in shared/lib/chains",
);

const CostCategorySchema = z.enum(["team", "infra"]);

const CostLineItemSchema = z.object({
  label: z.string().min(1),
  category: CostCategorySchema,
  usd_per_month: NonNegativeFiniteSchema,
  note: z.string().optional(),
}).strict();

export const CostsFileSchema = z.object({
  last_reviewed_at: UnixSecondsSchema,
  items: z.array(CostLineItemSchema),
}).strict();

export const DonationSchema = z.object({
  chain: FundingChainSchema,
  tx_hash: z.string().min(1),
  block_timestamp: UnixSecondsSchema,
  from_address: z.string().min(1),
  display: z.string().min(1),
  kind: z.enum(["founder", "pool", "community"]),
  asset_symbol: z.string().min(1),
  amount_decimal: NonNegativeFiniteSchema,
  usd_at_receipt: NonNegativeFiniteSchema,
  price_note: z.string().min(1),
}).strict();

export const DonationsFileSchema = z.object({
  last_updated_at: UnixSecondsSchema,
  donations: z.array(DonationSchema),
}).strict();

export type FundingChain = z.infer<typeof FundingChainSchema>;
export type CostCategory = z.infer<typeof CostCategorySchema>;
export type CostLineItem = z.infer<typeof CostLineItemSchema>;

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
export type Donation = z.infer<typeof DonationSchema>;
