import { z } from "zod";

/** Operational evidence only; never price coverage, recovery or duration input. */
export const DepegDeadBandReceiptSchema = z.object({
  eventId: z.number().int().positive(),
  stablecoinId: z.string().min(1),
  evidenceKind: z.literal("dex-aggregate"),
  evaluatedAt: z.number().positive(),
  price: z.number().positive(),
  deviationBps: z.number(),
  publishedAt: z.number().positive(),
  aggregateObservedAt: z.number().positive(),
  pricedTvlUsd: z.number().nonnegative(),
  contributorCount: z.number().int().nonnegative(),
  contributors: z.array(z.object({
    family: z.string().min(1),
    protocol: z.string().min(1),
    chain: z.string().min(1),
    price: z.number().positive(),
    deviationBps: z.number(),
    tvlUsd: z.number().nonnegative(),
    observedAt: z.number().positive(),
    aggregateObservedAt: z.number().positive(),
  })).min(2),
}).refine((receipt) => receipt.contributorCount === receipt.contributors.length);

export type DepegDeadBandReceipt = z.infer<typeof DepegDeadBandReceiptSchema>;
