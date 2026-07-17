import type {
  AggregatedShockScenario,
  ShockPositionInput,
  ShockPositionOutcome,
  ShockScenarioResult,
  ShockSimulationRun,
} from "./shock-simulator";
import type { ShockCodeSpec, ShockContractCodePin } from "./shock-journal";
import { SCORE_SHOCK_FRACTION_PPM } from "./shock-targets";

export interface PassCheck {
  id: string;
  status: "pass";
  detail: string;
}

export function requirePass(checks: PassCheck[], id: string, condition: boolean, detail: string): void {
  if (!condition) throw new Error(`Check failed: ${id} - ${detail}`);
  checks.push({ id, status: "pass", detail });
}

export function requireCodePinCoverage(
  checks: PassCheck[],
  specs: readonly ShockCodeSpec[],
  pins: readonly ShockContractCodePin[],
): void {
  const complete =
    pins.length === specs.length &&
    specs.every(
      (spec, index) =>
        pins[index]?.name === spec.name && pins[index]?.address === spec.address && pins[index]?.role === spec.role,
    );
  requirePass(
    checks,
    "code-pins.graph-coverage",
    complete,
    `captured all ${specs.length} named graph dependencies: ${specs.map((spec) => spec.name).join(", ")}`,
  );
}

export function absoluteDelta(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

export function deltaPpm(measured: bigint, reference: bigint): number {
  if (reference <= 0n) throw new Error("Cannot calculate reconciliation against non-positive protocol totals");
  return Number((absoluteDelta(measured, reference) * 1_000_000n) / reference);
}

export function isWithinDeltaPpm(measured: bigint, reference: bigint, tolerancePpm: number): boolean {
  if (reference <= 0n || !Number.isInteger(tolerancePpm) || tolerancePpm < 0) return false;
  return absoluteDelta(measured, reference) * 1_000_000n <= reference * BigInt(tolerancePpm);
}

export function serialisePosition(position: ShockPositionInput) {
  return {
    id: position.id,
    debtRaw: position.debt.toString(),
    collateralRaw: position.collateral.toString(),
    pendingDebtRaw: position.pendingDebt.toString(),
    pendingCollateralRaw: position.pendingCollateral.toString(),
    status: position.status,
    liquidationOrder: position.liquidationOrder,
  };
}

export function serialiseOutcome(outcome: ShockPositionOutcome) {
  return {
    positionId: outcome.positionId,
    liquidationOrder: outcome.liquidationOrder,
    icrRaw: outcome.icrRaw.toString(),
    action: outcome.action,
    liquidatedDebtRaw: outcome.liquidatedDebt.toString(),
    poolOffsetDebtRaw: outcome.poolOffsetDebt.toString(),
    redistributedDebtRaw: outcome.redistributedDebt.toString(),
  };
}

export function serialiseRun(run: ShockSimulationRun) {
  return {
    callerBatchPositionIds: run.callerBatchPositionIds,
    startingPoolDebtRaw: run.startingPoolDebt.toString(),
    liquidatableDebtRaw: run.liquidatableDebt.toString(),
    poolOffsetDebtRaw: run.poolOffsetDebt.toString(),
    redistributedDebtRaw: run.redistributedDebt.toString(),
    endingPoolDebtRaw: run.endingPoolDebt.toString(),
    recoveryModeAtStart: run.recoveryModeAtStart,
    recoveryModeAtEnd: run.recoveryModeAtEnd,
    outcomes: run.outcomes.map(serialiseOutcome),
  };
}

export function serialiseScenario(scenario: ShockScenarioResult) {
  return {
    shockFractionPpm: scenario.shockFractionPpm,
    shockedPriceRaw: scenario.shockedPrice.toString(),
    unlimited: serialiseRun(scenario.unlimited),
    actual: serialiseRun(scenario.actual),
    coverageRatio: scenario.coverageRatio,
  };
}

export function serialiseAggregateScenario(scenario: AggregatedShockScenario) {
  return {
    shockFractionPpm: scenario.shockFractionPpm,
    stressLiquidatableDebt: scenario.liquidatableDebt.toString(),
    stressPoolOffsetDebt: scenario.poolOffsetDebt.toString(),
    actualRedistributedDebt: scenario.redistributedDebt.toString(),
    stressLiquidationCoverageRatio: scenario.coverageRatio,
  };
}

export function buildMeasuredFacts(
  aggregateScenarios: readonly AggregatedShockScenario[],
  branchScenarios: readonly { branchIndex: number; scenarios: readonly ShockScenarioResult[] }[],
) {
  const scoreScenario = aggregateScenarios.find((scenario) => scenario.shockFractionPpm === SCORE_SHOCK_FRACTION_PPM);
  if (!scoreScenario) throw new Error(`Missing score-bearing ${SCORE_SHOCK_FRACTION_PPM} ppm scenario`);

  return {
    applicability: "measured" as const,
    failureReason: null,
    stressShockFraction: SCORE_SHOCK_FRACTION_PPM / 1_000_000,
    stressLiquidatableDebt: scoreScenario.liquidatableDebt.toString(),
    stressPoolOffsetDebt: scoreScenario.poolOffsetDebt.toString(),
    stressLiquidationCoverageRatio: scoreScenario.coverageRatio,
    branchContributions: branchScenarios.map(({ branchIndex, scenarios }) => {
      const scenario = scenarios.find((candidate) => candidate.shockFractionPpm === SCORE_SHOCK_FRACTION_PPM);
      if (!scenario) throw new Error(`Branch ${branchIndex} is missing its score-bearing scenario`);
      return {
        branchIndex,
        stressLiquidatableDebt: scenario.unlimited.liquidatableDebt.toString(),
        stressPoolOffsetDebt: scenario.actual.poolOffsetDebt.toString(),
        stressLiquidationCoverageRatio: scenario.coverageRatio,
      };
    }),
  };
}
