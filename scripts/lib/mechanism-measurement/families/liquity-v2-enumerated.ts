import {
  decodeAddressWord,
  decodeUintWord,
  normalizeAddress,
  ratioToRounded,
  relativeDeltaPct,
  requireCheck,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { EnumeratedLiquityV2MeasurementEvidence } from "../schema";
import type { EnumeratedLiquityV2MeasurementTarget } from "../targets";
import { buildMeasuredMetrics, buildMeasurementCompleteness } from "../evidence-envelope";
import { LIQUITY_V2_CALLS, readLiquityV2Branch } from "./liquity-v2";

const WAD = 10n ** 18n;

export async function measureEnumeratedLiquityV2(
  caller: EthCallJournal,
  target: EnumeratedLiquityV2MeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<EnumeratedLiquityV2MeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const healthWarnings: string[] = [];
  const registry = normalizeAddress(target.contracts.collateralRegistry, "configured registry");

  if (target.contracts.deriveRegistryFromToken) {
    const derivedRegistry = decodeAddressWord(
      await caller.call({
        name: "token.collateralRegistryAddress",
        to: target.contracts.token,
        ...LIQUITY_V2_CALLS.collateralRegistryAddress,
      }),
      "collateralRegistryAddress",
    );
    caller.recordDecoded(derivedRegistry);
    requireCheck(
      checks,
      "graph.collateralRegistry",
      derivedRegistry === registry,
      `token registry ${derivedRegistry} matches configured registry`,
    );
  }

  const totalSupplyRaw = decodeUintWord(
    await caller.call({
      name: "token.totalSupply",
      to: target.contracts.token,
      ...LIQUITY_V2_CALLS.totalSupply,
    }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  requireCheck(checks, "supply.positive", totalSupplyRaw > 0n, `token supply ${totalSupplyRaw} is positive`);

  const branchCountRaw = decodeUintWord(
    await caller.call({
      name: "registry.totalCollaterals",
      to: registry,
      ...LIQUITY_V2_CALLS.totalCollaterals,
    }),
    0,
    "totalCollaterals",
  );
  const branchCount = Number(branchCountRaw);
  caller.recordDecoded(String(branchCount));
  requireCheck(
    checks,
    "branches.count",
    branchCount === target.branches.length && branchCount > 0 && branchCount <= target.sanity.maxBranches,
    `registry count ${branchCount} equals ${target.branches.length} configured branches`,
  );

  const branches: EnumeratedLiquityV2MeasurementEvidence["derived"]["branches"] = [];
  let totalCollateralValueWad = 0n;
  let totalDebtWad = 0n;
  let spDepositsWad = 0n;
  let branchCappedWad = 0n;
  const seenControllers = new Set<string>();

  for (let index = 0; index < branchCount; index += 1) {
    const expected = target.branches[index]!;
    const controllerReturn = await caller.call({
      name: `registry.controller(${index})`,
      to: registry,
      signature: target.controllerEnumerator.signature,
      selector: target.controllerEnumerator.selector,
      args: [BigInt(index)],
    });
    const controller = decodeAddressWord(controllerReturn, `controller ${index}`);
    caller.recordDecoded(controller);
    requireCheck(
      checks,
      `branch[${index}].controller`,
      controller === normalizeAddress(expected.controller),
      `controller ${controller} matches configured branch`,
    );
    requireCheck(
      checks,
      `branch[${index}].controller-unique`,
      !seenControllers.has(controller),
      `controller ${controller} appears once`,
    );
    seenControllers.add(controller);

    const collateralToken = decodeAddressWord(
      await caller.call({
        name: `registry.getToken(${index})`,
        to: registry,
        ...LIQUITY_V2_CALLS.getToken,
        args: [BigInt(index)],
      }),
      `getToken ${index}`,
    );
    caller.recordDecoded(collateralToken);
    requireCheck(
      checks,
      `branch[${index}].collateral-token`,
      collateralToken === normalizeAddress(expected.collateralToken),
      `collateral token ${collateralToken} matches configured branch`,
    );

    let activePool: string | undefined;
    const {
      collateral: collateralRaw,
      debt: debtRaw,
      price: priceRaw,
      redeemable,
      shutdownTime,
      spDeposits: spDepositsRaw,
      stabilityPool,
    } = await readLiquityV2Branch({
      afterDebt: async (branchDebt) => {
        if (!expected.activePool) return;
        activePool = decodeAddressWord(
          await caller.call({
            name: `controller[${index}].activePool`,
            to: controller,
            ...LIQUITY_V2_CALLS.activePool,
          }),
          `branch ${index} activePool`,
        );
        caller.recordDecoded(activePool);
        requireCheck(
          checks,
          `branch[${index}].active-pool`,
          activePool === normalizeAddress(expected.activePool),
          `active pool ${activePool} matches configured graph`,
        );
        const activePoolDebt = decodeUintWord(
          await caller.call({
            name: `activePool[${index}].getBoldDebt`,
            to: activePool,
            ...LIQUITY_V2_CALLS.getBoldDebt,
          }),
          0,
          `branch ${index} active pool debt`,
        );
        caller.recordDecoded(activePoolDebt.toString());
        requireCheck(
          checks,
          `branch[${index}].active-pool-debt`,
          activePoolDebt === branchDebt,
          `ActivePool debt ${activePoolDebt} equals controller debt`,
        );
      },
      caller,
      controller,
      depositsCall: target.spDeposits,
      labels: {
        collateral: `branch ${index} collateral`,
        debt: `branch ${index} debt`,
        deposits: `branch ${index} Stability Pool deposits`,
        price: `branch ${index} price`,
        redeemable: `branch ${index} redeemable`,
        shutdownTime: `branch ${index} shutdownTime`,
        stabilityPool: `branch ${index} stabilityPool`,
      },
      names: {
        collateral: `controller[${index}].getEntireBranchColl`,
        debt: `controller[${index}].getEntireBranchDebt`,
        deposits: `stabilityPool[${index}].deposits`,
        priceAndRedeemability: `controller[${index}].priceAndRedeemability`,
        shutdownTime: `controller[${index}].shutdownTime`,
        stabilityPool: `controller[${index}].stabilityPool`,
      },
    });
    requireCheck(
      checks,
      `branch[${index}].positive-state`,
      collateralRaw > 0n && debtRaw > 0n,
      `collateral ${collateralRaw} and debt ${debtRaw} are positive`,
    );
    requireCheck(checks, `branch[${index}].price-positive`, priceRaw > 0n, `protocol price ${priceRaw} is positive`);

    if (shutdownTime !== 0 || !redeemable) {
      checks.push({
        id: `branch[${index}].health-state-captured`,
        status: "pass",
        detail: `retained unhealthy state: shutdownTime=${shutdownTime}, redeemable=${redeemable}`,
      });
    }
    if (shutdownTime !== 0) healthWarnings.push(`Branch ${index} is shut down at timestamp ${shutdownTime}.`);
    if (!redeemable) healthWarnings.push(`Branch ${index} protocol oracle marks the branch non-redeemable.`);

    const collateralValueWad =
      (collateralRaw * priceRaw * WAD) /
      (10n ** BigInt(expected.collateralDecimals) * 10n ** BigInt(expected.priceDecimals));
    const debtWad = (debtRaw * WAD) / 10n ** BigInt(expected.debtDecimals);
    const depositsWad = (spDepositsRaw * WAD) / 10n ** BigInt(expected.debtDecimals);
    totalCollateralValueWad += collateralValueWad;
    totalDebtWad += debtWad;
    spDepositsWad += depositsWad;
    branchCappedWad += depositsWad < debtWad ? depositsWad : debtWad;

    branches.push({
      index,
      collateralToken,
      troveManager: controller,
      stabilityPool,
      collateral: collateralRaw.toString(),
      debt: debtRaw.toString(),
      spDeposits: spDepositsRaw.toString(),
      priceWei: priceRaw.toString(),
      priceUsd: ratioToRounded(priceRaw, 10n ** BigInt(expected.priceDecimals), 8),
      collateralDecimals: expected.collateralDecimals,
      debtDecimals: expected.debtDecimals,
      priceDecimals: expected.priceDecimals,
      ...(activePool ? { activePool } : {}),
      redeemable,
      shutdownTime,
    });
  }

  requireCheck(checks, "debt.positive", totalDebtWad > 0n, `total debt ${totalDebtWad} is positive`);
  const totalSupplyWad = totalSupplyRaw;
  const supplyDebtDivergencePct = Math.abs(relativeDeltaPct(totalDebtWad, totalSupplyWad));
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    supplyDebtDivergencePct <= target.sanity.maxSupplyDebtDivergencePct,
    `debt/supply divergence ${supplyDebtDivergencePct.toFixed(6)}% is within ${target.sanity.maxSupplyDebtDivergencePct}%`,
  );

  const collateralizationRatio = ratioToRounded(totalCollateralValueWad, totalDebtWad);
  const liquidationCapacityRatio = ratioToRounded(spDepositsWad, totalSupplyWad);
  const branchCappedLiquidationCapacityRatio = ratioToRounded(branchCappedWad, totalDebtWad);

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "liquity-v2-enumerated-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    metrics: buildMeasuredMetrics({
      collateralizationRatio,
      liquidationCapacityRatio,
    }),
    completeness: buildMeasurementCompleteness(),
    ...(healthWarnings.length > 0 ? { warnings: healthWarnings } : {}),
    derived: {
      registry,
      branches,
      totalCollateralValueWad: totalCollateralValueWad.toString(),
      totalDebtWad: totalDebtWad.toString(),
      spDepositsWad: spDepositsWad.toString(),
      totalSupplyWad: totalSupplyWad.toString(),
      supplyDebtDivergencePct: Math.round(supplyDebtDivergencePct * 1_000_000) / 1_000_000,
      branchCappedLiquidationCapacityRatio,
    },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
