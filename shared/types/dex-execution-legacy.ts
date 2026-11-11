import { z } from "zod";
import { DexAmmExecutionTokenSchema, DexAmmExecutionModelSchema } from "./dex-execution";

/** Archival reader only: these variants no longer have a producer or simulator. */
const RetiredSolidlyStateSchema = z.object({
  variant: z.enum(["aerodrome", "velodrome", "shadow"]),
  stable: z.boolean(),
  reserve0: z.string().max(78).regex(/^[1-9][0-9]*$/),
  reserve1: z.string().max(78).regex(/^[1-9][0-9]*$/),
  fee: z.number().int().nonnegative().lt(1_000_000),
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
}).refine((state) => state.variant === "shadow" || state.stable === false, {
  message: "Only retired Solidly variants belong to the archival reader",
});
const RetiredSolidlyModelFields = {
  invariant: z.enum(["constant-product", "solidly-stable"]),
  trackedTokenIndex: z.number().int().nonnegative(),
  feeRate: z.number().finite().min(0).lt(1),
  amplification: z.undefined().optional(),
  tokens: z.array(DexAmmExecutionTokenSchema).length(2),
};
export const DexRetiredSolidlyLegacyModelSchema = z.object({
  ...RetiredSolidlyModelFields,
  source: z.literal("solidly-v2"),
  solidlyState: RetiredSolidlyStateSchema,
}).transform((model) => ({
  ...model,
  source: "retired-solidly-v2" as const,
  unavailableReason: "retired-solidly-variant" as const,
  retiredSolidlyState: model.solidlyState,
  solidlyState: undefined,
}));
const DexRetiredSolidlyModelSchema = z.object({
  ...RetiredSolidlyModelFields,
  source: z.literal("retired-solidly-v2"),
  unavailableReason: z.literal("retired-solidly-variant"),
  retiredSolidlyState: RetiredSolidlyStateSchema,
  solidlyState: z.undefined().optional(),
});
/** Stored/API readers retain a retired row, but never treat its historical model as executable. */
export const DexStoredAmmExecutionModelSchema = z.union([
  DexAmmExecutionModelSchema, DexRetiredSolidlyLegacyModelSchema, DexRetiredSolidlyModelSchema,
]);
export type DexStoredAmmExecutionModel = z.infer<typeof DexStoredAmmExecutionModelSchema>;
