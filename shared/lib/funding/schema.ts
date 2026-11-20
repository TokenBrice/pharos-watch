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
const TransferIndexPattern = /^(?:0|[1-9][0-9]*)$/;
const FundingTransferDiscriminatorSchema = z.string().refine((value) => {
  if (value === "native") return true;
  if (value.startsWith("log:")) return TransferIndexPattern.test(value.slice(4));
  return value.startsWith("trace:") && value.slice(6).split(".").every((index) => TransferIndexPattern.test(index));
}, "expected log:<index>, native, or trace:<path>");

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
  transfer_discriminator: FundingTransferDiscriminatorSchema.optional(),
  /** A verified discriminator for the original row in the transaction-keyed ledger. */
  legacy_credit: z.literal(true).optional(),
  block_timestamp: UnixSecondsSchema,
  // Lowercase is the ledger invariant; donor-key eligibility compares on it.
  from_address: z.string().regex(/^0x[0-9a-f]{40}$/, "from_address must be a lowercase 0x address"),
  display: z.string().min(1),
  kind: z.enum(["founder", "pool", "community", "revenue"]),
  asset_symbol: z.string().min(1),
  // Transferred ERC-20 contract, lowercase; null for native assets (ETH, POL/MATIC, xDAI).
  token_address: z.string().regex(/^0x[0-9a-f]{40}$/, "token_address must be a lowercase 0x address").nullable(),
  amount_decimal: NonNegativeFiniteSchema,
  usd_at_receipt: NonNegativeFiniteSchema,
  price_note: z.string().min(1),
}).strict().superRefine((row, ctx) => {
  const discriminator = row.transfer_discriminator;
  if (discriminator === undefined) {
    if (row.legacy_credit) ctx.addIssue({
      code: "custom", path: ["legacy_credit"], message: "legacy_credit requires a verified transfer discriminator",
    });
    return;
  }
  if (!/^0x[0-9a-f]{64}$/i.test(row.tx_hash)) ctx.addIssue({
    code: "custom", path: ["tx_hash"], message: "transfer identity requires a full transaction hash",
  });
  if (discriminator.startsWith("log:") !== (row.token_address !== null)) ctx.addIssue({
    code: "custom", path: ["transfer_discriminator"], message: "ERC-20 receipts use a log index and native receipts use a trace or native identity",
  });
});

export function fundingTransferId(chain: string, txHash: string, discriminator?: string): string {
  const transaction = `${chain}:${txHash.toLowerCase()}`;
  return discriminator === undefined ? transaction : `${transaction}:${discriminator}`;
}

const LedgerSchema = z.object({
  last_updated_at: UnixSecondsSchema,
  donations: z.array(DonationSchema),
}).strict();

/** Use after the claims Worker can atomically record transfer-level credits. */
export const TransferDonationsFileSchema = LedgerSchema.superRefine(({ donations }, ctx) => {
  const seen = new Set<string>();
  const legacy = new Set<string>();
  const unresolved = new Set<string>();
  donations.forEach((row, index) => {
    const transaction = fundingTransferId(row.chain, row.tx_hash);
    const transfer = fundingTransferId(row.chain, row.tx_hash, row.transfer_discriminator);
    const representsLegacy = row.transfer_discriminator === undefined || row.legacy_credit === true;
    if (seen.has(transfer) || (representsLegacy && legacy.has(transaction))) {
      ctx.addIssue({ code: "custom", path: ["donations", index, "tx_hash"], message: `duplicate donation ${transfer}` });
    }
    seen.add(transfer);
    if (representsLegacy) legacy.add(transaction);
    if (row.transfer_discriminator === undefined) unresolved.add(transaction);
  });
  donations.forEach((row, index) => {
    if (row.transfer_discriminator !== undefined && unresolved.has(fundingTransferId(row.chain, row.tx_hash))) {
      ctx.addIssue({
        code: "custom", path: ["donations", index, "transfer_discriminator"],
        message: "resolve the original ledger row's discriminator before accepting another receipt from this transaction",
      });
    }
  });
});

/** Compare the proposed ledger to the published version before embedding it in Pages and the Worker. */
export function assertDonationCreditContinuity(previous: DonationsFile, next: DonationsFile): void {
  const byTransaction = new Map<string, Donation[]>();
  for (const row of next.donations) {
    const key = fundingTransferId(row.chain, row.tx_hash);
    const rows = byTransaction.get(key);
    if (rows) rows.push(row);
    else byTransaction.set(key, [row]);
  }
  for (const old of previous.donations) {
    if (old.transfer_discriminator !== undefined && !old.legacy_credit) continue;
    const key = fundingTransferId(old.chain, old.tx_hash);
    const rows = byTransaction.get(key);
    if (!rows?.some((row) => row.transfer_discriminator !== undefined)) continue;
    const alias = rows.find((row) => row.legacy_credit);
    if (!alias || alias.from_address !== old.from_address || alias.token_address !== old.token_address ||
        alias.amount_decimal !== old.amount_decimal || alias.block_timestamp !== old.block_timestamp ||
        (old.transfer_discriminator !== undefined && old.transfer_discriminator !== alias.transfer_discriminator)) {
      throw new Error(`Preserve legacy_credit on the exact published transfer for ${key}`);
    }
  }
}

// Keep the transaction fence until all claims writes use the new credit table.
export const DonationsFileSchema = LedgerSchema.superRefine(({ donations }, ctx) => {
  const seen = new Set<string>();
  donations.forEach((row, index) => {
    const key = fundingTransferId(row.chain, row.tx_hash);
    if (row.transfer_discriminator !== undefined) ctx.addIssue({
      code: "custom", path: ["donations", index, "transfer_discriminator"],
      message: "transfer-level funding rows require transfer-level credits",
    });
    if (seen.has(key)) ctx.addIssue({
      code: "custom", path: ["donations", index, "tx_hash"], message: `duplicate donation ${key}`,
    });
    seen.add(key);
  });
});

export type FundingChain = z.infer<typeof FundingChainSchema>;
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
 * - `kind: "revenue"` is a commercial partner-API-key payment: revenue, not a
 *   donation. It never counts in community totals, donor counts, the supporter
 *   table or supporter-key eligibility; the page shows its lifetime total as a
 *   separate API revenue line.
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
