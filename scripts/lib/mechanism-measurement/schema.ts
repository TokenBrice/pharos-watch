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

/**
 * Point-in-time on-chain CDP mechanism measurement. Every field is a pure
 * function of (target config, pinned block, RPC responses): no wall-clock
 * values, so a rerun against the same block must be byte-identical. A file is
 * written only when every check passed — failures abort the run instead.
 */
export const MechanismMeasurementEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("cdp-mechanism-measurement"),
    assetId: z.string().min(1),
    archetype: z.literal("cdp"),
    family: z.enum(["liquity-v1"]),
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
    derived: z
      .object({
        priceWei: DecimalStringSchema,
        priceUsd: z.number().finite().positive(),
        chainlink: z
          .object({
            answer: DecimalStringSchema,
            updatedAt: z.number().int().positive(),
            ageSeconds: z.number().int().nonnegative(),
            deltaPct: z.number().finite(),
          })
          .strict(),
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
    metrics: z
      .object({
        collateralizationRatio: z.number().finite().positive(),
        liquidationCapacityRatio: z.number().finite().nonnegative(),
      })
      .strict(),
    checks: z
      .array(z.object({ id: z.string().min(1), status: z.literal("pass"), detail: z.string().min(1) }).strict())
      .min(1),
    notesHints: z
      .object({
        recoveryMode: z.boolean(),
        mcr: z.number().finite().positive(),
        ccr: z.number().finite().positive(),
      })
      .strict(),
    overlaySources: z
      .array(z.object({ label: z.string().min(1), url: z.string().url() }).strict())
      .min(1),
    tool: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  })
  .strict();

export type MechanismMeasurementEvidenceV1 = z.infer<typeof MechanismMeasurementEvidenceV1Schema>;
export type MeasurementCall = z.infer<typeof MeasurementCallSchema>;
