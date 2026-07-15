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

const MeasurementLogSchema = z
  .object({
    address: z.string().regex(/^0x[0-9a-f]{40}$/),
    blockHash: HexWordSchema,
    blockNumber: z.string().regex(/^0x[0-9a-f]+$/),
    transactionHash: HexWordSchema,
    transactionIndex: z.string().regex(/^0x[0-9a-f]+$/),
    logIndex: z.string().regex(/^0x[0-9a-f]+$/),
    data: HexBytesSchema,
    topics: z.array(HexWordSchema).min(1),
    removed: z.boolean(),
  })
  .strict();

const MeasurementLogQuerySchema = z
  .object({
    name: z.string().min(1),
    address: z.string().regex(/^0x[0-9a-f]{40}$/),
    fromBlock: z.number().int().nonnegative(),
    toBlock: z.number().int().positive(),
    topics: z.array(HexWordSchema).min(1),
    logs: z.array(MeasurementLogSchema),
    decoded: z.string().min(1),
  })
  .strict();

const MeasurementMetricApplicabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("measured") }).strict(),
  z
    .object({
      state: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
    })
    .strict(),
]);

const MeasurementMetricsSchema = z
  .object({
    collateralizationRatio: z.number().finite().positive().nullable(),
    liquidationCapacityRatio: z.number().finite().nonnegative().nullable(),
    applicability: z
      .object({
        collateralizationRatio: MeasurementMetricApplicabilitySchema,
        liquidationCapacityRatio: MeasurementMetricApplicabilitySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((metrics, ctx) => {
    for (const metric of ["collateralizationRatio", "liquidationCapacityRatio"] as const) {
      const applicability = metrics.applicability?.[metric] ?? { state: "measured" as const };
      if (applicability.state === "measured" && metrics[metric] === null) {
        ctx.addIssue({ code: "custom", path: [metric], message: `Measured ${metric} needs a numeric value` });
      }
      if (applicability.state === "not-applicable" && metrics[metric] !== null) {
        ctx.addIssue({ code: "custom", path: [metric], message: `Not-applicable ${metric} must be null` });
      }
    }
  });

const CompletenessSchema = z
  .object({
    complete: z.boolean(),
    blockers: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((completeness, ctx) => {
    if (completeness.complete && completeness.blockers.length > 0) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "Complete measurements cannot retain blockers" });
    }
    if (!completeness.complete && completeness.blockers.length === 0) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "Incomplete measurements need a blocker" });
    }
  });

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
  logQueries: z.array(MeasurementLogQuerySchema).optional(),
  metrics: MeasurementMetricsSchema,
  completeness: CompletenessSchema.optional(),
  warnings: z.array(z.string().trim().min(1)).optional(),
  checks: z
    .array(z.object({ id: z.string().min(1), status: z.literal("pass"), detail: z.string().min(1) }).strict())
    .min(1),
  overlaySources: z.array(z.object({ label: z.string().min(1), url: z.string().url() }).strict()).min(1),
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
    collateralDecimals: z.number().int().min(0).max(36).optional(),
    debtDecimals: z.number().int().min(0).max(36).optional(),
    priceDecimals: z.number().int().min(0).max(36).optional(),
    activePool: z
      .string()
      .regex(/^0x[0-9a-f]{40}$/)
      .optional(),
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

const EnumeratedLiquityV2EvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("liquity-v2-enumerated-v1"),
    derived: z
      .object({
        registry: z.string().regex(/^0x[0-9a-f]{40}$/),
        branches: z.array(LiquityV2BranchSchema).min(1),
        totalCollateralValueWad: DecimalStringSchema,
        totalDebtWad: DecimalStringSchema,
        spDepositsWad: DecimalStringSchema,
        totalSupplyWad: DecimalStringSchema,
        supplyDebtDivergencePct: z.number().finite().nonnegative(),
        branchCappedLiquidationCapacityRatio: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const MentoConversionEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("mento-conversion-evidence-v1"),
    derived: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("broker-pool"),
          exchangeId: HexWordSchema,
          exchangeCount: z.number().int().positive(),
          selfToken: z.string().regex(/^0x[0-9a-f]{40}$/),
          counterToken: z.string().regex(/^0x[0-9a-f]{40}$/),
          counterCapacityRaw: DecimalStringSchema,
          feeBps: z.number().int().nonnegative(),
          totalSupplyRaw: DecimalStringSchema,
        })
        .strict(),
      z
        .object({
          mode: z.literal("fpmm-pool"),
          selfToken: z.string().regex(/^0x[0-9a-f]{40}$/),
          counterToken: z.string().regex(/^0x[0-9a-f]{40}$/),
          pool: z.string().regex(/^0x[0-9a-f]{40}$/),
          counterCapacityRaw: DecimalStringSchema,
          feeBps: z.null(),
          totalSupplyRaw: DecimalStringSchema,
        })
        .strict(),
    ]),
    analogousMetrics: z.object({ conversionCapacityCounterUnits: z.number().finite().positive() }).strict(),
  })
  .strict();

const YamatoEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("yamato-system-v1"),
    derived: z
      .object({
        yamato: z.string().regex(/^0x[0-9a-f]{40}$/),
        currencyOs: z.string().regex(/^0x[0-9a-f]{40}$/),
        token: z.string().regex(/^0x[0-9a-f]{40}$/),
        priceFeed: z.string().regex(/^0x[0-9a-f]{40}$/),
        pool: z.string().regex(/^0x[0-9a-f]{40}$/),
        totalCollateralRaw: DecimalStringSchema,
        totalDebtRaw: DecimalStringSchema,
        totalSupplyRaw: DecimalStringSchema,
        priceRaw: DecimalStringSchema,
        poolBalanceRaw: DecimalStringSchema,
        mcrPct: z.number().int().nonnegative(),
      })
      .strict(),
    analogousMetrics: z.object({ protocolRedemptionPoolRatio: z.number().finite().nonnegative() }).strict(),
  })
  .strict();

const GhoEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("gho-facilitator-evidence-v1"),
    derived: z
      .object({
        totalSupplyRaw: DecimalStringSchema,
        facilitatorLevelTotalRaw: DecimalStringSchema,
        facilitators: z
          .array(
            z
              .object({
                address: z.string().regex(/^0x[0-9a-f]{40}$/),
                label: z.string().min(1),
                bucketCapacityRaw: DecimalStringSchema,
                bucketLevelRaw: DecimalStringSchema,
              })
              .strict(),
          )
          .min(1),
        trackedGsms: z.array(
          z
            .object({
              address: z.string().regex(/^0x[0-9a-f]{40}$/),
              usedRaw: DecimalStringSchema,
              excessRaw: DecimalStringSchema,
              deficitRaw: DecimalStringSchema,
              currentBackingRaw: DecimalStringSchema,
              isFrozen: z.boolean(),
              isSeized: z.boolean(),
              feeStrategy: z.string().regex(/^0x[0-9a-f]{40}$/),
              buyFeeBps: z.number().int().nonnegative().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    analogousMetrics: z
      .object({
        facilitatorUnusedCapacityRatio: z.number().finite().nonnegative(),
        directSwappableGsmCapacityRatio: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const FxProtocolEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    logQueries: z.array(MeasurementLogQuerySchema).min(1),
    completeness: CompletenessSchema,
    family: z.literal("fx-protocol-v1"),
    derived: z
      .object({
        token: z.string().regex(/^0x[0-9a-f]{40}$/),
        poolManager: z.string().regex(/^0x[0-9a-f]{40}$/),
        fxBase: z.string().regex(/^0x[0-9a-f]{40}$/),
        totalSupplyRaw: DecimalStringSchema,
        legacySupplyRaw: DecimalStringSchema,
        totalDebtRaw: DecimalStringSchema,
        totalCollateralValueWad: DecimalStringSchema,
        fxBaseStableRaw: DecimalStringSchema,
        fxBaseYieldRaw: DecimalStringSchema,
        fxBaseShareSupplyRaw: DecimalStringSchema,
        fxBaseNavRaw: DecimalStringSchema,
        registeredPools: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)).min(1),
        pools: z
          .array(
            z
              .object({
                address: z.string().regex(/^0x[0-9a-f]{40}$/),
                collateralToken: z.string().regex(/^0x[0-9a-f]{40}$/),
                priceOracle: z.string().regex(/^0x[0-9a-f]{40}$/),
                collateralRaw: DecimalStringSchema,
                debtRaw: DecimalStringSchema,
                anchorPriceRaw: DecimalStringSchema,
                borrowPaused: z.boolean(),
                redeemPaused: z.boolean(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

const WrapperMechanismEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("wrapper-mechanism-v1"),
    derived: z
      .object({
        wrapper: z.string().regex(/^0x[0-9a-f]{40}$/),
        parentAssetId: z.string().min(1),
        asset: z.string().regex(/^0x[0-9a-f]{40}$/),
        totalSupplyRaw: DecimalStringSchema,
        totalAssetsRaw: DecimalStringSchema,
        convertedAssetsRaw: DecimalStringSchema,
        accountingDeltaPct: z.number().finite().nonnegative(),
      })
      .strict(),
    analogousMetrics: z.object({ localBackingRatio: z.number().finite().positive() }).strict(),
  })
  .strict();

const ResupplyEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    completeness: CompletenessSchema,
    family: z.literal("resupply-pairs-v1"),
    derived: z
      .object({
        token: z.string().regex(/^0x[0-9a-f]{40}$/),
        registry: z.string().regex(/^0x[0-9a-f]{40}$/),
        insurancePool: z.string().regex(/^0x[0-9a-f]{40}$/),
        liquidationHandler: z.string().regex(/^0x[0-9a-f]{40}$/),
        totalSupplyRaw: DecimalStringSchema,
        totalDebtRaw: DecimalStringSchema,
        totalCollateralAssetsRaw: DecimalStringSchema,
        insuranceAssetsRaw: DecimalStringSchema,
        pairCount: z.number().int().positive(),
        supplyDebtDivergencePct: z.number().finite().nonnegative(),
        pairs: z
          .array(
            z
              .object({
                address: z.string().regex(/^0x[0-9a-f]{40}$/),
                underlying: z.string().regex(/^0x[0-9a-f]{40}$/),
                collateral: z.string().regex(/^0x[0-9a-f]{40}$/),
                totalBorrowRaw: DecimalStringSchema,
                totalCollateralSharesRaw: DecimalStringSchema,
                totalCollateralAssetsRaw: DecimalStringSchema,
                active: z.boolean(),
              })
              .strict(),
          )
          .min(1),
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
  EnumeratedLiquityV2EvidenceSchema,
  MentoConversionEvidenceSchema,
  YamatoEvidenceSchema,
  GhoEvidenceSchema,
  FxProtocolEvidenceSchema,
  WrapperMechanismEvidenceSchema,
  ResupplyEvidenceSchema,
]);

export type MechanismMeasurementEvidenceV1 = z.infer<typeof MechanismMeasurementEvidenceV1Schema>;
export type LiquityV1MeasurementEvidence = z.infer<typeof LiquityV1EvidenceSchema>;
export type LiquityV2MeasurementEvidence = z.infer<typeof LiquityV2EvidenceSchema>;
export type EnumeratedLiquityV2MeasurementEvidence = z.infer<typeof EnumeratedLiquityV2EvidenceSchema>;
export type MentoConversionMeasurementEvidence = z.infer<typeof MentoConversionEvidenceSchema>;
export type YamatoMeasurementEvidence = z.infer<typeof YamatoEvidenceSchema>;
export type GhoMeasurementEvidence = z.infer<typeof GhoEvidenceSchema>;
export type FxProtocolMeasurementEvidence = z.infer<typeof FxProtocolEvidenceSchema>;
export type WrapperMechanismMeasurementEvidence = z.infer<typeof WrapperMechanismEvidenceSchema>;
export type ResupplyMeasurementEvidence = z.infer<typeof ResupplyEvidenceSchema>;
export type MeasurementCall = z.infer<typeof MeasurementCallSchema>;
export type MeasurementLog = z.infer<typeof MeasurementLogSchema>;
export type MeasurementLogQuery = z.infer<typeof MeasurementLogQuerySchema>;
