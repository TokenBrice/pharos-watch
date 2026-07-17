import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";

const CALIBRATION_SHOCKS = [400_000, 500_000, 600_000, 750_000] as const;
const SCORE_SHOCK = 500_000 as const;
const RECONCILIATION_TOLERANCE_PPM = 1_000 as const;

export const ShockDecimalStringSchema = z.string().regex(/^[0-9]+$/);
const PositiveDecimalStringSchema = ShockDecimalStringSchema.refine((value) => BigInt(value) > 0n, {
  message: "Expected a positive decimal integer string",
});
export const ShockAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
export const ShockHexWordSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const ShockHexBytesSchema = z
  .string()
  .regex(/^0x[0-9a-f]*$/)
  .refine((value) => value.length % 2 === 0, "Hex byte strings must contain complete bytes");

export const ShockMeasurementCallSchema = z
  .object({
    name: z.string().trim().min(1),
    to: ShockAddressSchema,
    signature: z.string().trim().min(3),
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    callData: ShockHexBytesSchema,
    returnData: ShockHexBytesSchema,
    decoded: z.string().min(1),
  })
  .strict()
  .superRefine((call, ctx) => {
    if (!call.callData.startsWith(call.selector)) {
      ctx.addIssue({ code: "custom", path: ["callData"], message: "Call data must start with its selector" });
    }
    if (keccak256(toBytes(call.signature)).slice(0, 10) !== call.selector) {
      ctx.addIssue({ code: "custom", path: ["selector"], message: "Selector must match the function signature" });
    }
  });

export const ShockContractCodePinSchema = z
  .object({
    name: z.string().trim().min(1),
    address: ShockAddressSchema,
    role: z.string().trim().min(1),
    bytecode: ShockHexBytesSchema.refine((value) => value !== "0x", "Pinned contract bytecode must not be empty"),
    codeHash: ShockHexWordSchema,
  })
  .strict()
  .superRefine((pin, ctx) => {
    if (keccak256(pin.bytecode as Hex) !== pin.codeHash) {
      ctx.addIssue({ code: "custom", path: ["codeHash"], message: "Code hash must match pinned bytecode" });
    }
  });

export const ShockOutcomeActionSchema = z.enum([
  "offset-and-redistribute",
  "redistribute-only",
  "capped-full-offset",
  "not-liquidatable",
  "skipped-insufficient-full-offset",
  "sequence-stopped",
  "protected-last-position",
]);

export const ShockPositionOutcomeSchema = z
  .object({
    positionId: z.string().min(1),
    liquidationOrder: z.number().int().nonnegative(),
    icrRaw: ShockDecimalStringSchema,
    action: ShockOutcomeActionSchema,
    liquidatedDebtRaw: ShockDecimalStringSchema,
    poolOffsetDebtRaw: ShockDecimalStringSchema,
    redistributedDebtRaw: ShockDecimalStringSchema,
  })
  .strict()
  .superRefine((outcome, ctx) => {
    if (
      BigInt(outcome.liquidatedDebtRaw) !==
      BigInt(outcome.poolOffsetDebtRaw) + BigInt(outcome.redistributedDebtRaw)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["liquidatedDebtRaw"],
        message: "Liquidated debt must equal pool-offset plus redistributed debt",
      });
    }
  });

export const ShockSimulationRunSchema = z
  .object({
    callerBatchPositionIds: z.array(z.string().min(1)).nullable(),
    startingPoolDebtRaw: ShockDecimalStringSchema,
    liquidatableDebtRaw: ShockDecimalStringSchema,
    poolOffsetDebtRaw: ShockDecimalStringSchema,
    redistributedDebtRaw: ShockDecimalStringSchema,
    endingPoolDebtRaw: ShockDecimalStringSchema,
    recoveryModeAtStart: z.boolean(),
    recoveryModeAtEnd: z.boolean(),
    outcomes: z.array(ShockPositionOutcomeSchema).min(1),
  })
  .strict()
  .superRefine((run, ctx) => {
    const startingPool = BigInt(run.startingPoolDebtRaw);
    const endingPool = BigInt(run.endingPoolDebtRaw);
    const poolOffset = BigInt(run.poolOffsetDebtRaw);
    const liquidatable = BigInt(run.liquidatableDebtRaw);
    const redistributed = BigInt(run.redistributedDebtRaw);
    if (startingPool < endingPool || startingPool - endingPool !== poolOffset) {
      ctx.addIssue({
        code: "custom",
        path: ["endingPoolDebtRaw"],
        message: "Ending pool debt must equal starting pool debt minus offset debt",
      });
    }
    if (liquidatable !== poolOffset + redistributed) {
      ctx.addIssue({
        code: "custom",
        path: ["liquidatableDebtRaw"],
        message: "Liquidatable debt must equal pool-offset plus redistributed debt",
      });
    }
    const outcomeTotals = run.outcomes.reduce(
      (totals, outcome) => ({
        liquidated: totals.liquidated + BigInt(outcome.liquidatedDebtRaw),
        offset: totals.offset + BigInt(outcome.poolOffsetDebtRaw),
        redistributed: totals.redistributed + BigInt(outcome.redistributedDebtRaw),
      }),
      { liquidated: 0n, offset: 0n, redistributed: 0n },
    );
    if (
      outcomeTotals.liquidated !== liquidatable ||
      outcomeTotals.offset !== poolOffset ||
      outcomeTotals.redistributed !== redistributed
    ) {
      ctx.addIssue({ code: "custom", path: ["outcomes"], message: "Outcome debt totals must equal run totals" });
    }
  });

const ShockFractionPpmSchema = z.union(CALIBRATION_SHOCKS.map((value) => z.literal(value)));
const CoverageRatioSchema = z.number().finite().min(0).max(1);

const ShockScenarioShape = {
  shockFractionPpm: ShockFractionPpmSchema,
  shockedPriceRaw: PositiveDecimalStringSchema,
  unlimited: ShockSimulationRunSchema,
  actual: ShockSimulationRunSchema,
  coverageRatio: CoverageRatioSchema,
} as const;

export const ShockScenarioSchema = z.object(ShockScenarioShape).strict();
export const LiquityV2ShockScenarioSchema = z
  .object({
    ...ShockScenarioShape,
    belowCriticalThresholdAtStart: z.boolean(),
  })
  .strict();

export const ShockAggregateScenarioSchema = z
  .object({
    shockFractionPpm: ShockFractionPpmSchema,
    stressLiquidatableDebt: ShockDecimalStringSchema,
    stressPoolOffsetDebt: ShockDecimalStringSchema,
    actualRedistributedDebt: ShockDecimalStringSchema,
    stressLiquidationCoverageRatio: CoverageRatioSchema,
  })
  .strict();

export const ShockMeasuredFactsSchema = z
  .object({
    applicability: z.literal("measured"),
    failureReason: z.null(),
    stressShockFraction: z.literal(0.5),
    stressLiquidatableDebt: ShockDecimalStringSchema,
    stressPoolOffsetDebt: ShockDecimalStringSchema,
    stressLiquidationCoverageRatio: CoverageRatioSchema,
    branchContributions: z
      .array(
        z
          .object({
            branchIndex: z.number().int().nonnegative(),
            stressLiquidatableDebt: ShockDecimalStringSchema,
            stressPoolOffsetDebt: ShockDecimalStringSchema,
            stressLiquidationCoverageRatio: CoverageRatioSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const ReconciliationSchema = z
  .object({
    positionDebtRaw: PositiveDecimalStringSchema,
    positionCollateralRaw: PositiveDecimalStringSchema,
    debtDeltaPpm: z.number().int().min(0).max(RECONCILIATION_TOLERANCE_PPM),
    collateralDeltaPpm: z.number().int().min(0).max(RECONCILIATION_TOLERANCE_PPM),
  })
  .strict();

export const LiquityV1ShockPositionSchema = z
  .object({
    id: ShockAddressSchema,
    owner: ShockAddressSchema,
    arrayIndex: z.number().int().nonnegative(),
    liquidationOrder: z.number().int().nonnegative(),
    status: z.literal("active"),
    debtRaw: PositiveDecimalStringSchema,
    collateralRaw: PositiveDecimalStringSchema,
    pendingDebtRaw: ShockDecimalStringSchema,
    pendingCollateralRaw: ShockDecimalStringSchema,
  })
  .strict()
  .refine((position) => position.id === position.owner, { path: ["owner"], message: "V1 id must equal owner" });

export const LiquityV2ShockPositionSchema = z
  .object({
    id: PositiveDecimalStringSchema,
    arrayIndex: z.number().int().nonnegative(),
    liquidationOrder: z.number().int().nonnegative(),
    status: z.enum(["active", "zombie"]),
    debtRaw: ShockDecimalStringSchema,
    collateralRaw: PositiveDecimalStringSchema,
    pendingDebtRaw: ShockDecimalStringSchema,
    pendingCollateralRaw: ShockDecimalStringSchema,
    accruedInterestRaw: ShockDecimalStringSchema,
    recordedDebtRaw: ShockDecimalStringSchema,
    annualInterestRateRaw: ShockDecimalStringSchema,
    weightedRecordedDebtRaw: ShockDecimalStringSchema,
    accruedBatchManagementFeeRaw: ShockDecimalStringSchema,
    lastInterestRateAdjustmentTime: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((position, ctx) => {
    if (position.status === "active" && BigInt(position.debtRaw) === 0n) {
      ctx.addIssue({ code: "custom", path: ["debtRaw"], message: "Only zombie Troves may have zero debt" });
    }
  });

const V1ContractsSchema = z
  .object({
    token: ShockAddressSchema,
    troveManager: ShockAddressSchema,
    stabilityPool: ShockAddressSchema,
    priceFeed: ShockAddressSchema,
    sortedTroves: ShockAddressSchema,
    activePool: ShockAddressSchema,
    defaultPool: ShockAddressSchema,
    borrowerOperations: ShockAddressSchema,
    gasPool: ShockAddressSchema,
    collSurplusPool: ShockAddressSchema,
    priceAggregator: ShockAddressSchema,
    priceAggregatorImplementation: ShockAddressSchema,
    tellorCaller: ShockAddressSchema,
    tellorOracle: ShockAddressSchema,
  })
  .strict();

const V2ContractsSchema = z
  .object({
    collateralToken: ShockAddressSchema,
    addressesRegistry: ShockAddressSchema,
    troveManager: ShockAddressSchema,
    stabilityPool: ShockAddressSchema,
    priceFeed: ShockAddressSchema,
    activePool: ShockAddressSchema,
    defaultPool: ShockAddressSchema,
    sortedTroves: ShockAddressSchema,
    borrowerOperations: ShockAddressSchema,
    troveNft: ShockAddressSchema,
    gasPool: ShockAddressSchema,
    collSurplusPool: ShockAddressSchema,
    boldToken: ShockAddressSchema,
    weth: ShockAddressSchema,
    collateralRegistry: ShockAddressSchema,
    interestRouter: ShockAddressSchema,
    ethUsdOracle: ShockAddressSchema,
    ethUsdOracleImplementation: ShockAddressSchema,
    secondaryOracle: ShockAddressSchema.nullable(),
    secondaryOracleImplementation: ShockAddressSchema.nullable(),
    rateProvider: ShockAddressSchema.nullable(),
  })
  .strict();

export const LiquityV1ShockBranchSchema = z
  .object({
    branchIndex: z.literal(0),
    label: z.string().trim().min(1),
    contracts: V1ContractsSchema,
    parameters: z
      .object({
        currentPriceRaw: PositiveDecimalStringSchema,
        mcrRaw: PositiveDecimalStringSchema,
        ccrRaw: PositiveDecimalStringSchema,
        currentRecoveryMode: z.boolean(),
        shutdownTime: z.null(),
      })
      .strict(),
    protocolTotals: z
      .object({
        debtRaw: PositiveDecimalStringSchema,
        collateralRaw: PositiveDecimalStringSchema,
        stabilityPoolDepositsRaw: ShockDecimalStringSchema,
      })
      .strict(),
    reconciliation: ReconciliationSchema,
    positions: z.array(LiquityV1ShockPositionSchema).min(1),
    scenarios: z.array(ShockScenarioSchema).length(CALIBRATION_SHOCKS.length),
  })
  .strict();

export const LiquityV2ShockBranchSchema = z
  .object({
    branchIndex: z.number().int().nonnegative(),
    label: z.string().trim().min(1),
    contracts: V2ContractsSchema,
    parameters: z
      .object({
        currentPriceRaw: PositiveDecimalStringSchema,
        mcrRaw: PositiveDecimalStringSchema,
        ccrRaw: PositiveDecimalStringSchema,
        scrRaw: PositiveDecimalStringSchema,
        liquidationPenaltySpRaw: ShockDecimalStringSchema,
        liquidationPenaltyRedistributionRaw: ShockDecimalStringSchema,
        minimumBoldLeftInStabilityPoolRaw: PositiveDecimalStringSchema,
        currentRecoveryMode: z.literal(false),
        currentBelowCriticalThreshold: z.boolean(),
        shutdownTime: z.number().int().nonnegative(),
        redeemable: z.boolean(),
      })
      .strict(),
    protocolTotals: z
      .object({
        debtRaw: PositiveDecimalStringSchema,
        collateralRaw: PositiveDecimalStringSchema,
        stabilityPoolDepositsRaw: ShockDecimalStringSchema,
        unbackedDebtRaw: ShockDecimalStringSchema,
      })
      .strict(),
    reconciliation: ReconciliationSchema,
    positions: z.array(LiquityV2ShockPositionSchema).min(1),
    scenarios: z.array(LiquityV2ShockScenarioSchema).length(CALIBRATION_SHOCKS.length),
  })
  .strict();

const EvidenceBaseShape = {
  schemaVersion: z.literal(1),
  kind: z.literal("cdp-shock-coverage-measurement"),
  assetId: z.string().trim().min(1),
  archetype: z.literal("cdp"),
  applicability: z.object({ state: z.literal("measured"), failureReason: z.null() }).strict(),
  completeness: z.object({ complete: z.literal(true), blockers: z.array(z.string().trim().min(1)).length(0) }).strict(),
  chain: z.object({ key: z.string().trim().min(1), evmChainId: z.number().int().positive() }).strict(),
  rpcUrl: z.string().url(),
  block: z
    .object({
      number: z.number().int().positive(),
      hash: ShockHexWordSchema,
      timestampUnix: z.number().int().positive(),
      timestampIso: z.string().datetime(),
      selection: z.enum(["finalized", "latest-minus-10", "operator-pinned"]),
    })
    .strict(),
  sourcePin: z
    .object({
      repository: z.string().url(),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      liquidationContractPath: z.string().trim().min(1),
    })
    .strict(),
  shockPolicy: z
    .object({
      scoreShockFractionPpm: z.literal(SCORE_SHOCK),
      sensitivityShockFractionsPpm: z.tuple([
        z.literal(400_000),
        z.literal(500_000),
        z.literal(600_000),
        z.literal(750_000),
      ]),
      debtReconciliationTolerancePpm: z.literal(RECONCILIATION_TOLERANCE_PPM),
    })
    .strict(),
  calls: z.array(ShockMeasurementCallSchema).min(1),
  codePins: z.array(ShockContractCodePinSchema).min(1),
  aggregateScenarios: z.array(ShockAggregateScenarioSchema).length(CALIBRATION_SHOCKS.length),
  measuredFacts: ShockMeasuredFactsSchema,
  checks: z
    .array(z.object({ id: z.string().trim().min(1), status: z.literal("pass"), detail: z.string().min(1) }).strict())
    .min(1),
  sources: z.array(z.object({ label: z.string().trim().min(1), url: z.string().url() }).strict()).min(1),
  tool: z.object({ name: z.literal("measure-cdp-shock-coverage"), version: z.literal("1") }).strict(),
} as const;

export const LiquityV1ShockCoverageEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    family: z.literal("liquity-v1-shock-v1"),
    branches: z.array(LiquityV1ShockBranchSchema).length(1),
  })
  .strict();

export const LiquityV2ShockCoverageEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    family: z.literal("liquity-v2-shock-v1"),
    branches: z.array(LiquityV2ShockBranchSchema).min(1),
  })
  .strict();

function expectedCoverage(poolOffsetDebt: string, liquidatableDebt: string): number {
  const denominator = BigInt(liquidatableDebt);
  if (denominator === 0n) return 1;
  const scale = 10n ** 12n;
  return Number((BigInt(poolOffsetDebt) * scale) / denominator) / Number(scale);
}

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function expectedDeltaPpm(measured: bigint, reference: bigint): number {
  if (reference <= 0n) return Number.MAX_SAFE_INTEGER;
  const difference = measured >= reference ? measured - reference : reference - measured;
  return Number((difference * 1_000_000n) / reference);
}

function isWithinReconciliationTolerance(measured: bigint, reference: bigint): boolean {
  return (
    reference > 0n &&
    (measured >= reference ? measured - reference : reference - measured) * 1_000_000n <=
      reference * BigInt(RECONCILIATION_TOLERANCE_PPM)
  );
}

function validateEvidence(
  evidence: z.infer<typeof LiquityV1ShockCoverageEvidenceSchema> | z.infer<typeof LiquityV2ShockCoverageEvidenceSchema>,
  ctx: z.RefinementCtx,
): void {
  if (new Set(evidence.codePins.map((pin) => pin.name)).size !== evidence.codePins.length) {
    addIssue(ctx, ["codePins"], "Code-pin names must be unique");
  }
  const pinnedAddresses = new Set(evidence.codePins.map((pin) => pin.address));
  const aggregateByShock = new Map(
    evidence.aggregateScenarios.map((scenario) => [scenario.shockFractionPpm, scenario]),
  );
  for (let scenarioIndex = 0; scenarioIndex < CALIBRATION_SHOCKS.length; scenarioIndex += 1) {
    const shock = CALIBRATION_SHOCKS[scenarioIndex]!;
    const aggregate = evidence.aggregateScenarios[scenarioIndex];
    if (aggregate?.shockFractionPpm !== shock) {
      addIssue(
        ctx,
        ["aggregateScenarios", scenarioIndex, "shockFractionPpm"],
        `Expected ordered ${shock} ppm scenario`,
      );
      continue;
    }
    let liquidatable = 0n;
    let offset = 0n;
    let redistributed = 0n;
    for (let branchIndex = 0; branchIndex < evidence.branches.length; branchIndex += 1) {
      const branch = evidence.branches[branchIndex]!;
      const scenario = branch.scenarios[scenarioIndex];
      if (scenario?.shockFractionPpm !== shock) {
        addIssue(
          ctx,
          ["branches", branchIndex, "scenarios", scenarioIndex, "shockFractionPpm"],
          `Expected ordered ${shock} ppm scenario`,
        );
        continue;
      }
      const expectedPrice = (BigInt(branch.parameters.currentPriceRaw) * BigInt(1_000_000 - shock)) / 1_000_000n;
      if (BigInt(scenario.shockedPriceRaw) !== expectedPrice) {
        addIssue(
          ctx,
          ["branches", branchIndex, "scenarios", scenarioIndex, "shockedPriceRaw"],
          "Shocked price does not match the policy fraction",
        );
      }
      if (
        scenario.unlimited.outcomes.length !== branch.positions.length ||
        scenario.actual.outcomes.length !== branch.positions.length
      ) {
        addIssue(
          ctx,
          ["branches", branchIndex, "scenarios", scenarioIndex],
          "Both runs must emit one outcome per position",
        );
      }
      const coverage = expectedCoverage(scenario.actual.poolOffsetDebtRaw, scenario.unlimited.liquidatableDebtRaw);
      if (scenario.coverageRatio !== coverage) {
        addIssue(
          ctx,
          ["branches", branchIndex, "scenarios", scenarioIndex, "coverageRatio"],
          "Branch coverage ratio does not match raw Q/O",
        );
      }
      liquidatable += BigInt(scenario.unlimited.liquidatableDebtRaw);
      offset += BigInt(scenario.actual.poolOffsetDebtRaw);
      redistributed += BigInt(scenario.actual.redistributedDebtRaw);
    }
    if (
      BigInt(aggregate.stressLiquidatableDebt) !== liquidatable ||
      BigInt(aggregate.stressPoolOffsetDebt) !== offset ||
      BigInt(aggregate.actualRedistributedDebt) !== redistributed ||
      aggregate.stressLiquidationCoverageRatio !== expectedCoverage(offset.toString(), liquidatable.toString())
    ) {
      addIssue(ctx, ["aggregateScenarios", scenarioIndex], "Aggregate scenario does not equal branch-local raw totals");
    }
  }

  const scoreAggregate = aggregateByShock.get(SCORE_SHOCK);
  if (
    !scoreAggregate ||
    evidence.measuredFacts.stressLiquidatableDebt !== scoreAggregate.stressLiquidatableDebt ||
    evidence.measuredFacts.stressPoolOffsetDebt !== scoreAggregate.stressPoolOffsetDebt ||
    evidence.measuredFacts.stressLiquidationCoverageRatio !== scoreAggregate.stressLiquidationCoverageRatio
  ) {
    addIssue(ctx, ["measuredFacts"], "Measured facts must equal the aggregate 50% scenario");
  }
  if (evidence.measuredFacts.branchContributions.length !== evidence.branches.length) {
    addIssue(ctx, ["measuredFacts", "branchContributions"], "Measured facts need one contribution per branch");
  }

  for (let branchIndex = 0; branchIndex < evidence.branches.length; branchIndex += 1) {
    const branch = evidence.branches[branchIndex]!;
    for (const [contractName, contractAddress] of Object.entries(branch.contracts)) {
      if (contractAddress !== null && !pinnedAddresses.has(contractAddress)) {
        addIssue(
          ctx,
          ["branches", branchIndex, "contracts", contractName],
          "Every recorded liquidation and oracle graph contract must have a code pin",
        );
      }
    }
    if (branch.branchIndex !== branchIndex) {
      addIssue(ctx, ["branches", branchIndex, "branchIndex"], "Branch indices must be ordered and contiguous");
    }
    const positionDebt = branch.positions.reduce((sum, position) => sum + BigInt(position.debtRaw), 0n);
    const positionCollateral = branch.positions.reduce((sum, position) => sum + BigInt(position.collateralRaw), 0n);
    const orderedPositions = [...branch.positions].sort(
      (left, right) => left.liquidationOrder - right.liquidationOrder,
    );
    if (
      new Set(branch.positions.map((position) => position.id)).size !== branch.positions.length ||
      orderedPositions.some((position, index) => position.liquidationOrder !== index)
    ) {
      addIssue(ctx, ["branches", branchIndex, "positions"], "Position IDs and liquidation order must be unique");
    }
    for (let scenarioIndex = 0; scenarioIndex < branch.scenarios.length; scenarioIndex += 1) {
      const scenario = branch.scenarios[scenarioIndex]!;
      const expectedV2CallerBatch =
        evidence.family === "liquity-v2-shock-v1"
          ? orderedPositions
              .filter((position) => {
                const debt = BigInt(position.debtRaw);
                const icr =
                  debt === 0n
                    ? 2n ** 256n - 1n
                    : (BigInt(position.collateralRaw) * BigInt(scenario.shockedPriceRaw)) / debt;
                return icr < BigInt(branch.parameters.mcrRaw);
              })
              .map((position) => position.id)
          : null;
      if (expectedV2CallerBatch?.length === orderedPositions.length) expectedV2CallerBatch.pop();
      for (const runName of ["unlimited", "actual"] as const) {
        const run = scenario[runName];
        const outcomes = run.outcomes;
        if (evidence.family === "liquity-v1-shock-v1") {
          if (run.callerBatchPositionIds !== null) {
            addIssue(
              ctx,
              ["branches", branchIndex, "scenarios", scenarioIndex, runName, "callerBatchPositionIds"],
              "V1 ordered liquidation traversal must not claim a V2 caller batch",
            );
          }
        } else if (JSON.stringify(run.callerBatchPositionIds) !== JSON.stringify(expectedV2CallerBatch)) {
          addIssue(
            ctx,
            ["branches", branchIndex, "scenarios", scenarioIndex, runName, "callerBatchPositionIds"],
            "V2 caller batch must contain every eligible Trove except the deterministic survivor when all are eligible",
          );
        }
        for (let outcomeIndex = 0; outcomeIndex < outcomes.length; outcomeIndex += 1) {
          const outcome = outcomes[outcomeIndex]!;
          const position = orderedPositions[outcomeIndex];
          if (
            !position ||
            outcome.positionId !== position.id ||
            outcome.liquidationOrder !== position.liquidationOrder
          ) {
            addIssue(
              ctx,
              ["branches", branchIndex, "scenarios", scenarioIndex, runName, "outcomes", outcomeIndex],
              "Outcome identity and order must match the enumerated position",
            );
            continue;
          }
          const expectedIcr =
            BigInt(position.debtRaw) === 0n
              ? 2n ** 256n - 1n
              : (BigInt(position.collateralRaw) * BigInt(scenario.shockedPriceRaw)) / BigInt(position.debtRaw);
          if (BigInt(outcome.icrRaw) !== expectedIcr) {
            addIssue(
              ctx,
              ["branches", branchIndex, "scenarios", scenarioIndex, runName, "outcomes", outcomeIndex, "icrRaw"],
              "Outcome ICR must match the enumerated position and shocked price",
            );
          }
          if (evidence.family === "liquity-v2-shock-v1") {
            const inCallerBatch = expectedV2CallerBatch?.includes(position.id) === true;
            const expectedAction =
              expectedIcr >= BigInt(branch.parameters.mcrRaw)
                ? "not-liquidatable"
                : inCallerBatch
                  ? "offset-and-redistribute"
                  : "protected-last-position";
            if (outcome.action !== expectedAction) {
              addIssue(
                ctx,
                ["branches", branchIndex, "scenarios", scenarioIndex, runName, "outcomes", outcomeIndex, "action"],
                "V2 outcome must match the explicit onchain-valid caller batch",
              );
            }
          }
          const isLiquidation = ["offset-and-redistribute", "redistribute-only", "capped-full-offset"].includes(
            outcome.action,
          );
          if (BigInt(outcome.liquidatedDebtRaw) !== (isLiquidation ? BigInt(position.debtRaw) : 0n)) {
            addIssue(
              ctx,
              [
                "branches",
                branchIndex,
                "scenarios",
                scenarioIndex,
                runName,
                "outcomes",
                outcomeIndex,
                "liquidatedDebtRaw",
              ],
              "Outcome liquidated debt must match its enumerated position and action",
            );
          }
        }
      }
    }
    if (
      positionDebt.toString() !== branch.reconciliation.positionDebtRaw ||
      positionCollateral.toString() !== branch.reconciliation.positionCollateralRaw
    ) {
      addIssue(
        ctx,
        ["branches", branchIndex, "reconciliation"],
        "Reconciliation totals must equal enumerated positions",
      );
    }
    const debtDeltaPpm = expectedDeltaPpm(positionDebt, BigInt(branch.protocolTotals.debtRaw));
    const collateralDeltaPpm = expectedDeltaPpm(positionCollateral, BigInt(branch.protocolTotals.collateralRaw));
    if (
      branch.reconciliation.debtDeltaPpm !== debtDeltaPpm ||
      branch.reconciliation.collateralDeltaPpm !== collateralDeltaPpm
    ) {
      addIssue(
        ctx,
        ["branches", branchIndex, "reconciliation"],
        "Reconciliation deltas must be recomputed from positions and protocol totals",
      );
    }
    if (
      !isWithinReconciliationTolerance(positionDebt, BigInt(branch.protocolTotals.debtRaw)) ||
      !isWithinReconciliationTolerance(positionCollateral, BigInt(branch.protocolTotals.collateralRaw))
    ) {
      addIssue(ctx, ["branches", branchIndex, "reconciliation"], "Reconciliation exceeds the exact 0.1% limit");
    }
    const contribution = evidence.measuredFacts.branchContributions[branchIndex];
    const scoreScenario = branch.scenarios.find((scenario) => scenario.shockFractionPpm === SCORE_SHOCK);
    if (
      !contribution ||
      !scoreScenario ||
      contribution.branchIndex !== branch.branchIndex ||
      contribution.stressLiquidatableDebt !== scoreScenario.unlimited.liquidatableDebtRaw ||
      contribution.stressPoolOffsetDebt !== scoreScenario.actual.poolOffsetDebtRaw ||
      contribution.stressLiquidationCoverageRatio !== scoreScenario.coverageRatio
    ) {
      addIssue(
        ctx,
        ["measuredFacts", "branchContributions", branchIndex],
        "Branch contribution must equal its 50% scenario",
      );
    }
  }
}

/** Separate evidence kind: existing mechanism-measurement artifacts are not widened or rewritten. */
export const ShockCoverageEvidenceV1Schema = z
  .discriminatedUnion("family", [LiquityV1ShockCoverageEvidenceSchema, LiquityV2ShockCoverageEvidenceSchema])
  .superRefine(validateEvidence);

export type ShockMeasurementCall = z.infer<typeof ShockMeasurementCallSchema>;
export type ShockContractCodePin = z.infer<typeof ShockContractCodePinSchema>;
export type ShockOutcomeAction = z.infer<typeof ShockOutcomeActionSchema>;
export type ShockPositionOutcomeEvidence = z.infer<typeof ShockPositionOutcomeSchema>;
export type ShockSimulationRunEvidence = z.infer<typeof ShockSimulationRunSchema>;
export type ShockScenarioEvidence = z.infer<typeof ShockScenarioSchema>;
export type LiquityV2ShockScenarioEvidence = z.infer<typeof LiquityV2ShockScenarioSchema>;
export type ShockAggregateScenarioEvidence = z.infer<typeof ShockAggregateScenarioSchema>;
export type ShockMeasuredFactsEvidence = z.infer<typeof ShockMeasuredFactsSchema>;
export type LiquityV1ShockPositionEvidence = z.infer<typeof LiquityV1ShockPositionSchema>;
export type LiquityV2ShockPositionEvidence = z.infer<typeof LiquityV2ShockPositionSchema>;
export type LiquityV1ShockBranchEvidence = z.infer<typeof LiquityV1ShockBranchSchema>;
export type LiquityV2ShockBranchEvidence = z.infer<typeof LiquityV2ShockBranchSchema>;
export type LiquityV1ShockCoverageEvidence = z.infer<typeof LiquityV1ShockCoverageEvidenceSchema>;
export type LiquityV2ShockCoverageEvidence = z.infer<typeof LiquityV2ShockCoverageEvidenceSchema>;
export type ShockCoverageEvidenceV1 = z.infer<typeof ShockCoverageEvidenceV1Schema>;
