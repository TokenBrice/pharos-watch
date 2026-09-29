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
  // Lowercase is the ledger invariant; donor-key eligibility compares on it.
  from_address: z.string().regex(/^0x[0-9a-f]{40}$/, "from_address must be a lowercase 0x address"),
  display: z.string().min(1),
  kind: z.enum(["founder", "pool", "community"]),
  asset_symbol: z.string().min(1),
  // Transferred ERC-20 contract, lowercase; null for native assets (ETH, POL/MATIC, xDAI).
  token_address: z.string().regex(/^0x[0-9a-f]{40}$/, "token_address must be a lowercase 0x address").nullable(),
  amount_decimal: NonNegativeFiniteSchema,
  usd_at_receipt: NonNegativeFiniteSchema,
  price_note: z.string().min(1),
}).strict();

export const DonationsFileSchema = z.object({
  last_updated_at: UnixSecondsSchema,
  donations: z.array(DonationSchema).superRefine((rows, ctx) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const key = `${row.chain}:${row.tx_hash.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: [index, "tx_hash"], message: `duplicate donation ${key}` });
      }
      seen.add(key);
    });
  }),
}).strict();

export type FundingChain = z.infer<typeof FundingChainSchema>;
export type CostCategory = z.infer<typeof CostCategorySchema>;
export type CostLineItem = z.infer<typeof CostLineItemSchema>;
export type DonationsFile = z.infer<typeof DonationsFileSchema>;

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
 * `asset_symbol` is display-only. `token_address` is the transferred ERC-20
 * contract (lowercase) or null for a native asset; donor-key eligibility
 * identifies a qualifying stablecoin by `(chain, token_address)` only, because
 * other tokens reuse the same tickers. The schema does not check the reviewed
 * list, so one unreviewed contract never fails the whole ledger.
 *
 * `usd_at_receipt` is computed once at insertion time — no historical-price
 * pipeline at runtime. USD stablecoin donations are priced at $1; EURC at the
 * receipt-date ECB EUR/USD reference rate. ETH and other native / whitelisted
 * assets are priced via the CoinGecko `/coins/{id}/history` endpoint for the
 * transfer's UTC block date, with the skill recording the source in `price_note`.
 */
export type Donation = z.infer<typeof DonationSchema>;
