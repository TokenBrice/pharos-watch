import { z } from "zod";

const HexBytesSchema = z
  .string()
  .regex(/^0x[0-9a-f]*$/)
  .refine((value) => value.length % 2 === 0, "Hex byte strings must contain complete bytes");
const HexWordSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const DecimalStringSchema = z.string().regex(/^[0-9]+$/);

const MeasurementCallSchema = z
  .object({
    name: z.string().min(1),
    to: z.string().regex(/^0x[0-9a-f]{40}$/),
    signature: z.string().min(3),
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    callData: HexBytesSchema,
    returnData: HexBytesSchema,
    decoded: z.string().min(1),
  })
  .strict();

const EvidenceBaseShape = {
  schemaVersion: z.literal(1),
  kind: z.literal("cdp-mechanism-measurement"),
  assetId: z.string().min(1),
  archetype: z.literal("cdp"),
  chain: z.object({ key: z.string().min(1), evmChainId: z.number().int().positive() }).strict(),
  rpcUrl: z.string().url(),
  block: z
    .object({
      number: z.number().int().positive(),
      hash: HexWordSchema,
      timestampUnix: z.number().int().positive(),
      timestampIso: z.string().min(20),
      selection: z.enum(["finalized", "latest-minus-10", "operator-pinned"]),
    })
    .strict(),
  calls: z.array(MeasurementCallSchema).min(1),
  metrics: z
    .object({
      collateralizationRatio: z.number().finite().positive(),
      liquidationCapacityRatio: z.number().finite().nonnegative(),
    })
    .strict(),
  checks: z
    .array(z.object({ id: z.string().min(1), status: z.literal("pass"), detail: z.string().min(1) }).strict())
    .min(1),
  overlaySources: z
    .array(z.object({ label: z.string().min(1), url: z.string().url() }).strict())
    .min(1),
  tool: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
} as const;

const ChainlinkCrossCheckSchema = z
  .object({
    answer: DecimalStringSchema,
    updatedAt: z.number().int().positive(),
    ageSeconds: z.number().int().nonnegative(),
    deltaPct: z.number().finite(),
  })
  .strict();

const LiquityV1EvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    family: z.literal("liquity-v1"),
    derived: z
      .object({
        priceWei: DecimalStringSchema,
        priceUsd: z.number().finite().positive(),
        chainlink: ChainlinkCrossCheckSchema,
        lastGoodPrice: z
          .object({
            valueWei: DecimalStringSchema,
            deltaPct: z.number().finite(),
            informational: z.literal(true),
          })
          .strict(),
        collateral: DecimalStringSchema,
        debt: DecimalStringSchema,
        spDeposits: DecimalStringSchema,
        totalSupply: DecimalStringSchema,
      })
      .strict(),
    notesHints: z
      .object({
        recoveryMode: z.boolean(),
        mcr: z.number().finite().positive(),
        ccr: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict();

const LiquityV2BranchSchema = z
  .object({
    index: z.number().int().nonnegative(),
    collateralToken: z.string().regex(/^0x[0-9a-f]{40}$/),
    troveManager: z.string().regex(/^0x[0-9a-f]{40}$/),
    stabilityPool: z.string().regex(/^0x[0-9a-f]{40}$/),
    collateral: DecimalStringSchema,
    debt: DecimalStringSchema,
    spDeposits: DecimalStringSchema,
    priceWei: DecimalStringSchema,
    priceUsd: z.number().finite().positive(),
    redeemable: z.boolean(),
    shutdownTime: z.number().int().nonnegative(),
  })
  .strict();

const LiquityV2EvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    family: z.literal("liquity-v2"),
    derived: z
      .object({
        branches: z.array(LiquityV2BranchSchema).min(1),
        totalCollateralValueWei: DecimalStringSchema,
        totalDebt: DecimalStringSchema,
        spDepositsTotal: DecimalStringSchema,
        totalSupply: DecimalStringSchema,
        supplyDebtDivergencePct: z.number().finite(),
        /** Sum of min(branch SP deposits, branch debt) over total debt — capacity usable within each isolated branch. */
        branchCappedLiquidationCapacityRatio: z.number().finite().nonnegative(),
        priceCrossCheck: z.union([
          z.object({ mode: z.literal("chainlink-branch0"), chainlink: ChainlinkCrossCheckSchema }).strict(),
          z.object({ mode: z.literal("protocol-feed-only") }).strict(),
        ]),
      })
      .strict(),
  })
  .strict();

/**
 * Point-in-time on-chain CDP mechanism measurement. Every field is a pure
 * function of (target config, pinned block, RPC responses): no wall-clock
 * values, so a rerun against the same block must be byte-identical. A file is
 * written only when every check passed — failures abort the run instead.
 */
export const MechanismMeasurementEvidenceV1Schema = z.discriminatedUnion("family", [
  LiquityV1EvidenceSchema,
  LiquityV2EvidenceSchema,
]);

export type MechanismMeasurementEvidenceV1 = z.infer<typeof MechanismMeasurementEvidenceV1Schema>;
export type LiquityV1MeasurementEvidence = z.infer<typeof LiquityV1EvidenceSchema>;
export type LiquityV2MeasurementEvidence = z.infer<typeof LiquityV2EvidenceSchema>;
export type MeasurementCall = z.infer<typeof MeasurementCallSchema>;
