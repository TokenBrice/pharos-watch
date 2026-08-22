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

const CostLineItemSchema = z.object({
  label: z.string().min(1),
  category: z.enum(["team", "infra"]),
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
