import type {
  AggregatedShockScenario,
  ShockPositionInput,
  ShockPositionOutcome,
  ShockScenarioResult,
  ShockSimulationRun,
} from "./shock-simulator";
import { decodeAddressWord, decodeUintWord, normalizeAddress, type PinnedBlock } from "./core";
import type { ShockCallJournal, ShockCodeSpec, ShockContractCodePin, ShockEthCallSpec } from "./shock-journal";
import {
  DEBT_RECONCILIATION_TOLERANCE_PPM,
  SCORE_SHOCK_FRACTION_PPM,
  SHOCK_FRACTIONS_PPM,
  type ShockCoverageTarget,
} from "./shock-targets";

export interface PassCheck {
  id: string;
  status: "pass";
  detail: string;
}

export async function readUint(
  caller: ShockCallJournal,
  spec: ShockEthCallSpec,
  wordIndex = 0,
  label = spec.name,
): Promise<bigint> {
  const data = await caller.call(spec);
  const value = decodeUintWord(data, wordIndex, label);
  caller.recordDecoded(value.toString());
  return value;
}

export async function readAddress(caller: ShockCallJournal, spec: ShockEthCallSpec): Promise<string> {
  const data = await caller.call(spec);
  const value = normalizeAddress(decodeAddressWord(data, spec.name), spec.name);
  caller.recordDecoded(value);
  return value;
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

export interface MeasuredShockFacts {
  applicability: "measured";
  failureReason: null;
  stressShockFraction: number;
  stressLiquidatableDebt: string;
  stressPoolOffsetDebt: string;
  stressLiquidationCoverageRatio: number;
  branchContributions: {
    branchIndex: number;
    stressLiquidatableDebt: string;
    stressPoolOffsetDebt: string;
    stressLiquidationCoverageRatio: number;
  }[];
}

export function buildMeasuredFacts(
  aggregateScenarios: readonly AggregatedShockScenario[],
  branchScenarios: readonly { branchIndex: number; scenarios: readonly ShockScenarioResult[] }[],
): MeasuredShockFacts {
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

export interface CdpShockMeasurementEnvelope<
  TBranch,
  TFamily extends ShockCoverageTarget["family"] = ShockCoverageTarget["family"],
> {
  schemaVersion: 1;
  kind: "cdp-shock-coverage-measurement";
  assetId: string;
  archetype: "cdp";
  family: TFamily;
  applicability: { state: "measured"; failureReason: null };
  completeness: { complete: true; blockers: [] };
  chain: ShockCoverageTarget["chain"];
  rpcUrl: string;
  block: PinnedBlock;
  sourcePin: ShockCoverageTarget["sourcePin"];
  shockPolicy: {
    scoreShockFractionPpm: number;
    sensitivityShockFractionsPpm: number[];
    debtReconciliationTolerancePpm: number;
  };
  calls: ShockCallJournal["calls"];
  codePins: readonly ShockContractCodePin[];
  branches: TBranch[];
  aggregateScenarios: ReturnType<typeof serialiseAggregateScenario>[];
  measuredFacts: MeasuredShockFacts;
  checks: PassCheck[];
  sources: ShockCoverageTarget["sources"];
  tool: { name: "measure-cdp-shock-coverage"; version: "1" };
}

export interface BuildCdpShockMeasurementOptions<
  TBranch,
  TTarget extends ShockCoverageTarget = ShockCoverageTarget,
> {
  caller: ShockCallJournal;
  target: TTarget;
  block: PinnedBlock;
  rpcUrl: string;
  codePins: readonly ShockContractCodePin[];
  branches: TBranch[];
  aggregateScenarios: readonly AggregatedShockScenario[];
  measuredFacts: MeasuredShockFacts;
  checks: PassCheck[];
}

export function buildCdpShockMeasurement<
  TBranch,
  TTarget extends ShockCoverageTarget = ShockCoverageTarget,
>(
  options: BuildCdpShockMeasurementOptions<TBranch, TTarget>,
): CdpShockMeasurementEnvelope<TBranch, TTarget["family"]> {
  const { caller, target, block, rpcUrl, codePins, branches, aggregateScenarios, measuredFacts, checks } = options;
  return {
    schemaVersion: 1,
    kind: "cdp-shock-coverage-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: target.family,
    applicability: { state: "measured", failureReason: null },
    completeness: { complete: true, blockers: [] },
    chain: target.chain,
    rpcUrl,
    block,
    sourcePin: target.sourcePin,
    shockPolicy: {
      scoreShockFractionPpm: SCORE_SHOCK_FRACTION_PPM,
      sensitivityShockFractionsPpm: [...SHOCK_FRACTIONS_PPM],
      debtReconciliationTolerancePpm: DEBT_RECONCILIATION_TOLERANCE_PPM,
    },
    calls: caller.calls,
    codePins,
    branches,
    aggregateScenarios: aggregateScenarios.map(serialiseAggregateScenario),
    measuredFacts,
    checks,
    sources: [...target.sources],
    tool: { name: "measure-cdp-shock-coverage", version: "1" },
  };
}
