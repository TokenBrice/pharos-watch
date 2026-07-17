const WAD = 10n ** 18n;
const PPM = 1_000_000n;
const MAX_UINT256 = 2n ** 256n - 1n;
const V1_COLL_GAS_DIVISOR = 200n;
const V2_MIN_BOLD_IN_SP = WAD;

export interface ShockPositionInput {
  id: string;
  debt: bigint;
  collateral: bigint;
  pendingDebt: bigint;
  pendingCollateral: bigint;
  status: "active" | "zombie";
  liquidationOrder: number;
}

export type ShockOutcomeAction =
  | "offset-and-redistribute"
  | "redistribute-only"
  | "capped-full-offset"
  | "not-liquidatable"
  | "skipped-insufficient-full-offset"
  | "sequence-stopped"
  | "protected-last-position";

export interface ShockPositionOutcome {
  positionId: string;
  liquidationOrder: number;
  icrRaw: bigint;
  action: ShockOutcomeAction;
  liquidatedDebt: bigint;
  poolOffsetDebt: bigint;
  redistributedDebt: bigint;
}

export interface ShockSimulationRun {
  /** Exact V2 batchLiquidateTroves caller array; null for V1's ordered liquidateTroves traversal. */
  callerBatchPositionIds: readonly string[] | null;
  startingPoolDebt: bigint;
  liquidatableDebt: bigint;
  poolOffsetDebt: bigint;
  redistributedDebt: bigint;
  endingPoolDebt: bigint;
  recoveryModeAtStart: boolean;
  recoveryModeAtEnd: boolean;
  outcomes: ShockPositionOutcome[];
}

export interface ShockScenarioResult {
  shockFractionPpm: number;
  shockedPrice: bigint;
  unlimited: ShockSimulationRun;
  actual: ShockSimulationRun;
  coverageRatio: number;
}

export interface LiquityV1SimulationInput {
  price: bigint;
  mcr: bigint;
  ccr: bigint;
  protocolDebt: bigint;
  protocolCollateral: bigint;
  stabilityPoolDeposits: bigint;
  /** Lowest nominal collateral ratio first, exactly as SortedTroves is traversed from tail to head. */
  positions: readonly ShockPositionInput[];
}

export interface LiquityV2SimulationInput {
  price: bigint;
  mcr: bigint;
  ccr: bigint;
  protocolDebt: bigint;
  protocolCollateral: bigint;
  stabilityPoolDeposits: bigint;
  /** Deterministic caller-supplied batch order; it decides the survivor if every Trove is eligible. */
  positions: readonly ShockPositionInput[];
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function computeCr(collateral: bigint, debt: bigint, price: bigint): bigint {
  if (debt < 0n) throw new Error("Cannot compute a collateral ratio for negative debt");
  // LiquityMath._computeCR defines zero debt as infinite collateralization.
  // Fully redeemed V2 zombie Troves can remain in TroveIds with collateral.
  if (debt === 0n) return MAX_UINT256;
  return (collateral * price) / debt;
}

function shockPrice(price: bigint, shockFractionPpm: number): bigint {
  if (!Number.isInteger(shockFractionPpm) || shockFractionPpm < 0 || shockFractionPpm >= Number(PPM)) {
    throw new Error(`Invalid shock fraction ${shockFractionPpm} ppm`);
  }
  return (price * (PPM - BigInt(shockFractionPpm))) / PPM;
}

function formatRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 1;
  const scale = 10n ** 12n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

function makeOutcome(
  position: ShockPositionInput,
  price: bigint,
  action: ShockOutcomeAction,
  liquidatedDebt = 0n,
  poolOffsetDebt = 0n,
  redistributedDebt = 0n,
): ShockPositionOutcome {
  return {
    positionId: position.id,
    liquidationOrder: position.liquidationOrder,
    icrRaw: computeCr(position.collateral, position.debt, price),
    action,
    liquidatedDebt,
    poolOffsetDebt,
    redistributedDebt,
  };
}

function appendRemainingOutcomes(
  outcomes: ShockPositionOutcome[],
  positions: readonly ShockPositionInput[],
  startIndex: number,
  price: bigint,
  action: "not-liquidatable" | "sequence-stopped",
): void {
  for (let index = startIndex; index < positions.length - 1; index++) {
    outcomes.push(makeOutcome(positions[index]!, price, action));
  }
  if (positions.length > 0) {
    outcomes.push(makeOutcome(positions[positions.length - 1]!, price, "protected-last-position"));
  }
}

function simulateLiquityV1Run(
  input: LiquityV1SimulationInput,
  shockedPrice: bigint,
  startingPoolDebt: bigint,
): ShockSimulationRun {
  if (input.positions.length === 0) throw new Error("Liquity V1 simulation needs at least one active position");
  let remainingPoolDebt = startingPoolDebt;
  let entireSystemDebt = input.protocolDebt;
  let entireSystemCollateral = input.protocolCollateral;
  let recoveryMode = computeCr(entireSystemCollateral, entireSystemDebt, shockedPrice) < input.ccr;
  const recoveryModeAtStart = recoveryMode;
  let liquidatableDebt = 0n;
  let poolOffsetDebt = 0n;
  let redistributedDebt = 0n;
  const outcomes: ShockPositionOutcome[] = [];

  for (let index = 0; index < input.positions.length - 1; index++) {
    const position = input.positions[index]!;
    const icr = computeCr(position.collateral, position.debt, shockedPrice);

    if (!recoveryMode) {
      if (icr >= input.mcr) {
        appendRemainingOutcomes(outcomes, input.positions, index, shockedPrice, "not-liquidatable");
        break;
      }

      const offset = min(position.debt, remainingPoolDebt);
      const redistributed = position.debt - offset;
      liquidatableDebt += position.debt;
      poolOffsetDebt += offset;
      redistributedDebt += redistributed;
      remainingPoolDebt -= offset;
      outcomes.push(
        makeOutcome(position, shockedPrice, "offset-and-redistribute", position.debt, offset, redistributed),
      );
      continue;
    }

    if (icr >= input.mcr && remainingPoolDebt === 0n) {
      appendRemainingOutcomes(outcomes, input.positions, index, shockedPrice, "sequence-stopped");
      break;
    }

    const currentTcr = computeCr(entireSystemCollateral, entireSystemDebt, shockedPrice);
    let action: ShockOutcomeAction;
    let offset = 0n;
    let redistributed = 0n;
    let collateralSentToPool = 0n;
    let collateralSurplus = 0n;

    if (icr <= WAD) {
      action = "redistribute-only";
      redistributed = position.debt;
    } else if (icr < input.mcr) {
      action = "offset-and-redistribute";
      offset = min(position.debt, remainingPoolDebt);
      redistributed = position.debt - offset;
      const collateralToLiquidate = position.collateral - position.collateral / V1_COLL_GAS_DIVISOR;
      collateralSentToPool = (collateralToLiquidate * offset) / position.debt;
    } else if (icr < currentTcr && position.debt <= remainingPoolDebt) {
      action = "capped-full-offset";
      offset = position.debt;
      const collateralToOffset = (position.debt * input.mcr) / shockedPrice;
      const collateralGasCompensation = collateralToOffset / V1_COLL_GAS_DIVISOR;
      collateralSentToPool = collateralToOffset - collateralGasCompensation;
      collateralSurplus = position.collateral - collateralToOffset;
    } else {
      outcomes.push(makeOutcome(position, shockedPrice, "skipped-insufficient-full-offset"));
      continue;
    }

    liquidatableDebt += position.debt;
    poolOffsetDebt += offset;
    redistributedDebt += redistributed;
    remainingPoolDebt -= offset;
    entireSystemDebt -= offset;
    entireSystemCollateral -= collateralSentToPool + collateralSurplus;
    outcomes.push(makeOutcome(position, shockedPrice, action, position.debt, offset, redistributed));

    recoveryMode = computeCr(entireSystemCollateral, entireSystemDebt, shockedPrice) < input.ccr;
  }

  if (outcomes.length === 0 || outcomes[outcomes.length - 1]!.action !== "protected-last-position") {
    const handled = new Set(outcomes.map((outcome) => outcome.positionId));
    for (const position of input.positions) {
      if (!handled.has(position.id)) {
        outcomes.push(
          makeOutcome(
            position,
            shockedPrice,
            position.liquidationOrder === input.positions.length - 1 ? "protected-last-position" : "not-liquidatable",
          ),
        );
      }
    }
  }

  return {
    callerBatchPositionIds: null,
    startingPoolDebt,
    liquidatableDebt,
    poolOffsetDebt,
    redistributedDebt,
    endingPoolDebt: remainingPoolDebt,
    recoveryModeAtStart,
    recoveryModeAtEnd: recoveryMode,
    outcomes,
  };
}

export function simulateLiquityV1Scenario(
  input: LiquityV1SimulationInput,
  shockFractionPpm: number,
): ShockScenarioResult {
  const shockedPrice = shockPrice(input.price, shockFractionPpm);
  const unlimitedPool = input.positions.reduce((sum, position) => sum + position.debt, 0n);
  const unlimited = simulateLiquityV1Run(input, shockedPrice, unlimitedPool);
  const actualPool = input.stabilityPoolDeposits;
  const actual = simulateLiquityV1Run(input, shockedPrice, actualPool);
  return {
    shockFractionPpm,
    shockedPrice,
    unlimited,
    actual,
    coverageRatio: formatRatio(actual.poolOffsetDebt, unlimited.liquidatableDebt),
  };
}

function simulateLiquityV2Run(
  input: LiquityV2SimulationInput,
  shockedPrice: bigint,
  startingPoolDebt: bigint,
  callerBatchPositionIds: readonly string[],
): ShockSimulationRun {
  let remainingPoolDebt = startingPoolDebt;
  let liquidatableDebt = 0n;
  let poolOffsetDebt = 0n;
  let redistributedDebt = 0n;
  const outcomes: ShockPositionOutcome[] = [];
  const callerBatch = new Set(callerBatchPositionIds);

  for (const position of input.positions) {
    const icr = computeCr(position.collateral, position.debt, shockedPrice);
    if (icr >= input.mcr) {
      outcomes.push(makeOutcome(position, shockedPrice, "not-liquidatable"));
      continue;
    }
    if (!callerBatch.has(position.id)) {
      outcomes.push(makeOutcome(position, shockedPrice, "protected-last-position"));
      continue;
    }

    const offset = min(position.debt, remainingPoolDebt);
    const redistributed = position.debt - offset;
    remainingPoolDebt -= offset;
    liquidatableDebt += position.debt;
    poolOffsetDebt += offset;
    redistributedDebt += redistributed;
    outcomes.push(makeOutcome(position, shockedPrice, "offset-and-redistribute", position.debt, offset, redistributed));
  }

  return {
    callerBatchPositionIds,
    startingPoolDebt,
    liquidatableDebt,
    poolOffsetDebt,
    redistributedDebt,
    endingPoolDebt: remainingPoolDebt,
    // Liquity V2 has no V1-style Recovery Mode liquidation branch. Falling
    // below CCR affects borrowing, not this MCR-only batch state machine.
    recoveryModeAtStart: false,
    recoveryModeAtEnd: false,
    outcomes,
  };
}

export function simulateLiquityV2Scenario(
  input: LiquityV2SimulationInput,
  shockFractionPpm: number,
): ShockScenarioResult {
  const shockedPrice = shockPrice(input.price, shockFractionPpm);
  const liquidatablePositions = input.positions.filter(
    (position) => computeCr(position.collateral, position.debt, shockedPrice) < input.mcr,
  );
  // A caller that submitted every eligible Trove would revert atomically when
  // _closeTrove reaches OnlyOneTroveLeft. Omit the final eligible Trove only
  // when no ineligible Trove already survives, and journal that exact array.
  const callerBatchPositionIds = (
    liquidatablePositions.length === input.positions.length ? liquidatablePositions.slice(0, -1) : liquidatablePositions
  ).map((position) => position.id);
  const unlimitedPool = input.positions.reduce((sum, position) => sum + position.debt, 0n);
  const unlimited = simulateLiquityV2Run(input, shockedPrice, unlimitedPool, callerBatchPositionIds);
  const availableAfterReserve =
    input.stabilityPoolDeposits > V2_MIN_BOLD_IN_SP ? input.stabilityPoolDeposits - V2_MIN_BOLD_IN_SP : 0n;
  const actualPool = min(availableAfterReserve, input.protocolDebt);
  const actual = simulateLiquityV2Run(input, shockedPrice, actualPool, callerBatchPositionIds);
  return {
    shockFractionPpm,
    shockedPrice,
    unlimited,
    actual,
    coverageRatio: formatRatio(actual.poolOffsetDebt, unlimited.liquidatableDebt),
  };
}

export interface AggregatedShockScenario {
  shockFractionPpm: number;
  liquidatableDebt: bigint;
  poolOffsetDebt: bigint;
  redistributedDebt: bigint;
  coverageRatio: number;
}

export function aggregateShockScenarios(
  branchScenarios: readonly (readonly ShockScenarioResult[])[],
): AggregatedShockScenario[] {
  if (branchScenarios.length === 0) throw new Error("Cannot aggregate an empty branch set");
  const scenarioCount = branchScenarios[0]!.length;
  if (branchScenarios.some((scenarios) => scenarios.length !== scenarioCount)) {
    throw new Error("All branches must contain the same scenario count");
  }

  return Array.from({ length: scenarioCount }, (_, scenarioIndex) => {
    const shockFractionPpm = branchScenarios[0]![scenarioIndex]!.shockFractionPpm;
    if (branchScenarios.some((scenarios) => scenarios[scenarioIndex]!.shockFractionPpm !== shockFractionPpm)) {
      throw new Error(`Branch shock mismatch at scenario ${scenarioIndex}`);
    }
    const liquidatableDebt = branchScenarios.reduce(
      (sum, scenarios) => sum + scenarios[scenarioIndex]!.unlimited.liquidatableDebt,
      0n,
    );
    const poolOffsetDebt = branchScenarios.reduce(
      (sum, scenarios) => sum + scenarios[scenarioIndex]!.actual.poolOffsetDebt,
      0n,
    );
    const redistributedDebt = branchScenarios.reduce(
      (sum, scenarios) => sum + scenarios[scenarioIndex]!.actual.redistributedDebt,
      0n,
    );
    return {
      shockFractionPpm,
      liquidatableDebt,
      poolOffsetDebt,
      redistributedDebt,
      coverageRatio: formatRatio(poolOffsetDebt, liquidatableDebt),
    };
  });
}
