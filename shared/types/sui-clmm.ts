import { z } from "zod";

export const SUI_CLMM_SHADOW_HISTORY_LIMIT = 8;
export const SUI_CLMM_SHADOW_PACKET_MAX_BYTES = 256 * 1024;
const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const SignedString = z.string().regex(/^-?(0|[1-9][0-9]*)$/).max(40);
const ObjectId = z.string().regex(/^0x[a-f0-9]{64}$/);
const CoinType = z.string().regex(/^0x[a-f0-9]{64}::[A-Za-z_][A-Za-z_0-9]*::[A-Za-z_][A-Za-z_0-9]*$/);
const Digest = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const SuiClmmShadowSampleSchema = z.object({
  generationId: z.string().min(1).max(80),
  observedAtSec: z.number().int().positive(),
  stablecoinId: z.string().min(1).max(100),
  profileId: z.enum(["cetus-clmm-exact-v1", "bluefin-spot-clmm-exact-v1"]),
  modelVersion: z.literal("sui-clmm-q64-v1"),
  scoreEligible: z.literal(false),
  checkpointBoundInspection: z.literal(false),
  checkpoint: UintString,
  checkpointDigest: Digest,
  checkpointTimestampMs: z.number().int().positive(),
  poolId: ObjectId,
  coinA: CoinType,
  coinB: CoinType,
  coinTypeIn: CoinType,
  inputDecimals: z.number().int().min(0).max(18),
  inputPriceUsd: z.number().finite().positive(),
  quotePackage: ObjectId,
  sqrtPrice: UintString,
  currentTick: z.number().int().min(-443637).max(443636),
  liquidity: UintString,
  tickSpacing: z.number().int().positive().max(65535),
  feePips: z.number().int().min(0).max(999999),
  protocolFeeRate: z.number().int().nonnegative().max(1000000),
  tickCensusComplete: z.literal(true),
  ticks: z.array(z.object({
    index: z.number().int().min(-443636).max(443636), sqrtPrice: UintString,
    liquidityGross: UintString, liquidityNet: SignedString,
  })).max(256),
  references: z.array(z.object({
    objectId: ObjectId, version: UintString, digest: Digest,
    transaction: Digest, transactionCheckpoint: UintString,
  })).min(1).max(514),
  independentCheck: z.enum(["stationary-object-set", "failed"]),
  independentCheckReason: z.string().max(180).nullable(),
  quotes: z.array(z.object({
    notionalUsd: z.number().finite().positive(), amountIn: UintString,
    amountOut: UintString.nullable(), feeAmount: UintString.nullable(),
    protocolFeeAmount: UintString.nullable(), sqrtPriceAfter: UintString.nullable(),
    crossedTicks: z.number().int().nonnegative().nullable(),
    reason: z.string().max(180).nullable(), independentAgreement: z.boolean().nullable(),
  })).min(1).max(5),
});
export type SuiClmmShadowSample = z.infer<typeof SuiClmmShadowSampleSchema>;
export const SuiClmmShadowHistorySchema = z.object({
  schemaVersion: z.literal("sui-clmm-shadow-v1"),
  samples: z.array(SuiClmmShadowSampleSchema).max(SUI_CLMM_SHADOW_HISTORY_LIMIT),
});
export type SuiClmmShadowHistory = z.infer<typeof SuiClmmShadowHistorySchema>;
