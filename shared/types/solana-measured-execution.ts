import { z } from "zod";

import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_MAX_COST_BPS,
} from "./measured-execution";
import { validateNativeMeasuredExecutionProfile } from "./native-measured-execution";
import { ExitRouteCapacityPointSchema } from "./exit-route";

export const SOLANA_MEASURED_TARGET_SCHEMA_VERSION = "solana-measured-target-v1" as const;
export const SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION = "solana-measured-execution-v1" as const;
export const SOLANA_MEASURED_MAX_SLOT_WINDOW = 512;
export const SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG = 2_250;
const SOLANA_MEASURED_MAX_CONTEXT_SLOT_LEAD = 250;

const SolanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

const SolanaMeasuredExecutionTokenSchema = z.object({
  address: SolanaAddressSchema,
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(255),
  referencePriceUsd: z.number().finite().positive(),
  referencePriceSource: z.enum(["tracked", "pool-implied"]),
  trackedAssetId: z.string().min(1).optional(),
});
export type SolanaMeasuredExecutionToken = z.infer<typeof SolanaMeasuredExecutionTokenSchema>;

export const SolanaMeasuredExecutionTargetSchema = z.object({
  schemaVersion: z.literal(SOLANA_MEASURED_TARGET_SCHEMA_VERSION),
  targetId: z.string().min(1).max(512),
  stablecoinId: z.string().min(1),
  adapterProfileId: z.enum(["raydium-clmm-trade-api-v1", "orca-whirlpool-jupiter-v1"]),
  protocol: z.enum(["raydium", "orca"]),
  chain: z.literal("solana"),
  poolId: SolanaAddressSchema,
  poolType: z.enum(["raydium-clmm", "orca-whirlpool"]),
  tokenIn: SolanaMeasuredExecutionTokenSchema,
  tokenOut: SolanaMeasuredExecutionTokenSchema,
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
});
export type SolanaMeasuredExecutionTarget = z.infer<typeof SolanaMeasuredExecutionTargetSchema>;

const CommonRouteProofSchema = z.object({
  poolId: SolanaAddressSchema,
  inputMint: SolanaAddressSchema,
  outputMint: SolanaAddressSchema,
  inputAmount: z.string().regex(/^[1-9][0-9]*$/),
  outputAmount: z.string().regex(/^[0-9]+$/),
});

const SolanaMeasuredRaydiumRouteProofSchema = CommonRouteProofSchema.extend({
  provider: z.literal("raydium-trade-api"),
  responseId: z.string().min(1).max(128),
  lastPoolPriceX64: z.string().regex(/^[1-9][0-9]*$/),
  feeAmount: z.string().regex(/^[0-9]+$/).optional(),
  /**
   * A bounded, pool-pinned replay proof. It is optional for historical shadow
   * evidence and required by the activation policy for reviewed on-state
   * Raydium routes.
   */
  stateProof: z
    .object({
      slot: z.number().int().nonnegative(),
      programId: SolanaAddressSchema,
      tokenMint0: SolanaAddressSchema,
      tokenMint1: SolanaAddressSchema,
      liquidity: z.string().regex(/^[1-9][0-9]*$/),
      sqrtPriceX64: z.string().regex(/^[1-9][0-9]*$/),
      feeAmount: z.string().regex(/^[0-9]+$/),
      direction: z.enum(["zero-for-one", "one-for-zero"]),
    })
    .optional(),
});

const SolanaMeasuredOrcaRouteProofSchema = CommonRouteProofSchema.extend({
  provider: z.literal("jupiter-swap-api"),
  // Preserve historical proofs while accepting Jupiter's current label for
  // the same Orca Whirlpool program.
  label: z.enum(["Orca V2", "Whirlpool"]),
  contextSlot: z.number().int().nonnegative(),
});

const SolanaMeasuredRouteProofSchema = z.discriminatedUnion("provider", [
  SolanaMeasuredRaydiumRouteProofSchema,
  SolanaMeasuredOrcaRouteProofSchema,
]);
export type SolanaMeasuredRouteProof = z.infer<typeof SolanaMeasuredRouteProofSchema>;

const SolanaMeasuredExecutionQuotePointProofSchema = z.object({
  amountInRaw: z.string().regex(/^[1-9][0-9]*$/),
  amountOutRaw: z.string().regex(/^[0-9]+$/),
  inputUsd: z.number().finite().positive(),
  outputUsd: z.number().finite().nonnegative(),
  costBps: z.number().finite().nonnegative(),
  passesCostBound: z.boolean(),
  route: SolanaMeasuredRouteProofSchema,
});
export type SolanaMeasuredExecutionQuotePointProof = z.infer<typeof SolanaMeasuredExecutionQuotePointProofSchema>;

export const SolanaMeasuredExecutionProfileSchema = z.object({
  schemaVersion: z.literal(SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION),
  kind: z.literal("measured-executable-depth"),
  targetId: z.string().min(1).max(512),
  targetGenerationId: z.string().min(1).max(128),
  quoteGenerationId: z.string().min(1).max(128),
  adapterProfileId: SolanaMeasuredExecutionTargetSchema.shape.adapterProfileId,
  protocol: SolanaMeasuredExecutionTargetSchema.shape.protocol,
  chain: z.literal("solana"),
  poolId: SolanaAddressSchema,
  poolType: SolanaMeasuredExecutionTargetSchema.shape.poolType,
  tokenIn: SolanaMeasuredExecutionTokenSchema,
  tokenOut: SolanaMeasuredExecutionTokenSchema,
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  slotWindow: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
  }),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  marginalOutputRatio: z.number().finite().nonnegative(),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  quoteProof: z.array(SolanaMeasuredExecutionQuotePointProofSchema).min(1).max(8),
});
export type SolanaMeasuredExecutionProfile = z.infer<typeof SolanaMeasuredExecutionProfileSchema>;

export const SolanaMeasuredExecutionPublicProfileSchema = SolanaMeasuredExecutionProfileSchema.omit({
  quoteProof: true,
});
export type SolanaMeasuredExecutionPublicProfile = z.infer<typeof SolanaMeasuredExecutionPublicProfileSchema>;

export function toSolanaMeasuredExecutionPublicProfile(
  input: SolanaMeasuredExecutionProfile,
): SolanaMeasuredExecutionPublicProfile {
  const parsed = SolanaMeasuredExecutionProfileSchema.parse(input);
  const { quoteProof: _quoteProof, ...profile } = parsed;
  return SolanaMeasuredExecutionPublicProfileSchema.parse(profile);
}

/** Native Solana identifiers are intentionally not lowercased. */
export function buildSolanaMeasuredExecutionTargetId(input: {
  stablecoinId: string;
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"];
  protocol: SolanaMeasuredExecutionTarget["protocol"];
  poolId: string;
  tokenInAddress: string;
  tokenOutAddress: string;
}): string {
  return [
    SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    input.adapterProfileId,
    input.stablecoinId.trim().toLowerCase(),
    "solana",
    input.protocol,
    input.poolId.trim(),
    input.tokenInAddress.trim(),
    input.tokenOutAddress.trim(),
  ].join("|");
}

export type SolanaMeasuredExecutionValidationReason =
  | "invalid-profile"
  | "target-generation-mismatch"
  | "quote-generation-mismatch"
  | "target-snapshot-mismatch"
  | "identity-mismatch"
  | "tracked-input-mismatch"
  | "stale-observation"
  | "future-observation"
  | "observation-before-target"
  | "retained-price-mismatch"
  | "retained-tvl-mismatch"
  | "token-reference-price-mismatch"
  | "quote-price-mismatch"
  | "invalid-capacity-curve"
  | "invalid-quote-proof"
  | "invalid-slot-proof";

export function validateSolanaMeasuredExecutionProfile(input: {
  profile: unknown;
  quotedTarget: SolanaMeasuredExecutionTarget;
  currentTarget: SolanaMeasuredExecutionTarget;
  expectedTargetGenerationId: string;
  expectedQuoteGenerationId: string;
  nowSec: number;
}): SolanaMeasuredExecutionValidationReason[] {
  const parsed = SolanaMeasuredExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return ["invalid-profile"];
  const profile = parsed.data;
  return validateNativeMeasuredExecutionProfile<
    SolanaMeasuredExecutionTarget,
    SolanaMeasuredExecutionQuotePointProof,
    SolanaMeasuredExecutionProfile,
    SolanaMeasuredExecutionValidationReason
  >({
    ...input,
    profile,
    adapter: {
      currentIdentityMatches(candidate, currentTarget) {
        return (
          candidate.targetId === currentTarget.targetId &&
          candidate.adapterProfileId === currentTarget.adapterProfileId &&
          candidate.protocol === currentTarget.protocol &&
          candidate.poolId === currentTarget.poolId &&
          candidate.poolType === currentTarget.poolType &&
          candidate.tokenIn.address === currentTarget.tokenIn.address &&
          candidate.tokenOut.address === currentTarget.tokenOut.address &&
          candidate.tokenIn.symbol === currentTarget.tokenIn.symbol &&
          candidate.tokenOut.symbol === currentTarget.tokenOut.symbol &&
          candidate.tokenIn.decimals === currentTarget.tokenIn.decimals &&
          candidate.tokenOut.decimals === currentTarget.tokenOut.decimals &&
          candidate.tokenIn.trackedAssetId === currentTarget.tokenIn.trackedAssetId &&
          candidate.tokenOut.trackedAssetId === currentTarget.tokenOut.trackedAssetId
        );
      },
      validateProfileProof(candidate, issues) {
        if (
          candidate.slotWindow.after < candidate.slotWindow.before ||
          candidate.slotWindow.after - candidate.slotWindow.before > SOLANA_MEASURED_MAX_SLOT_WINDOW
        ) {
          issues.add("invalid-slot-proof");
        }
      },
      validateQuoteProof({ profile: candidate, point }, issues) {
        const route = point.route;
        if (
          point.amountInRaw !== route.inputAmount ||
          point.amountOutRaw !== route.outputAmount ||
          route.poolId !== candidate.poolId ||
          route.inputMint !== candidate.tokenIn.address ||
          route.outputMint !== candidate.tokenOut.address
        ) {
          issues.add("invalid-quote-proof");
        }

        if (candidate.adapterProfileId === "raydium-clmm-trade-api-v1") {
          if (route.provider !== "raydium-trade-api") {
            issues.add("invalid-quote-proof");
          } else if (route.stateProof) {
            const state = route.stateProof;
            const directionMatches =
              (state.direction === "zero-for-one" &&
                state.tokenMint0 === candidate.tokenIn.address &&
                state.tokenMint1 === candidate.tokenOut.address) ||
              (state.direction === "one-for-zero" &&
                state.tokenMint1 === candidate.tokenIn.address &&
                state.tokenMint0 === candidate.tokenOut.address);
            if (
              !directionMatches ||
              state.slot < candidate.slotWindow.before ||
              state.slot > candidate.slotWindow.after
            ) {
              issues.add("invalid-quote-proof");
            }
          }
        } else if (route.provider !== "jupiter-swap-api") {
          issues.add("invalid-quote-proof");
        } else if (
          route.contextSlot + SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG < candidate.slotWindow.before ||
          route.contextSlot > candidate.slotWindow.after + SOLANA_MEASURED_MAX_CONTEXT_SLOT_LEAD
        ) {
          issues.add("invalid-slot-proof");
        }
      },
      buildTargetId(candidate) {
        return buildSolanaMeasuredExecutionTargetId({
          stablecoinId: candidate.tokenIn.trackedAssetId ?? "",
          adapterProfileId: candidate.adapterProfileId,
          protocol: candidate.protocol,
          poolId: candidate.poolId,
          tokenInAddress: candidate.tokenIn.address,
          tokenOutAddress: candidate.tokenOut.address,
        });
      },
    },
  });
}
