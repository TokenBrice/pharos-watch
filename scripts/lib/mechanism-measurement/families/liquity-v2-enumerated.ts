import {
  decodeAddressWord,
  decodeBoolWord,
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
        signature: "collateralRegistryAddress()",
        selector: "0x45a74626",
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
      signature: "totalSupply()",
      selector: "0x18160ddd",
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
      signature: "totalCollaterals()",
      selector: "0x30504b6f",
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
        signature: "getToken(uint256)",
        selector: "0xe4b50cb8",
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

    const collateralRaw = decodeUintWord(
      await caller.call({
        name: `controller[${index}].getEntireBranchColl`,
        to: controller,
        signature: "getEntireBranchColl()",
        selector: "0x3ecaaa3f",
      }),
      0,
      `branch ${index} collateral`,
    );
    caller.recordDecoded(collateralRaw.toString());
    const debtRaw = decodeUintWord(
      await caller.call({
        name: `controller[${index}].getEntireBranchDebt`,
        to: controller,
        signature: "getEntireBranchDebt()",
        selector: "0x105b403b",
      }),
      0,
      `branch ${index} debt`,
    );
    caller.recordDecoded(debtRaw.toString());
    requireCheck(
      checks,
      `branch[${index}].positive-state`,
      collateralRaw > 0n && debtRaw > 0n,
      `collateral ${collateralRaw} and debt ${debtRaw} are positive`,
    );

    let activePool: string | undefined;
    if (expected.activePool) {
      activePool = decodeAddressWord(
        await caller.call({
          name: `controller[${index}].activePool`,
          to: controller,
          signature: "activePool()",
          selector: "0x7f7dde4a",
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
          signature: "getBoldDebt()",
          selector: "0x45507998",
        }),
        0,
        `branch ${index} active pool debt`,
      );
      caller.recordDecoded(activePoolDebt.toString());
      requireCheck(
        checks,
        `branch[${index}].active-pool-debt`,
        activePoolDebt === debtRaw,
        `ActivePool debt ${activePoolDebt} equals controller debt`,
      );
    }

    const stabilityPool = decodeAddressWord(
      await caller.call({
        name: `controller[${index}].stabilityPool`,
        to: controller,
        signature: "stabilityPool()",
        selector: "0x048c661d",
      }),
      `branch ${index} stabilityPool`,
    );
    caller.recordDecoded(stabilityPool);
    const spDepositsRaw = decodeUintWord(
      await caller.call({
        name: `stabilityPool[${index}].deposits`,
        to: stabilityPool,
        signature: target.spDeposits.signature,
        selector: target.spDeposits.selector,
      }),
      0,
      `branch ${index} Stability Pool deposits`,
    );
    caller.recordDecoded(spDepositsRaw.toString());

    const shutdownTime = Number(
      decodeUintWord(
        await caller.call({
          name: `controller[${index}].shutdownTime`,
          to: controller,
          signature: "shutdownTime()",
          selector: "0x58569081",
        }),
        0,
        `branch ${index} shutdownTime`,
      ),
    );
    caller.recordDecoded(String(shutdownTime));

    const priceReturn = await caller.call({
      name: `controller[${index}].priceAndRedeemability`,
      to: controller,
      signature: "getUnbackedPortionPriceAndRedeemability()",
      selector: "0x4ea15f37",
    });
    const priceRaw = decodeUintWord(priceReturn, 1, `branch ${index} price`);
    const redeemable = decodeBoolWord(priceReturn, 2, `branch ${index} redeemable`);
    caller.recordDecoded(`price=${priceRaw} redeemable=${redeemable}`);
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
    metrics: {
      collateralizationRatio,
      liquidationCapacityRatio,
      applicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "measured" },
      },
    },
    completeness: { complete: true, blockers: [] },
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
