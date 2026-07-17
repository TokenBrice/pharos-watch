import { decodeAddressWord, decodeUintWord, normalizeAddress, type PinnedBlock } from "../core";
import type { ShockCallJournal, ShockCodeSpec, ShockEthCallSpec } from "../shock-journal";
import {
  buildMeasuredFacts,
  deltaPpm,
  isWithinDeltaPpm,
  requireCodePinCoverage,
  requirePass,
  serialiseAggregateScenario,
  serialiseScenario,
  type PassCheck,
} from "../shock-producer";
import { aggregateShockScenarios, simulateLiquityV1Scenario, type ShockPositionInput } from "../shock-simulator";
import {
  DEBT_RECONCILIATION_TOLERANCE_PPM,
  SCORE_SHOCK_FRACTION_PPM,
  SHOCK_FRACTIONS_PPM,
  type LiquityV1ShockCoverageTarget,
} from "../shock-targets";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

async function readUint(
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

async function readAddress(caller: ShockCallJournal, spec: ShockEthCallSpec): Promise<string> {
  const data = await caller.call(spec);
  const value = normalizeAddress(decodeAddressWord(data, spec.name), spec.name);
  caller.recordDecoded(value);
  return value;
}

async function captureCodes(caller: ShockCallJournal, specs: readonly ShockCodeSpec[]) {
  const pins = [];
  for (const spec of specs) pins.push(await caller.captureCode(spec));
  return pins;
}

export async function measureLiquityV1ShockCoverage(
  caller: ShockCallJournal,
  target: LiquityV1ShockCoverageTarget,
  block: PinnedBlock,
  rpcUrl: string,
) {
  const checks: PassCheck[] = [];
  const { token, troveManager, stabilityPool, priceFeed, borrowerOperations, gasPool, collSurplusPool } =
    target.contracts;

  const derivedTroveManager = await readAddress(caller, {
    name: "token.troveManagerAddress",
    role: "graph",
    to: token,
    signature: "troveManagerAddress()",
    selector: "0x5a4d28bb",
  });
  requirePass(
    checks,
    "graph.trove-manager",
    derivedTroveManager === troveManager,
    `token TroveManager ${derivedTroveManager} matches pinned ${troveManager}`,
  );
  const derivedStabilityPool = await readAddress(caller, {
    name: "token.stabilityPoolAddress",
    role: "graph",
    to: token,
    signature: "stabilityPoolAddress()",
    selector: "0x0b622ab2",
  });
  requirePass(
    checks,
    "graph.stability-pool",
    derivedStabilityPool === stabilityPool,
    `token StabilityPool ${derivedStabilityPool} matches pinned ${stabilityPool}`,
  );
  const derivedPriceFeed = await readAddress(caller, {
    name: "troveManager.priceFeed",
    role: "graph",
    to: troveManager,
    signature: "priceFeed()",
    selector: "0x741bef1a",
  });
  requirePass(
    checks,
    "graph.price-feed",
    derivedPriceFeed === priceFeed,
    `TroveManager PriceFeed ${derivedPriceFeed} matches pinned ${priceFeed}`,
  );

  const sortedTroves = await readAddress(caller, {
    name: "troveManager.sortedTroves",
    role: "graph",
    to: troveManager,
    signature: "sortedTroves()",
    selector: "0xae918754",
  });
  const activePool = await readAddress(caller, {
    name: "troveManager.activePool",
    role: "graph",
    to: troveManager,
    signature: "activePool()",
    selector: "0x7f7dde4a",
  });
  const defaultPool = await readAddress(caller, {
    name: "troveManager.defaultPool",
    role: "graph",
    to: troveManager,
    signature: "defaultPool()",
    selector: "0x3cc74225",
  });
  const derivedBorrowerOperations = await readAddress(caller, {
    name: "troveManager.borrowerOperationsAddress",
    role: "graph",
    to: troveManager,
    signature: "borrowerOperationsAddress()",
    selector: "0xb7f8cf9b",
  });
  requirePass(
    checks,
    "graph.borrower-operations",
    derivedBorrowerOperations === borrowerOperations,
    `TroveManager BorrowerOperations ${derivedBorrowerOperations} matches pinned ${borrowerOperations}`,
  );
  const derivedLusdToken = await readAddress(caller, {
    name: "troveManager.lusdToken",
    role: "graph",
    to: troveManager,
    signature: "lusdToken()",
    selector: "0xb83f91a2",
  });
  requirePass(
    checks,
    "graph.lusd-token",
    derivedLusdToken === token,
    `TroveManager LUSD token ${derivedLusdToken} matches pinned ${token}`,
  );
  const surplusPoolTroveManager = await readAddress(caller, {
    name: "collSurplusPool.troveManagerAddress",
    role: "graph",
    to: collSurplusPool,
    signature: "troveManagerAddress()",
    selector: "0x5a4d28bb",
  });
  const surplusPoolActivePool = await readAddress(caller, {
    name: "collSurplusPool.activePoolAddress",
    role: "graph",
    to: collSurplusPool,
    signature: "activePoolAddress()",
    selector: "0xb08bc722",
  });
  requirePass(
    checks,
    "graph.coll-surplus-pool",
    surplusPoolTroveManager === troveManager && surplusPoolActivePool === activePool,
    `CollSurplusPool links TroveManager ${surplusPoolTroveManager} and ActivePool ${surplusPoolActivePool}`,
  );
  const priceAggregator = await readAddress(caller, {
    name: "priceFeed.priceAggregator",
    role: "oracle-graph",
    to: priceFeed,
    signature: "priceAggregator()",
    selector: "0x3078fff5",
  });
  const tellorCaller = await readAddress(caller, {
    name: "priceFeed.tellorCaller",
    role: "oracle-graph",
    to: priceFeed,
    signature: "tellorCaller()",
    selector: "0x7c61e3bf",
  });
  const priceAggregatorImplementation = await readAddress(caller, {
    name: "priceAggregator.aggregator",
    role: "oracle-graph",
    to: priceAggregator,
    signature: "aggregator()",
    selector: "0x245a7bfc",
  });
  const tellorOracle = await readAddress(caller, {
    name: "tellorCaller.tellor",
    role: "oracle-graph",
    to: tellorCaller,
    signature: "tellor()",
    selector: "0x1959ad5b",
  });

  const price = await readUint(caller, {
    name: "priceFeed.fetchPrice",
    role: "state",
    to: priceFeed,
    signature: "fetchPrice()",
    selector: "0x0fdb11cf",
  });
  const protocolCollateral = await readUint(caller, {
    name: "troveManager.getEntireSystemColl",
    role: "state",
    to: troveManager,
    signature: "getEntireSystemColl()",
    selector: "0x887105d3",
  });
  const protocolDebt = await readUint(caller, {
    name: "troveManager.getEntireSystemDebt",
    role: "state",
    to: troveManager,
    signature: "getEntireSystemDebt()",
    selector: "0x795d26c3",
  });
  const stabilityPoolDeposits = await readUint(caller, {
    name: "stabilityPool.getTotalLUSDDeposits",
    role: "state",
    to: stabilityPool,
    signature: "getTotalLUSDDeposits()",
    selector: "0x9bf2f1ac",
  });
  const mcr = await readUint(caller, {
    name: "troveManager.MCR",
    role: "parameter",
    to: troveManager,
    signature: "MCR()",
    selector: "0x794e5724",
  });
  const ccr = await readUint(caller, {
    name: "troveManager.CCR",
    role: "parameter",
    to: troveManager,
    signature: "CCR()",
    selector: "0x5733d58f",
  });
  const currentRecoveryModeRaw = await readUint(caller, {
    name: "troveManager.checkRecoveryMode",
    role: "state",
    to: troveManager,
    signature: "checkRecoveryMode(uint256)",
    selector: "0x4e443d9e",
    args: [price],
  });
  requirePass(
    checks,
    "state.recovery-mode-boolean",
    currentRecoveryModeRaw === 0n || currentRecoveryModeRaw === 1n,
    `checkRecoveryMode returned canonical boolean word ${currentRecoveryModeRaw}`,
  );
  requirePass(
    checks,
    "parameters.valid",
    price > 0n && protocolDebt > 0n && protocolCollateral > 0n && mcr > 10n ** 18n && ccr > mcr,
    `positive price/totals with MCR ${mcr} and CCR ${ccr}`,
  );

  const positionCount = Number(
    await readUint(caller, {
      name: "troveManager.getTroveOwnersCount",
      role: "enumeration",
      to: troveManager,
      signature: "getTroveOwnersCount()",
      selector: "0x49eefeee",
    }),
  );
  requirePass(
    checks,
    "enumeration.count-bounded",
    positionCount >= 1 && positionCount <= target.maxPositionsPerBranch,
    `TroveOwners count ${positionCount} is within [1, ${target.maxPositionsPerBranch}]`,
  );
  const sortedSize = Number(
    await readUint(caller, {
      name: "sortedTroves.getSize",
      role: "liquidation-order",
      to: sortedTroves,
      signature: "getSize()",
      selector: "0xde8fa431",
    }),
  );
  requirePass(
    checks,
    "enumeration.sorted-size",
    sortedSize === positionCount,
    `SortedTroves size ${sortedSize} equals TroveOwners count ${positionCount}`,
  );
  const first = await readAddress(caller, {
    name: "sortedTroves.getFirst",
    role: "liquidation-order",
    to: sortedTroves,
    signature: "getFirst()",
    selector: "0x1e223143",
  });
  const last = await readAddress(caller, {
    name: "sortedTroves.getLast",
    role: "liquidation-order",
    to: sortedTroves,
    signature: "getLast()",
    selector: "0x4d622831",
  });

  const ownerSpecs: ShockEthCallSpec[] = Array.from({ length: positionCount }, (_, index) => ({
    name: `troveManager.owner[${index}]`,
    role: "enumeration",
    to: troveManager,
    signature: "getTroveFromTroveOwnersArray(uint256)",
    selector: "0xd9a72444",
    args: [BigInt(index)],
  }));
  const ownerReturns = await caller.batch(ownerSpecs);
  const owners = ownerReturns.map((data, index) =>
    normalizeAddress(decodeAddressWord(data, `owner[${index}]`), `owner[${index}]`),
  );
  caller.recordBatchDecoded(owners);
  requirePass(
    checks,
    "enumeration.owner-set-unique",
    new Set(owners).size === positionCount,
    `all ${positionCount} TroveOwners are unique`,
  );

  const positionSpecs: ShockEthCallSpec[] = owners.map((owner, index) => ({
    name: `troveManager.position[${index}]`,
    role: "position-input",
    to: troveManager,
    signature: "getEntireDebtAndColl(address)",
    selector: "0xb91af97c",
    args: [BigInt(owner)],
  }));
  const positionReturns = await caller.batch(positionSpecs);
  const positionByOwner = new Map<
    string,
    { arrayIndex: number; debt: bigint; collateral: bigint; pendingDebt: bigint; pendingCollateral: bigint }
  >();
  const positionDecodes = positionReturns.map((data, index) => {
    const debt = decodeUintWord(data, 0, `position[${index}].debt`);
    const collateral = decodeUintWord(data, 1, `position[${index}].collateral`);
    const pendingDebt = decodeUintWord(data, 2, `position[${index}].pendingDebt`);
    const pendingCollateral = decodeUintWord(data, 3, `position[${index}].pendingCollateral`);
    positionByOwner.set(owners[index]!, { arrayIndex: index, debt, collateral, pendingDebt, pendingCollateral });
    return `debt=${debt} collateral=${collateral} pendingDebt=${pendingDebt} pendingCollateral=${pendingCollateral}`;
  });
  caller.recordBatchDecoded(positionDecodes);

  const prevSpecs: ShockEthCallSpec[] = owners.map((owner, index) => ({
    name: `sortedTroves.prev[${index}]`,
    role: "liquidation-order",
    to: sortedTroves,
    signature: "getPrev(address)",
    selector: "0xb72703ac",
    args: [BigInt(owner)],
  }));
  const prevReturns = await caller.batch(prevSpecs);
  const previousByOwner = new Map<string, string>();
  const previous = prevReturns.map((data, index) => {
    const value = decodeAddressWord(data, `prev[${index}]`).toLowerCase();
    previousByOwner.set(owners[index]!, value);
    return value;
  });
  caller.recordBatchDecoded(previous);

  const liquidationOrder: string[] = [];
  const visited = new Set<string>();
  let cursor = last;
  while (cursor !== ZERO_ADDRESS) {
    if (visited.has(cursor)) throw new Error(`SortedTroves cycle at ${cursor}`);
    if (!positionByOwner.has(cursor)) throw new Error(`SortedTroves contains unenumerated owner ${cursor}`);
    liquidationOrder.push(cursor);
    visited.add(cursor);
    cursor = previousByOwner.get(cursor) ?? ZERO_ADDRESS;
  }
  requirePass(
    checks,
    "enumeration.sorted-order-complete",
    liquidationOrder.length === positionCount && liquidationOrder[liquidationOrder.length - 1] === first,
    `tail-to-head traversal covers ${liquidationOrder.length}/${positionCount} positions and terminates at getFirst`,
  );

  const simulationPositions: ShockPositionInput[] = liquidationOrder.map((owner, index) => {
    const position = positionByOwner.get(owner)!;
    requirePass(
      checks,
      `position[${index}].positive`,
      position.debt > 0n && position.collateral > 0n,
      `position ${owner} has positive pending-inclusive debt and collateral`,
    );
    return {
      id: owner,
      debt: position.debt,
      collateral: position.collateral,
      pendingDebt: position.pendingDebt,
      pendingCollateral: position.pendingCollateral,
      status: "active",
      liquidationOrder: index,
    };
  });
  const positionDebt = simulationPositions.reduce((sum, position) => sum + position.debt, 0n);
  const positionCollateral = simulationPositions.reduce((sum, position) => sum + position.collateral, 0n);
  const debtDeltaPpm = deltaPpm(positionDebt, protocolDebt);
  const collateralDeltaPpm = deltaPpm(positionCollateral, protocolCollateral);
  requirePass(
    checks,
    "reconciliation.debt",
    isWithinDeltaPpm(positionDebt, protocolDebt, DEBT_RECONCILIATION_TOLERANCE_PPM),
    `position debt ${positionDebt} differs from protocol debt ${protocolDebt} by ${debtDeltaPpm} ppm (max ${DEBT_RECONCILIATION_TOLERANCE_PPM})`,
  );
  requirePass(
    checks,
    "reconciliation.collateral",
    isWithinDeltaPpm(positionCollateral, protocolCollateral, DEBT_RECONCILIATION_TOLERANCE_PPM),
    `position collateral ${positionCollateral} differs from protocol collateral ${protocolCollateral} by ${collateralDeltaPpm} ppm`,
  );

  const scenarios = SHOCK_FRACTIONS_PPM.map((shockFractionPpm) =>
    simulateLiquityV1Scenario(
      {
        price,
        mcr,
        ccr,
        protocolDebt,
        protocolCollateral,
        stabilityPoolDeposits,
        positions: simulationPositions,
      },
      shockFractionPpm,
    ),
  );
  const aggregateScenarios = aggregateShockScenarios([scenarios]);
  const measuredFacts = buildMeasuredFacts(aggregateScenarios, [{ branchIndex: 0, scenarios }]);
  requirePass(
    checks,
    "scenario.score-bearing-present",
    measuredFacts.stressShockFraction === SCORE_SHOCK_FRACTION_PPM / 1_000_000,
    `score-bearing shock is exactly ${SCORE_SHOCK_FRACTION_PPM} ppm`,
  );

  const codeSpecs: ShockCodeSpec[] = [
    { name: "lusd-token", role: "token", address: token },
    { name: "trove-manager", role: "liquidation-state-machine", address: troveManager },
    { name: "stability-pool", role: "committed-pool", address: stabilityPool },
    { name: "price-feed", role: "protocol-oracle", address: priceFeed },
    { name: "sorted-troves", role: "liquidation-order", address: sortedTroves },
    { name: "active-pool", role: "protocol-accounting", address: activePool },
    { name: "default-pool", role: "redistribution-accounting", address: defaultPool },
    { name: "borrower-operations", role: "liquidation-state-cleanup", address: borrowerOperations },
    { name: "gas-pool", role: "liquidation-gas-compensation", address: gasPool },
    { name: "coll-surplus-pool", role: "liquidation-collateral-surplus", address: collSurplusPool },
    { name: "chainlink-price-aggregator", role: "oracle-source", address: priceAggregator },
    {
      name: "chainlink-price-aggregator-implementation",
      role: "oracle-source-implementation",
      address: priceAggregatorImplementation,
    },
    { name: "tellor-caller", role: "oracle-fallback", address: tellorCaller },
    { name: "tellor-oracle", role: "oracle-fallback-source", address: tellorOracle },
  ];
  const codePins = await captureCodes(caller, codeSpecs);
  requireCodePinCoverage(checks, codeSpecs, codePins);

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
    branches: [
      {
        branchIndex: 0,
        label: "LUSD/ETH",
        contracts: {
          token,
          troveManager,
          stabilityPool,
          priceFeed,
          sortedTroves,
          activePool,
          defaultPool,
          borrowerOperations,
          gasPool,
          collSurplusPool,
          priceAggregator,
          priceAggregatorImplementation,
          tellorCaller,
          tellorOracle,
        },
        parameters: {
          currentPriceRaw: price.toString(),
          mcrRaw: mcr.toString(),
          ccrRaw: ccr.toString(),
          currentRecoveryMode: currentRecoveryModeRaw === 1n,
          shutdownTime: null,
        },
        protocolTotals: {
          debtRaw: protocolDebt.toString(),
          collateralRaw: protocolCollateral.toString(),
          stabilityPoolDepositsRaw: stabilityPoolDeposits.toString(),
        },
        reconciliation: {
          positionDebtRaw: positionDebt.toString(),
          positionCollateralRaw: positionCollateral.toString(),
          debtDeltaPpm,
          collateralDeltaPpm,
        },
        positions: simulationPositions.map((position) => ({
          id: position.id,
          owner: position.id,
          arrayIndex: positionByOwner.get(position.id)!.arrayIndex,
          liquidationOrder: position.liquidationOrder,
          status: position.status,
          debtRaw: position.debt.toString(),
          collateralRaw: position.collateral.toString(),
          pendingDebtRaw: position.pendingDebt.toString(),
          pendingCollateralRaw: position.pendingCollateral.toString(),
        })),
        scenarios: scenarios.map(serialiseScenario),
      },
    ],
    aggregateScenarios: aggregateScenarios.map(serialiseAggregateScenario),
    measuredFacts,
    checks,
    sources: [...target.sources],
    tool: { name: "measure-cdp-shock-coverage", version: "1" },
  };
}
