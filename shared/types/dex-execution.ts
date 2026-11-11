import { z } from "zod";
import { DexMeasuredExecutionValidationReasonSchema } from "./measured-execution";

export const DexAmmExecutionTokenSchema = z.object({
  address: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
  balance: z.number().finite().positive(),
  referencePriceUsd: z.number().finite().positive(),
  referencePriceSource: z.enum(["source-token-usd", "tracked-market", "peg-reference", "pool-implied"]),
  referencePriceSourceId: z.string().min(1).optional(),
  referencePriceObservedAt: z.number().int().positive().optional(),
  trackedAssetId: z.string().min(1).optional(),
  weight: z.number().finite().positive().max(1).optional(),
});
export type DexAmmExecutionToken = z.infer<typeof DexAmmExecutionTokenSchema>;

export const DexAmmExecutionModelSchema = z
  .object({
    source: z.enum(["raydium", "uniswap-v2", "pancakeswap-v2", "solidly-v2", "balancer", "curve"]),
    invariant: z.enum(["constant-product", "weighted-constant-mean", "stableswap", "solidly-stable"]),
    trackedTokenIndex: z.number().int().nonnegative(),
    feeRate: z.number().finite().min(0).lt(1),
    /** StableSwap amplification coefficient A (plain paper convention, not A*n^n). */
    amplification: z.number().finite().positive().optional(),
    tokens: z.array(DexAmmExecutionTokenSchema).min(2).max(8),
    capture: z.object({
      blockNumber: z.number().int().positive(),
      blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      blockTimestamp: z.number().int().positive(),
      sourceGenerationId: z.string().min(1),
    }).optional(),
    solidlyState: z.object({
      variant: z.enum(["aerodrome", "velodrome"]),
      stable: z.literal(true),
      reserve0: z.string().max(78).regex(/^[1-9][0-9]*$/),
      reserve1: z.string().max(78).regex(/^[1-9][0-9]*$/),
      fee: z.number().int().nonnegative().lt(10_000),
      blockNumber: z.number().int().positive(),
      blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      blockTimestamp: z.number().int().positive().optional(),
      sourceGenerationId: z.string().min(1).optional(),
      factoryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      poolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      verifiedQuoteCount: z.number().int().positive(),
      quoteChecks: z.array(z.object({
        tokenInIndex: z.number().int().min(0).max(1),
        amountIn: z.string().max(78).regex(/^[1-9][0-9]*$/),
        amountOut: z.string().max(78).regex(/^[0-9]+$/),
      })).min(1).max(32),
      capacityChecks: z.array(z.object({
        requestedNotionalUsd: z.number().finite().positive(),
        executableUsd: z.number().finite().nonnegative(),
        selectedAmountIn: z.string().max(78).regex(/^[0-9]+$/),
        selectedAmountOut: z.string().max(78).regex(/^[0-9]+$/),
        rejectedAmountIn: z.string().max(78).regex(/^[1-9][0-9]*$/).optional(),
        rejectedAmountOut: z.string().max(78).regex(/^[0-9]+$/).optional(),
      })).min(1).max(4).optional(),
    }).optional(),
  })
  .superRefine((model, ctx) => {
    if (model.trackedTokenIndex >= model.tokens.length) {
      ctx.addIssue({ code: "custom", path: ["trackedTokenIndex"], message: "tracked token index is out of range" });
    }
    if (model.invariant !== "stableswap" && model.amplification !== undefined) {
      ctx.addIssue({ code: "custom", path: ["amplification"], message: "amplification is a stableswap parameter" });
    }
    if (model.source === "solidly-v2" || model.invariant === "solidly-stable" || model.solidlyState) {
      if (model.source !== "solidly-v2" || !model.solidlyState || model.tokens.length !== 2 ||
        model.invariant !== "solidly-stable" || model.solidlyState.stable !== true ||
        model.feeRate !== model.solidlyState.fee / 10_000) {
        ctx.addIssue({ code: "custom", path: ["solidlyState"], message: "invalid exact Solidly state" });
      }
      return;
    }
    if (model.invariant === "constant-product") {
      if (
        !["raydium", "uniswap-v2", "pancakeswap-v2"].includes(model.source) ||
        model.tokens.length !== 2
      ) {
        ctx.addIssue({ code: "custom", path: ["invariant"], message: "invalid constant-product model" });
      }
      return;
    }
    if (model.invariant === "stableswap") {
      if (model.source !== "curve" && model.source !== "balancer") {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "stableswap models require a Curve or Balancer source",
        });
      }
      if (model.amplification === undefined) {
        ctx.addIssue({ code: "custom", path: ["amplification"], message: "stableswap models require amplification" });
      }
      return;
    }
    if (model.source !== "balancer") {
      ctx.addIssue({ code: "custom", path: ["source"], message: "weighted models require Balancer source" });
    }
    const weights = model.tokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) {
      ctx.addIssue({ code: "custom", path: ["tokens"], message: "weighted models require every token weight" });
      return;
    }
    const weightSum = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(weightSum - 1) > 0.0001) {
      ctx.addIssue({ code: "custom", path: ["tokens"], message: "weighted model token weights must sum to one" });
    }
  });
export type DexAmmExecutionModel = z.infer<typeof DexAmmExecutionModelSchema>;

/**
 * Exact pool-family evidence that was retained, but whose execution model was
 * intentionally rejected by a reviewed fail-closed gate. These rows remain in
 * the exact-route completeness denominator instead of being mistaken for
 * generic shaped TVL.
 */
export const DexExecutionCapabilityGateSchema = z.object({
  family: z.enum([
    "curve-stableswap",
    "curve-cryptoswap",
    "balancer-amm",
    "raydium-amm",
    "constant-product-v2",
    "solidly-v2",
    "measured-execution",
  ]),
  reason: z.enum([
    "unsupported-invariant",
    "rate-bearing-inputs",
    "paused-or-swap-disabled",
    "metapool-unsupported",
    "incomplete-exact-capture",
    // The verification transport failed before anything was observed (request
    // failure, pinned block unavailable, or exhausted wall-time budget). The
    // pool was NOT semantically refused: distinct from
    // `incomplete-exact-capture`, which asserts an observed capture was
    // incomplete, so operators can tell a provider blip from a data refusal.
    "transport-unavailable",
    "invalid-invariant-parameters",
    "ambiguous-token-identity",
    "tracked-input-unresolved",
    "exact-pool-join-unresolved",
    "target-unresolved",
    "unsupported-chain",
    "target-missing",
    "quote-missing",
    "quote-failed",
    // A rotating producer admission budget deferred this target before any
    // capability was exercised. Distinct from `quote-failed`, which asserts an
    // attempted measurement did not produce a valid profile.
    "budget-deferred",
    "generation-mismatch",
    "stale-observation",
    "invalid-observation",
    "deployment-code-mismatch",
    "activation-pending",
  ]),
  validationIssues: z.array(DexMeasuredExecutionValidationReasonSchema)
    .max(DexMeasuredExecutionValidationReasonSchema.options.length).optional(),
});
export type DexExecutionCapabilityGate = z.infer<typeof DexExecutionCapabilityGateSchema>;
