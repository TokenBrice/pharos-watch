import { decodeAddressWord, decodeUintWord, normalizeAddress, type PinnedBlock } from "../core";
import type { ShockCallJournal, ShockCodeSpec, ShockEthCallSpec } from "../shock-journal";
import {
  buildCdpShockMeasurement,
  buildMeasuredFacts,
  deltaPpm,
  isWithinDeltaPpm,
  readAddress,
  readUint,
  requireCodePinCoverage,
  requirePass,
  serialiseScenario,
  type PassCheck,
} from "../shock-producer";
import { aggregateShockScenarios, simulateLiquityV2Scenario, type ShockPositionInput } from "../shock-simulator";
import {
  DEBT_RECONCILIATION_TOLERANCE_PPM,
  SCORE_SHOCK_FRACTION_PPM,
  SHOCK_FRACTIONS_PPM,
  type LiquityV2ShockCoverageTarget,
} from "../shock-targets";

const WAD = 10n ** 18n;

interface BranchGraph {
  configuredIndex: number;
  collateralSymbol: string;
  addressesRegistry: string;
  collateralToken: string;
  troveManager: string;
  stabilityPool: string;
  priceFeed: string;
  activePool: string;
  defaultPool: string;
  sortedTroves: string;
  borrowerOperations: string;
  troveNft: string;
  gasPool: string;
  collSurplusPool: string;
  boldToken: string;
  weth: string;
  collateralRegistry: string;
  interestRouter: string;
  mcr: bigint;
  ccr: bigint;
  scr: bigint;
  liquidationPenaltySp: bigint;
  liquidationPenaltyRedistribution: bigint;
}

function computeCr(collateral: bigint, debt: bigint, price: bigint): bigint {
  if (debt <= 0n) throw new Error("Cannot compute branch CR with non-positive debt");
  return (collateral * price) / debt;
}

async function readConfiguredBranchGraph(
  caller: ShockCallJournal,
  target: LiquityV2ShockCoverageTarget,
  configuredIndex: number,
): Promise<BranchGraph> {
  const configured = target.branches[configuredIndex]!;
  const to = configured.addressesRegistry;
  const troveManager = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].troveManager`,
    role: "graph",
    to,
    signature: "troveManager()",
    selector: "0x3d83908a",
  });
  const collateralToken = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].collToken`,
    role: "graph",
    to,
    signature: "collToken()",
    selector: "0x31b8c946",
  });
  const stabilityPool = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].stabilityPool`,
    role: "graph",
    to,
    signature: "stabilityPool()",
    selector: "0x048c661d",
  });
  const priceFeed = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].priceFeed`,
    role: "graph",
    to,
    signature: "priceFeed()",
    selector: "0x741bef1a",
  });
  const activePool = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].activePool`,
    role: "graph",
    to,
    signature: "activePool()",
    selector: "0x7f7dde4a",
  });
  const defaultPool = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].defaultPool`,
    role: "graph",
    to,
    signature: "defaultPool()",
    selector: "0x3cc74225",
  });
  const sortedTroves = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].sortedTroves`,
    role: "graph",
    to,
    signature: "sortedTroves()",
    selector: "0xae918754",
  });
  const borrowerOperations = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].borrowerOperations`,
    role: "graph",
    to,
    signature: "borrowerOperations()",
    selector: "0x77553ad4",
  });
  const troveNft = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].troveNFT`,
    role: "graph",
    to,
    signature: "troveNFT()",
    selector: "0x059e0113",
  });
  const gasPool = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].gasPoolAddress`,
    role: "graph",
    to,
    signature: "gasPoolAddress()",
    selector: "0xfe9d0323",
  });
  const collSurplusPool = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].collSurplusPool`,
    role: "graph",
    to,
    signature: "collSurplusPool()",
    selector: "0xcda775f9",
  });
  const boldToken = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].boldToken`,
    role: "graph",
    to,
    signature: "boldToken()",
    selector: "0x630afce5",
  });
  const weth = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].WETH`,
    role: "graph",
    to,
    signature: "WETH()",
    selector: "0xad5c4648",
  });
  const collateralRegistry = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].collateralRegistry`,
    role: "graph",
    to,
    signature: "collateralRegistry()",
    selector: "0xd330fadd",
  });
  const interestRouter = await readAddress(caller, {
    name: `addressesRegistry[${configuredIndex}].interestRouter`,
    role: "graph",
    to,
    signature: "interestRouter()",
    selector: "0xd0ee2ace",
  });
  const mcr = await readUint(caller, {
    name: `addressesRegistry[${configuredIndex}].MCR`,
    role: "parameter",
    to,
    signature: "MCR()",
    selector: "0x794e5724",
  });
  const ccr = await readUint(caller, {
    name: `addressesRegistry[${configuredIndex}].CCR`,
    role: "parameter",
    to,
    signature: "CCR()",
    selector: "0x5733d58f",
  });
  const scr = await readUint(caller, {
    name: `addressesRegistry[${configuredIndex}].SCR`,
    role: "parameter",
    to,
    signature: "SCR()",
    selector: "0x58d5a961",
  });
  const liquidationPenaltySp = await readUint(caller, {
    name: `addressesRegistry[${configuredIndex}].LIQUIDATION_PENALTY_SP`,
    role: "parameter",
    to,
    signature: "LIQUIDATION_PENALTY_SP()",
    selector: "0x370619be",
  });
  const liquidationPenaltyRedistribution = await readUint(caller, {
    name: `addressesRegistry[${configuredIndex}].LIQUIDATION_PENALTY_REDISTRIBUTION`,
    role: "parameter",
    to,
    signature: "LIQUIDATION_PENALTY_REDISTRIBUTION()",
    selector: "0x1170f2d4",
  });
  return {
    configuredIndex,
    collateralSymbol: configured.collateralSymbol,
    addressesRegistry: to,
    collateralToken,
    troveManager,
    stabilityPool,
    priceFeed,
    activePool,
    defaultPool,
    sortedTroves,
    borrowerOperations,
    troveNft,
    gasPool,
    collSurplusPool,
    boldToken,
    weth,
    collateralRegistry,
    interestRouter,
    mcr,
    ccr,
    scr,
    liquidationPenaltySp,
    liquidationPenaltyRedistribution,
  };
}

export async function measureLiquityV2ShockCoverage(
  caller: ShockCallJournal,
  target: LiquityV2ShockCoverageTarget,
  block: PinnedBlock,
  rpcUrl: string,
) {
  const checks: PassCheck[] = [];
  const { token, collateralRegistry } = target.contracts;
  const derivedRegistry = await readAddress(caller, {
    name: "token.collateralRegistryAddress",
    role: "graph",
    to: token,
    signature: "collateralRegistryAddress()",
    selector: "0x45a74626",
  });
  requirePass(
    checks,
    "graph.collateral-registry",
    derivedRegistry === collateralRegistry,
    `token CollateralRegistry ${derivedRegistry} matches pinned ${collateralRegistry}`,
  );
  const branchCount = Number(
    await readUint(caller, {
      name: "collateralRegistry.totalCollaterals",
      role: "enumeration",
      to: collateralRegistry,
      signature: "totalCollaterals()",
      selector: "0x30504b6f",
    }),
  );
  requirePass(
    checks,
    "branches.count",
    branchCount === target.branches.length && branchCount <= target.maxBranches,
    `registry branch count ${branchCount} equals pinned branch count ${target.branches.length}`,
  );

  const registryGraphSpecs: ShockEthCallSpec[] = Array.from({ length: branchCount }, (_, branchIndex) => [
    {
      name: `collateralRegistry.troveManager[${branchIndex}]`,
      role: "enumeration",
      to: collateralRegistry,
      signature: "getTroveManager(uint256)",
      selector: "0x0bc17feb",
      args: [BigInt(branchIndex)],
    },
    {
      name: `collateralRegistry.token[${branchIndex}]`,
      role: "enumeration",
      to: collateralRegistry,
      signature: "getToken(uint256)",
      selector: "0xe4b50cb8",
      args: [BigInt(branchIndex)],
    },
  ]).flat();
  const registryGraphReturns = await caller.batch(registryGraphSpecs);
  const registryBranches = Array.from({ length: branchCount }, (_, branchIndex) => ({
    branchIndex,
    troveManager: normalizeAddress(
      decodeAddressWord(registryGraphReturns[branchIndex * 2]!, `registry branch ${branchIndex} TroveManager`),
    ),
    collateralToken: normalizeAddress(
      decodeAddressWord(registryGraphReturns[branchIndex * 2 + 1]!, `registry branch ${branchIndex} token`),
    ),
  }));
  caller.recordBatchDecoded(registryBranches.flatMap((branch) => [branch.troveManager, branch.collateralToken]));

  const configuredGraphs: BranchGraph[] = [];
  for (let configuredIndex = 0; configuredIndex < target.branches.length; configuredIndex++) {
    configuredGraphs.push(await readConfiguredBranchGraph(caller, target, configuredIndex));
  }
  const graphByRegistryBranch = registryBranches.map((registryBranch) => {
    const graph = configuredGraphs.find(
      (candidate) =>
        candidate.troveManager === registryBranch.troveManager &&
        candidate.collateralToken === registryBranch.collateralToken,
    );
    if (!graph) {
      throw new Error(
        `Registry branch ${registryBranch.branchIndex} graph ${registryBranch.troveManager}/${registryBranch.collateralToken} is not pinned`,
      );
    }
    return graph;
  });
  requirePass(
    checks,
    "branches.graph-set",
    new Set(graphByRegistryBranch.map((graph) => graph.addressesRegistry)).size === branchCount,
    `all ${branchCount} registry branches map one-to-one to pinned AddressesRegistries`,
  );

  const branchOutputs = [];
  const branchScenarioSets = [];
  const codeSpecs: ShockCodeSpec[] = [
    { name: "bold-token", role: "token", address: token },
    { name: "collateral-registry", role: "branch-enumerator", address: collateralRegistry },
  ];

  for (let branchIndex = 0; branchIndex < branchCount; branchIndex++) {
    const graph = graphByRegistryBranch[branchIndex]!;
    requirePass(
      checks,
      `branch[${branchIndex}].parameters`,
      graph.mcr > WAD && graph.ccr > graph.mcr && graph.scr >= WAD,
      `${graph.collateralSymbol} MCR ${graph.mcr}, CCR ${graph.ccr}, SCR ${graph.scr} are pinned and valid`,
    );
    requirePass(
      checks,
      `branch[${branchIndex}].global-graph-cross-check`,
      graph.boldToken === token && graph.collateralRegistry === collateralRegistry,
      `${graph.collateralSymbol} registry links global BOLD ${graph.boldToken} and CollateralRegistry ${graph.collateralRegistry}`,
    );

    const crossCheckSpecs: ShockEthCallSpec[] = [
      {
        name: `troveManager[${branchIndex}].stabilityPool`,
        role: "graph",
        to: graph.troveManager,
        signature: "stabilityPool()",
        selector: "0x048c661d",
      },
      {
        name: `troveManager[${branchIndex}].sortedTroves`,
        role: "graph",
        to: graph.troveManager,
        signature: "sortedTroves()",
        selector: "0xae918754",
      },
      {
        name: `troveManager[${branchIndex}].borrowerOperations`,
        role: "graph",
        to: graph.troveManager,
        signature: "borrowerOperations()",
        selector: "0x77553ad4",
      },
      {
        name: `troveManager[${branchIndex}].activePool`,
        role: "graph",
        to: graph.troveManager,
        signature: "activePool()",
        selector: "0x7f7dde4a",
      },
    ];
    const crossCheckReturns = await caller.batch(crossCheckSpecs);
    const crossChecks = crossCheckReturns.map((data, index) =>
      normalizeAddress(decodeAddressWord(data, crossCheckSpecs[index]!.name), crossCheckSpecs[index]!.name),
    );
    caller.recordBatchDecoded(crossChecks);
    requirePass(
      checks,
      `branch[${branchIndex}].graph-cross-check`,
      crossChecks[0] === graph.stabilityPool &&
        crossChecks[1] === graph.sortedTroves &&
        crossChecks[2] === graph.borrowerOperations &&
        crossChecks[3] === graph.activePool,
      `${graph.collateralSymbol} TroveManager graph agrees with its AddressesRegistry`,
    );

    const ethUsdAggregator = await readAddress(caller, {
      name: `priceFeed[${branchIndex}].ethUsdOracle`,
      role: "oracle-graph",
      to: graph.priceFeed,
      signature: "ethUsdOracle()",
      selector: "0x8a97f9c9",
    });
    const ethUsdAggregatorImplementation = await readAddress(caller, {
      name: `ethUsdOracle[${branchIndex}].aggregator`,
      role: "oracle-graph",
      to: ethUsdAggregator,
      signature: "aggregator()",
      selector: "0x245a7bfc",
    });
    codeSpecs.push(
      {
        name: `eth-usd-oracle-${branchIndex}`,
        role: "oracle-source",
        address: ethUsdAggregator,
      },
      {
        name: `eth-usd-oracle-implementation-${branchIndex}`,
        role: "oracle-source-implementation",
        address: ethUsdAggregatorImplementation,
      },
    );

    let secondaryAggregator: string | null = null;
    let secondaryAggregatorImplementation: string | null = null;
    let rateProvider: string | null = null;
    if (graph.collateralSymbol === "wstETH" || graph.collateralSymbol === "rETH") {
      const secondaryOracleSignature = graph.collateralSymbol === "wstETH" ? "stEthUsdOracle()" : "rEthEthOracle()";
      const secondaryOracleSelector = graph.collateralSymbol === "wstETH" ? "0xd69e820d" : "0x03f04756";
      secondaryAggregator = await readAddress(caller, {
        name: `priceFeed[${branchIndex}].secondaryOracle`,
        role: "oracle-graph",
        to: graph.priceFeed,
        signature: secondaryOracleSignature,
        selector: secondaryOracleSelector,
      });
      secondaryAggregatorImplementation = await readAddress(caller, {
        name: `secondaryOracle[${branchIndex}].aggregator`,
        role: "oracle-graph",
        to: secondaryAggregator,
        signature: "aggregator()",
        selector: "0x245a7bfc",
      });
      rateProvider = await readAddress(caller, {
        name: `priceFeed[${branchIndex}].rateProviderAddress`,
        role: "oracle-graph",
        to: graph.priceFeed,
        signature: "rateProviderAddress()",
        selector: "0xe5aa1c40",
      });
      requirePass(
        checks,
        `branch[${branchIndex}].oracle-rate-provider`,
        rateProvider === graph.collateralToken,
        `${graph.collateralSymbol} canonical rate provider equals the pinned collateral token`,
      );
      codeSpecs.push(
        {
          name: `secondary-oracle-${branchIndex}`,
          role: "oracle-source",
          address: secondaryAggregator,
        },
        {
          name: `secondary-oracle-implementation-${branchIndex}`,
          role: "oracle-source-implementation",
          address: secondaryAggregatorImplementation,
        },
      );
    } else if (graph.collateralSymbol !== "WETH") {
      throw new Error(`Unsupported Liquity V2 oracle graph for ${graph.collateralSymbol}`);
    }

    const protocolCollateral = await readUint(caller, {
      name: `troveManager[${branchIndex}].getEntireBranchColl`,
      role: "state",
      to: graph.troveManager,
      signature: "getEntireBranchColl()",
      selector: "0x3ecaaa3f",
    });
    const protocolDebt = await readUint(caller, {
      name: `troveManager[${branchIndex}].getEntireBranchDebt`,
      role: "state",
      to: graph.troveManager,
      signature: "getEntireBranchDebt()",
      selector: "0x105b403b",
    });
    const stabilityPoolDeposits = await readUint(caller, {
      name: `stabilityPool[${branchIndex}].deposits`,
      role: "state",
      to: graph.stabilityPool,
      signature: target.spDeposits.signature,
      selector: target.spDeposits.selector,
    });
    const shutdownTime = await readUint(caller, {
      name: `troveManager[${branchIndex}].shutdownTime`,
      role: "state",
      to: graph.troveManager,
      signature: "shutdownTime()",
      selector: "0x58569081",
    });
    requirePass(
      checks,
      `branch[${branchIndex}].live`,
      shutdownTime === 0n,
      `${graph.collateralSymbol} shutdownTime is zero`,
    );
    const priceResult = await caller.call({
      name: `troveManager[${branchIndex}].getUnbackedPortionPriceAndRedeemability`,
      role: "state",
      to: graph.troveManager,
      signature: "getUnbackedPortionPriceAndRedeemability()",
      selector: "0x4ea15f37",
    });
    const unbackedDebt = decodeUintWord(priceResult, 0, `branch[${branchIndex}].unbackedDebt`);
    const price = decodeUintWord(priceResult, 1, `branch[${branchIndex}].price`);
    const redeemableRaw = decodeUintWord(priceResult, 2, `branch[${branchIndex}].redeemable`);
    const redeemable = redeemableRaw === 1n;
    caller.recordDecoded(`unbackedDebt=${unbackedDebt} price=${price} redeemable=${redeemable}`);
    requirePass(
      checks,
      `branch[${branchIndex}].price-and-redeemability-decode`,
      price > 0n && (redeemableRaw === 0n || redeemableRaw === 1n),
      `${graph.collateralSymbol} liquidation price is positive and redeemability is a canonical boolean`,
    );

    const positionCount = Number(
      await readUint(caller, {
        name: `troveManager[${branchIndex}].getTroveIdsCount`,
        role: "enumeration",
        to: graph.troveManager,
        signature: "getTroveIdsCount()",
        selector: "0x4aff96e1",
      }),
    );
    requirePass(
      checks,
      `branch[${branchIndex}].position-count`,
      positionCount >= 1 && positionCount <= target.maxPositionsPerBranch,
      `${graph.collateralSymbol} position count ${positionCount} is within bounds`,
    );
    const idSpecs: ShockEthCallSpec[] = Array.from({ length: positionCount }, (_, arrayIndex) => ({
      name: `troveManager[${branchIndex}].id[${arrayIndex}]`,
      role: "enumeration",
      to: graph.troveManager,
      signature: "getTroveFromTroveIdsArray(uint256)",
      selector: "0x1ef11b62",
      args: [BigInt(arrayIndex)],
    }));
    const idReturns = await caller.batch(idSpecs);
    const ids = idReturns.map((data, arrayIndex) =>
      decodeUintWord(data, 0, `branch[${branchIndex}].id[${arrayIndex}]`),
    );
    caller.recordBatchDecoded(ids.map(String));
    requirePass(
      checks,
      `branch[${branchIndex}].id-set-unique`,
      new Set(ids.map(String)).size === positionCount,
      `${graph.collateralSymbol} has ${positionCount} unique Trove IDs`,
    );

    const latestSpecs: ShockEthCallSpec[] = ids.map((id, arrayIndex) => ({
      name: `troveManager[${branchIndex}].latest[${arrayIndex}]`,
      role: "position-input",
      to: graph.troveManager,
      signature: "getLatestTroveData(uint256)",
      selector: "0xaad3f404",
      args: [id],
    }));
    const statusSpecs: ShockEthCallSpec[] = ids.map((id, arrayIndex) => ({
      name: `troveManager[${branchIndex}].status[${arrayIndex}]`,
      role: "position-input",
      to: graph.troveManager,
      signature: "getTroveStatus(uint256)",
      selector: "0xe47bfaf1",
      args: [id],
    }));
    const latestReturns = await caller.batch(latestSpecs);
    const latestRows = latestReturns.map((data, arrayIndex) => {
      const values = Array.from({ length: 10 }, (_, wordIndex) =>
        decodeUintWord(data, wordIndex, `branch[${branchIndex}].latest[${arrayIndex}][${wordIndex}]`),
      );
      return {
        entireDebt: values[0]!,
        entireCollateral: values[1]!,
        pendingDebt: values[2]!,
        pendingCollateral: values[3]!,
        accruedInterest: values[4]!,
        recordedDebt: values[5]!,
        annualInterestRate: values[6]!,
        weightedRecordedDebt: values[7]!,
        accruedBatchManagementFee: values[8]!,
        lastInterestRateAdjustmentTime: values[9]!,
      };
    });
    caller.recordBatchDecoded(
      latestRows.map(
        (row) =>
          `debt=${row.entireDebt} collateral=${row.entireCollateral} pendingDebt=${row.pendingDebt} pendingCollateral=${row.pendingCollateral} accruedInterest=${row.accruedInterest} recordedDebt=${row.recordedDebt} annualInterestRate=${row.annualInterestRate} weightedRecordedDebt=${row.weightedRecordedDebt} accruedBatchManagementFee=${row.accruedBatchManagementFee} lastInterestRateAdjustmentTime=${row.lastInterestRateAdjustmentTime}`,
      ),
    );
    const statusReturns = await caller.batch(statusSpecs);
    const statuses = statusReturns.map((data, arrayIndex) => {
      const value = decodeUintWord(data, 0, `branch[${branchIndex}].status[${arrayIndex}]`);
      if (value === 1n) return "active" as const;
      if (value === 4n) return "zombie" as const;
      throw new Error(`Branch ${branchIndex} Trove ${ids[arrayIndex]} has unsupported status ${value}`);
    });
    caller.recordBatchDecoded(statuses);

    const simulationPositions: ShockPositionInput[] = ids.map((id, arrayIndex) => {
      const row = latestRows[arrayIndex]!;
      requirePass(
        checks,
        `branch[${branchIndex}].position[${arrayIndex}].valid`,
        row.entireCollateral > 0n && (row.entireDebt > 0n || statuses[arrayIndex] === "zombie"),
        `Trove ${id} has positive collateral; zero debt is accepted only for a zombie and maps to infinite ICR`,
      );
      return {
        id: id.toString(),
        debt: row.entireDebt,
        collateral: row.entireCollateral,
        pendingDebt: row.pendingDebt,
        pendingCollateral: row.pendingCollateral,
        status: statuses[arrayIndex]!,
        liquidationOrder: arrayIndex,
      };
    });
    const positionDebt = simulationPositions.reduce((sum, position) => sum + position.debt, 0n);
    const positionCollateral = simulationPositions.reduce((sum, position) => sum + position.collateral, 0n);
    const debtDeltaPpm = deltaPpm(positionDebt, protocolDebt);
    const collateralDeltaPpm = deltaPpm(positionCollateral, protocolCollateral);
    requirePass(
      checks,
      `branch[${branchIndex}].reconciliation.debt`,
      isWithinDeltaPpm(positionDebt, protocolDebt, DEBT_RECONCILIATION_TOLERANCE_PPM),
      `${graph.collateralSymbol} position debt differs from protocol debt by ${debtDeltaPpm} ppm`,
    );
    requirePass(
      checks,
      `branch[${branchIndex}].reconciliation.collateral`,
      isWithinDeltaPpm(positionCollateral, protocolCollateral, DEBT_RECONCILIATION_TOLERANCE_PPM),
      `${graph.collateralSymbol} position collateral differs from protocol collateral by ${collateralDeltaPpm} ppm`,
    );

    const scenarios = SHOCK_FRACTIONS_PPM.map((shockFractionPpm) =>
      simulateLiquityV2Scenario(
        {
          price,
          mcr: graph.mcr,
          ccr: graph.ccr,
          protocolDebt,
          protocolCollateral,
          stabilityPoolDeposits,
          positions: simulationPositions,
        },
        shockFractionPpm,
      ),
    );
    branchScenarioSets.push({ branchIndex, scenarios });
    branchOutputs.push({
      branchIndex,
      label: graph.collateralSymbol,
      contracts: {
        collateralToken: graph.collateralToken,
        addressesRegistry: graph.addressesRegistry,
        troveManager: graph.troveManager,
        stabilityPool: graph.stabilityPool,
        priceFeed: graph.priceFeed,
        activePool: graph.activePool,
        defaultPool: graph.defaultPool,
        sortedTroves: graph.sortedTroves,
        borrowerOperations: graph.borrowerOperations,
        troveNft: graph.troveNft,
        gasPool: graph.gasPool,
        collSurplusPool: graph.collSurplusPool,
        boldToken: graph.boldToken,
        weth: graph.weth,
        collateralRegistry: graph.collateralRegistry,
        interestRouter: graph.interestRouter,
        ethUsdOracle: ethUsdAggregator,
        ethUsdOracleImplementation: ethUsdAggregatorImplementation,
        secondaryOracle: secondaryAggregator,
        secondaryOracleImplementation: secondaryAggregatorImplementation,
        rateProvider,
      },
      parameters: {
        currentPriceRaw: price.toString(),
        mcrRaw: graph.mcr.toString(),
        ccrRaw: graph.ccr.toString(),
        scrRaw: graph.scr.toString(),
        liquidationPenaltySpRaw: graph.liquidationPenaltySp.toString(),
        liquidationPenaltyRedistributionRaw: graph.liquidationPenaltyRedistribution.toString(),
        minimumBoldLeftInStabilityPoolRaw: WAD.toString(),
        currentRecoveryMode: false,
        currentBelowCriticalThreshold: computeCr(protocolCollateral, protocolDebt, price) < graph.ccr,
        shutdownTime: Number(shutdownTime),
        redeemable,
      },
      protocolTotals: {
        debtRaw: protocolDebt.toString(),
        collateralRaw: protocolCollateral.toString(),
        stabilityPoolDepositsRaw: stabilityPoolDeposits.toString(),
        unbackedDebtRaw: unbackedDebt.toString(),
      },
      reconciliation: {
        positionDebtRaw: positionDebt.toString(),
        positionCollateralRaw: positionCollateral.toString(),
        debtDeltaPpm,
        collateralDeltaPpm,
      },
      positions: simulationPositions.map((position, arrayIndex) => {
        const row = latestRows[arrayIndex]!;
        return {
          id: position.id,
          arrayIndex,
          liquidationOrder: position.liquidationOrder,
          status: position.status,
          debtRaw: position.debt.toString(),
          collateralRaw: position.collateral.toString(),
          pendingDebtRaw: position.pendingDebt.toString(),
          pendingCollateralRaw: position.pendingCollateral.toString(),
          accruedInterestRaw: row.accruedInterest.toString(),
          recordedDebtRaw: row.recordedDebt.toString(),
          annualInterestRateRaw: row.annualInterestRate.toString(),
          weightedRecordedDebtRaw: row.weightedRecordedDebt.toString(),
          accruedBatchManagementFeeRaw: row.accruedBatchManagementFee.toString(),
          lastInterestRateAdjustmentTime: Number(row.lastInterestRateAdjustmentTime),
        };
      }),
      scenarios: scenarios.map((scenario) => ({
        ...serialiseScenario(scenario),
        belowCriticalThresholdAtStart: computeCr(protocolCollateral, protocolDebt, scenario.shockedPrice) < graph.ccr,
      })),
    });

    codeSpecs.push(
      { name: `collateral-token-${branchIndex}`, role: "branch-collateral", address: graph.collateralToken },
      {
        name: `addresses-registry-${branchIndex}`,
        role: "parameter-and-graph-registry",
        address: graph.addressesRegistry,
      },
      { name: `trove-manager-${branchIndex}`, role: "liquidation-state-machine", address: graph.troveManager },
      { name: `stability-pool-${branchIndex}`, role: "branch-local-committed-pool", address: graph.stabilityPool },
      { name: `price-feed-${branchIndex}`, role: "protocol-oracle", address: graph.priceFeed },
      { name: `active-pool-${branchIndex}`, role: "protocol-accounting", address: graph.activePool },
      { name: `default-pool-${branchIndex}`, role: "redistribution-accounting", address: graph.defaultPool },
      { name: `sorted-troves-${branchIndex}`, role: "redemption-order", address: graph.sortedTroves },
      {
        name: `borrower-operations-${branchIndex}`,
        role: "liquidation-state-cleanup",
        address: graph.borrowerOperations,
      },
      { name: `trove-nft-${branchIndex}`, role: "liquidation-owner-lookup", address: graph.troveNft },
      { name: `gas-pool-${branchIndex}`, role: "liquidation-gas-compensation", address: graph.gasPool },
      {
        name: `coll-surplus-pool-${branchIndex}`,
        role: "liquidation-collateral-surplus",
        address: graph.collSurplusPool,
      },
      { name: `weth-${branchIndex}`, role: "liquidation-gas-compensation-token", address: graph.weth },
      { name: `interest-router-${branchIndex}`, role: "liquidation-interest-minting", address: graph.interestRouter },
    );
  }

  const aggregateScenarios = aggregateShockScenarios(branchScenarioSets.map((branch) => branch.scenarios));
  const measuredFacts = buildMeasuredFacts(aggregateScenarios, branchScenarioSets);
  requirePass(
    checks,
    "scenario.score-bearing-present",
    measuredFacts.stressShockFraction === SCORE_SHOCK_FRACTION_PPM / 1_000_000,
    `score-bearing shock is exactly ${SCORE_SHOCK_FRACTION_PPM} ppm`,
  );
  const codePins = await caller.captureCodes(codeSpecs);
  requireCodePinCoverage(checks, codeSpecs, codePins);

  return buildCdpShockMeasurement({
    caller,
    target,
    block,
    rpcUrl,
    codePins,
    branches: branchOutputs,
    aggregateScenarios,
    measuredFacts,
    checks,
  });
}
