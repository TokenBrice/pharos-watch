import { z } from "zod";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

/** Exact getter quantity and canonical block identity, before any market valuation. */
export const PinnedNativeShareObservationSchema = z.object({
  chain: z.literal("ethereum"),
  contractAddress: z.literal("0x09864f52b035ae22ee739dfa5c748fa080d07bd8"),
  rawShares: z.string().regex(/^[1-9][0-9]{0,77}$/),
  decimals: z.literal(2),
  blockNumber: z.number().int().positive(),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  observedAt: z.number().int().positive(),
}).strict();
export type PinnedNativeShareObservation = z.output<typeof PinnedNativeShareObservationSchema>;

/** A review binds both source cadence and the legal/native class perimeter. No default allowance. */
export const ReserveNavSupplyAdmissionReviewSchema = z.object({
  maxNavSupplySkewSec: z.number().int().positive(),
  reviewedAt: StrictIsoDateSchema,
  evidenceRef: z.string().url(),
  perimeterRef: z.string().url(),
}).strict();
export type ReserveNavSupplyAdmissionReview = z.output<typeof ReserveNavSupplyAdmissionReviewSchema>;

export const RESERVE_NAV_SUPPLY_SCOPE_REASON_VALUES = [
  "class-assets-unavailable",
  "native-share-observation-unavailable",
  "native-share-precision-unsupported",
  "native-share-observation-stale",
  "native-class-temporal-review-unavailable",
  "nav-supply-time-skew",
  "invalid-onchain-valuation",
  "class-assets-supply-divergence",
] as const;
export type ReserveNavSupplyScopeReason = (typeof RESERVE_NAV_SUPPLY_SCOPE_REASON_VALUES)[number];
