import { z } from "zod";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

export const JLTXX_ETHEREUM_CONTRACT = "0x09864f52b035ae22ee739dfa5c748fa080d07bd8" as const;
export const JLTXX_SOLANA_MINT = "J4cTuCH6frt4AnEmKfMS2k8hsUf7K94PV62sjUJno8Cz" as const;
export const JLTXX_SOLANA_TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as const;
export const JLTXX_NATIVE_SHARE_DECIMALS = 2 as const;

const POSITIVE_RAW_SHARES_RE = /^[1-9][0-9]{0,77}$/;
const PositiveRawSharesSchema = z.string().regex(POSITIVE_RAW_SHARES_RE);

/** Finalized hash-pinned Ethereum share-class leg. */
export const PinnedNativeShareEthereumLegSchema = z.object({
  chain: z.literal("ethereum"),
  contractAddress: z.literal(JLTXX_ETHEREUM_CONTRACT),
  rawShares: PositiveRawSharesSchema,
  decimals: z.literal(JLTXX_NATIVE_SHARE_DECIMALS),
  blockNumber: z.number().int().positive().safe(),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  observedAt: z.number().int().positive().safe(),
}).strict();
export type PinnedNativeShareEthereumLeg = z.output<typeof PinnedNativeShareEthereumLegSchema>;

/** Finalized Token-2022 Solana share-class leg. */
export const PinnedNativeShareSolanaLegSchema = z.object({
  chain: z.literal("solana"),
  contractAddress: z.literal(JLTXX_SOLANA_MINT),
  rawShares: PositiveRawSharesSchema,
  decimals: z.literal(JLTXX_NATIVE_SHARE_DECIMALS),
  slot: z.number().int().positive().safe(),
  programOwner: z.literal(JLTXX_SOLANA_TOKEN_PROGRAM),
  observedAt: z.number().int().positive().safe(),
}).strict();
export type PinnedNativeShareSolanaLeg = z.output<typeof PinnedNativeShareSolanaLegSchema>;

export const PinnedNativeShareLegSchema = z.discriminatedUnion("chain", [
  PinnedNativeShareEthereumLegSchema,
  PinnedNativeShareSolanaLegSchema,
]);
export type PinnedNativeShareLeg = z.output<typeof PinnedNativeShareLegSchema>;

/** Exact aggregate getter quantity and per-leg canonical provenance, before any market valuation. */
export const PinnedNativeShareObservationSchema = z.object({
  rawShares: PositiveRawSharesSchema,
  decimals: z.literal(JLTXX_NATIVE_SHARE_DECIMALS),
  observedAt: z.number().int().positive().safe(),
  legs: z.array(PinnedNativeShareLegSchema).min(1).max(2),
}).strict().superRefine((obs, ctx) => {
  const chains = new Set(obs.legs.map((leg) => leg.chain));
  if (chains.size !== obs.legs.length) {
    ctx.addIssue({
      code: "custom",
      path: ["legs"],
      message: "Pinned native share legs must have unique chains",
    });
  }
  if (!chains.has("ethereum")) {
    ctx.addIssue({
      code: "custom",
      path: ["legs"],
      message: "Pinned native share observation requires the Ethereum leg",
    });
  }
  if (
    obs.legs.length > 0
    && POSITIVE_RAW_SHARES_RE.test(obs.rawShares)
    && obs.legs.every((leg) => POSITIVE_RAW_SHARES_RE.test(leg.rawShares))
  ) {
    const expectedRaw = obs.legs.reduce((sum, leg) => sum + BigInt(leg.rawShares), 0n);
    if (BigInt(obs.rawShares) !== expectedRaw) {
      ctx.addIssue({
        code: "custom",
        path: ["rawShares"],
        message: "Total rawShares must equal the exact BigInt sum of legs[].rawShares",
      });
    }
  }
  if (obs.legs.length > 0) {
    const oldestObservedAt = Math.min(...obs.legs.map((leg) => leg.observedAt));
    if (obs.observedAt !== oldestObservedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "observedAt must equal the oldest leg observedAt",
      });
    }
  }
});
export type PinnedNativeShareObservation = z.output<typeof PinnedNativeShareObservationSchema>;

/** A review binds both source cadence and the legal/native class perimeter. No default allowance. */
export const ReserveNavSupplyAdmissionReviewSchema = z.object({
  maxNavSupplySkewSec: z.number().int().positive(),
  reviewedAt: StrictIsoDateSchema,
  evidenceRef: z.string().url(),
  perimeterRef: z.string().url(),
}).strict();

export type ReserveNavSupplyScopeReason =
  | "class-assets-unavailable"
  | "native-share-observation-unavailable"
  | "native-share-precision-unsupported"
  | "native-share-observation-stale"
  | "native-class-temporal-review-unavailable"
  | "nav-supply-time-skew"
  | "invalid-onchain-valuation"
  | "class-assets-supply-divergence";
