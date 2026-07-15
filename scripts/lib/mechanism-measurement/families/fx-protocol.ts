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
import type { FxProtocolMeasurementEvidence } from "../schema";
import type { FxProtocolMeasurementTarget } from "../targets";

export async function measureFxProtocol(
  caller: EthCallJournal,
  target: FxProtocolMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<FxProtocolMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const healthWarnings: string[] = [];
  const token = normalizeAddress(target.contracts.token);
  const configuredManager = normalizeAddress(target.contracts.poolManager);
  const configuredFxBase = normalizeAddress(target.contracts.fxBase);

  requireCheck(
    checks,
    "registration.range",
    target.registrationFromBlock <= block.number,
    `PoolManager deployment block ${target.registrationFromBlock} is not after pinned block ${block.number}`,
  );
  const registrationLogs = await caller.queryLogs({
    name: "poolManager.RegisterPool history",
    address: configuredManager,
    fromBlock: target.registrationFromBlock,
    toBlock: block.number,
    topics: [target.registrationTopic],
  });
  const registeredPools = registrationLogs.map((log, index) => {
    if (log.topics.length !== 2 || log.topics[0] !== target.registrationTopic || log.data !== "0x") {
      throw new Error(`RegisterPool log ${index} has an unexpected ABI shape`);
    }
    return normalizeAddress(`0x${log.topics[1]!.slice(-40)}`, `RegisterPool log ${index}`);
  });
  caller.recordLogsDecoded(`registeredPools=${registeredPools.join(",")}`);
  const uniqueRegisteredPools = new Set(registeredPools);
  const configuredPools = new Set(target.pools.map((pool) => normalizeAddress(pool.address)));
  requireCheck(
    checks,
    "registration.pool-set",
    uniqueRegisteredPools.size === registeredPools.length &&
      uniqueRegisteredPools.size === configuredPools.size &&
      [...uniqueRegisteredPools].every((pool) => configuredPools.has(pool)),
    `add-only RegisterPool history contains exactly the ${configuredPools.size} configured pools`,
  );

  const poolManager = decodeAddressWord(
    await caller.call({ name: "token.poolManager", to: token, signature: "poolManager()", selector: "0xdc4c90d3" }),
    "poolManager",
  );
  caller.recordDecoded(poolManager);
  requireCheck(
    checks,
    "graph.pool-manager",
    poolManager === configuredManager,
    `token manager ${poolManager} matches config`,
  );
  const fxBase = decodeAddressWord(
    await caller.call({ name: "poolManager.fxBASE", to: poolManager, signature: "fxBASE()", selector: "0x9d8c2910" }),
    "fxBASE",
  );
  caller.recordDecoded(fxBase);
  requireCheck(checks, "graph.fx-base", fxBase === configuredFxBase, `manager fxBASE ${fxBase} matches config`);

  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  const legacySupplyRaw = decodeUintWord(
    await caller.call({
      name: "token.legacyTotalSupply",
      to: token,
      signature: "legacyTotalSupply()",
      selector: "0x80b17407",
    }),
    0,
    "legacyTotalSupply",
  );
  caller.recordDecoded(legacySupplyRaw.toString());
  requireCheck(checks, "supply.positive", totalSupplyRaw > 0n, `fxUSD supply ${totalSupplyRaw} is positive`);

  const pools: FxProtocolMeasurementEvidence["derived"]["pools"] = [];
  let totalDebtRaw = 0n;
  let totalCollateralValueWad = 0n;
  const seenPools = new Set<string>();
  for (let index = 0; index < target.pools.length; index += 1) {
    const configured = target.pools[index]!;
    const address = normalizeAddress(configured.address);
    requireCheck(checks, `pool[${index}].unique`, !seenPools.has(address), `pool ${address} appears once`);
    seenPools.add(address);

    const managerInfo = await caller.call({
      name: `poolManager.getPoolInfo(${index})`,
      to: poolManager,
      signature: "getPoolInfo(address)",
      selector: "0x06bfa938",
      args: [BigInt(address)],
    });
    const managedRawCollateral = decodeUintWord(managerInfo, 2, `pool ${index} managed raw collateral`);
    const managedDebt = decodeUintWord(managerInfo, 4, `pool ${index} managed debt`);
    caller.recordDecoded(`rawCollateral=${managedRawCollateral} debt=${managedDebt}`);

    const collateralToken = decodeAddressWord(
      await caller.call({
        name: `pool[${index}].collateralToken`,
        to: address,
        signature: "collateralToken()",
        selector: "0xb2016bd4",
      }),
      `pool ${index} collateral token`,
    );
    caller.recordDecoded(collateralToken);
    requireCheck(
      checks,
      `pool[${index}].collateral-token`,
      collateralToken === normalizeAddress(configured.collateralToken),
      `collateral token ${collateralToken} matches config`,
    );
    const priceOracle = decodeAddressWord(
      await caller.call({
        name: `pool[${index}].priceOracle`,
        to: address,
        signature: "priceOracle()",
        selector: "0x2630c12f",
      }),
      `pool ${index} price oracle`,
    );
    caller.recordDecoded(priceOracle);
    requireCheck(
      checks,
      `pool[${index}].price-oracle`,
      priceOracle === normalizeAddress(configured.priceOracle),
      `price oracle ${priceOracle} matches config`,
    );

    const collateralRaw = decodeUintWord(
      await caller.call({
        name: `pool[${index}].getTotalRawCollaterals`,
        to: address,
        signature: "getTotalRawCollaterals()",
        selector: "0xee65a03c",
      }),
      0,
      `pool ${index} collateral`,
    );
    caller.recordDecoded(collateralRaw.toString());
    const debtRaw = decodeUintWord(
      await caller.call({
        name: `pool[${index}].getTotalRawDebts`,
        to: address,
        signature: "getTotalRawDebts()",
        selector: "0xf9d45fd2",
      }),
      0,
      `pool ${index} debt`,
    );
    caller.recordDecoded(debtRaw.toString());
    requireCheck(
      checks,
      `pool[${index}].positive-state`,
      collateralRaw > 0n && debtRaw > 0n,
      `collateral ${collateralRaw} and debt ${debtRaw} are positive`,
    );
    requireCheck(
      checks,
      `pool[${index}].manager-accounting`,
      Math.abs(relativeDeltaPct(managedRawCollateral, collateralRaw)) <= 0.5 &&
        Math.abs(relativeDeltaPct(managedDebt, debtRaw)) <= 0.5,
      `PoolManager raw collateral/debt agree within 0.5% (collateral delta ${relativeDeltaPct(managedRawCollateral, collateralRaw).toFixed(6)}%, debt delta ${relativeDeltaPct(managedDebt, debtRaw).toFixed(6)}%)`,
    );

    const priceReturn = await caller.call({
      name: `oracle[${index}].getPrice`,
      to: priceOracle,
      signature: "getPrice()",
      selector: "0x98d5fdca",
    });
    const anchorPriceRaw = decodeUintWord(priceReturn, 0, `pool ${index} anchor price`);
    caller.recordDecoded(
      `anchor=${anchorPriceRaw} min=${decodeUintWord(priceReturn, 1, `pool ${index} min price`)} max=${decodeUintWord(priceReturn, 2, `pool ${index} max price`)}`,
    );
    requireCheck(
      checks,
      `pool[${index}].price-positive`,
      anchorPriceRaw > 0n,
      `oracle anchor ${anchorPriceRaw} is positive`,
    );

    const borrowPaused = decodeBoolWord(
      await caller.call({
        name: `pool[${index}].isBorrowPaused`,
        to: address,
        signature: "isBorrowPaused()",
        selector: "0x70f3c4b1",
      }),
      0,
      `pool ${index} borrow paused`,
    );
    caller.recordDecoded(String(borrowPaused));
    const redeemPaused = decodeBoolWord(
      await caller.call({
        name: `pool[${index}].isRedeemPaused`,
        to: address,
        signature: "isRedeemPaused()",
        selector: "0x3cd9b53c",
      }),
      0,
      `pool ${index} redeem paused`,
    );
    caller.recordDecoded(String(redeemPaused));
    if (borrowPaused) healthWarnings.push(`Pool ${index} borrowing is paused.`);
    if (redeemPaused) healthWarnings.push(`Pool ${index} redemption is paused.`);

    totalDebtRaw += debtRaw;
    totalCollateralValueWad += (collateralRaw * anchorPriceRaw) / 10n ** 18n;
    pools.push({
      address,
      collateralToken,
      priceOracle,
      collateralRaw: collateralRaw.toString(),
      debtRaw: debtRaw.toString(),
      anchorPriceRaw: anchorPriceRaw.toString(),
      borrowPaused,
      redeemPaused,
    });
  }

  const supplyDebtDivergencePct = Math.abs(relativeDeltaPct(totalDebtRaw + legacySupplyRaw, totalSupplyRaw));
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    supplyDebtDivergencePct <= target.maxSupplyDebtDivergencePct,
    `configured pool debt plus legacy supply diverges ${supplyDebtDivergencePct.toFixed(6)}% from total supply`,
  );

  const fxBaseStableRaw = decodeUintWord(
    await caller.call({
      name: "fxBase.totalStableToken",
      to: fxBase,
      signature: "totalStableToken()",
      selector: "0x9ff39038",
    }),
    0,
    "fxBASE stable token",
  );
  caller.recordDecoded(fxBaseStableRaw.toString());
  const fxBaseYieldRaw = decodeUintWord(
    await caller.call({
      name: "fxBase.totalYieldToken",
      to: fxBase,
      signature: "totalYieldToken()",
      selector: "0x65d2cb08",
    }),
    0,
    "fxBASE yield token",
  );
  caller.recordDecoded(fxBaseYieldRaw.toString());
  const fxBaseShareSupplyRaw = decodeUintWord(
    await caller.call({ name: "fxBase.totalSupply", to: fxBase, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "fxBASE share supply",
  );
  caller.recordDecoded(fxBaseShareSupplyRaw.toString());
  const fxBaseNavRaw = decodeUintWord(
    await caller.call({ name: "fxBase.nav", to: fxBase, signature: "nav()", selector: "0xc1590cd7" }),
    0,
    "fxBASE nav",
  );
  caller.recordDecoded(fxBaseNavRaw.toString());

  const committedCapacityRaw = fxBaseYieldRaw + fxBaseStableRaw * 10n ** 12n;
  const navCapacityRaw = (fxBaseShareSupplyRaw * fxBaseNavRaw) / 10n ** 18n;
  const capacityDeltaPct = Math.abs(relativeDeltaPct(committedCapacityRaw, navCapacityRaw));
  requireCheck(
    checks,
    "derivation.fx-base-capacity",
    committedCapacityRaw > 0n && capacityDeltaPct <= 1,
    `token inventory and share NAV capacity agree within ${capacityDeltaPct.toFixed(6)}%`,
  );

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "fx-protocol-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    logQueries: caller.logQueries,
    metrics: {
      collateralizationRatio: ratioToRounded(totalCollateralValueWad, totalSupplyRaw),
      liquidationCapacityRatio: ratioToRounded(committedCapacityRaw, totalSupplyRaw),
      applicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "measured" },
      },
    },
    completeness: { complete: true, blockers: [] },
    ...(healthWarnings.length > 0 ? { warnings: healthWarnings } : {}),
    derived: {
      token,
      poolManager,
      fxBase,
      totalSupplyRaw: totalSupplyRaw.toString(),
      legacySupplyRaw: legacySupplyRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      totalCollateralValueWad: totalCollateralValueWad.toString(),
      fxBaseStableRaw: fxBaseStableRaw.toString(),
      fxBaseYieldRaw: fxBaseYieldRaw.toString(),
      fxBaseShareSupplyRaw: fxBaseShareSupplyRaw.toString(),
      fxBaseNavRaw: fxBaseNavRaw.toString(),
      registeredPools,
      pools,
    },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
