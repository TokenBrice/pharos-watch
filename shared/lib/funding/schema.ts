import { z } from "zod";
import { CHAIN_META } from "../../types/chain-identity";

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
const MonthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
// Self-hosted square artwork only (docs/funding-page.md#data-model); never a remote URL.
const MediaArtPathSchema = z.string().regex(/^\/media\/[a-z0-9-]+\.(svg|png|webp)$/, "must be a /media/ svg, png or webp path");

const InKindSponsorSchema = z.object({
  logo: MediaArtPathSchema,
  url: z.string().regex(/^https:\/\/\S+$/, "sponsor url must be https"),
  blurb: z.string().min(1),
  announcement: z.string().regex(/^\/\S*$/, "announcement must be a site path").optional(),
}).strict();

const CostLineItemSchema = z.object({
  label: z.string().min(1),
  category: CostCategorySchema,
  usd_per_month: NonNegativeFiniteSchema,
  note: z.string().optional(),
  /** Square vendor mark or team avatar, rendered in a circle beside the line. */
  mark: MediaArtPathSchema.optional(),
  /** In-kind sponsorship acknowledgment: a disclosure, never revenue or an imputed cost. */
  sponsor: InKindSponsorSchema.optional(),
}).strict().refine((item) => item.sponsor == null || item.usd_per_month === 0, {
  message: "an in-kind sponsored line costs $0",
  path: ["usd_per_month"],
});

/** The monthly cost published for a closed month, so its coverage keeps its own basis. */
const MonthlyCostTotalSchema = z.object({
  month: MonthKeySchema,
  usd: NonNegativeFiniteSchema,
}).strict();

/** Exceptional one-time spend, disclosed outside the recurring total. */
const OneTimeCostSchema = z.object({
  label: z.string().min(1),
  usd: NonNegativeFiniteSchema,
  paid_by: z.enum(["founder"]),
}).strict();

export const CostsFileSchema = z.object({
  last_reviewed_at: UnixSecondsSchema,
  items: z.array(CostLineItemSchema),
  monthly_totals: z.array(MonthlyCostTotalSchema).superRefine((rows, ctx) => {
    rows.forEach((row, index) => {
      if (index > 0 && row.month <= rows[index - 1].month) {
        ctx.addIssue({ code: "custom", path: [index, "month"], message: "monthly_totals must be strictly ascending" });
      }
    });
  }),
  one_time: z.array(OneTimeCostSchema),
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
export type CostsFile = z.infer<typeof CostsFileSchema>;
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
 * pipeline at runtime. USD stablecoin donations are priced at $1; non-USD fiat
 * stablecoins (EURC, ZCHF, XSGD, ...) at the receipt-date ECB reference rate
 * for their peg currency. ETH and other native / whitelisted
 * assets are priced via the CoinGecko `/coins/{id}/history` endpoint for the
 * transfer's UTC block date, with the skill recording the source in `price_note`.
 */
export type Donation = z.infer<typeof DonationSchema>;
