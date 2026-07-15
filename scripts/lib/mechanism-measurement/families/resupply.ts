import { decodeAbiParameters } from "viem/utils";
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
import type { ResupplyMeasurementEvidence } from "../schema";
import type { ResupplyMeasurementTarget } from "../targets";

export async function measureResupply(
  caller: EthCallJournal,
  target: ResupplyMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<ResupplyMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const token = normalizeAddress(target.contracts.token);
  const registry = normalizeAddress(target.contracts.registry);

  const tokenCore = decodeAddressWord(
    await caller.call({ name: "token.core", to: token, signature: "core()", selector: "0xf2f4eb26" }),
    "token core",
  );
  caller.recordDecoded(tokenCore);
  const registryCore = decodeAddressWord(
    await caller.call({ name: "registry.core", to: registry, signature: "core()", selector: "0xf2f4eb26" }),
    "registry core",
  );
  caller.recordDecoded(registryCore);
  requireCheck(checks, "graph.core", registryCore === tokenCore, `registry and token share core ${tokenCore}`);
  const registryToken = decodeAddressWord(
    await caller.call({ name: "registry.token", to: registry, signature: "token()", selector: "0xfc0c546a" }),
    "registry token",
  );
  caller.recordDecoded(registryToken);
  requireCheck(checks, "graph.token", registryToken === token, `registry token ${registryToken} matches reUSD`);

  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  requireCheck(checks, "supply.positive", totalSupplyRaw > 0n, `reUSD supply ${totalSupplyRaw} is positive`);

  const rawPairs = await caller.call({
    name: "registry.getAllPairAddresses",
    to: registry,
    signature: "getAllPairAddresses()",
    selector: "0x607b6d16",
  });
  const [decodedPairs] = decodeAbiParameters([{ type: "address[]" }], rawPairs as `0x${string}`);
  const pairAddresses = decodedPairs.map((address) => normalizeAddress(address));
  caller.recordDecoded(`count=${pairAddresses.length}`);
  const registeredLength = Number(
    decodeUintWord(
      await caller.call({
        name: "registry.registeredPairsLength",
        to: registry,
        signature: "registeredPairsLength()",
        selector: "0x23103b7d",
      }),
      0,
      "registeredPairsLength",
    ),
  );
  caller.recordDecoded(String(registeredLength));
  requireCheck(
    checks,
    "pairs.count",
    pairAddresses.length > 0 && pairAddresses.length <= target.maxPairs && registeredLength === pairAddresses.length,
    `registry array and length getter both report ${pairAddresses.length} pairs`,
  );
  requireCheck(
    checks,
    "pairs.unique",
    new Set(pairAddresses).size === pairAddresses.length,
    "every registered pair address is unique",
  );

  const insurancePool = decodeAddressWord(
    await caller.call({
      name: "registry.insurancePool",
      to: registry,
      signature: "insurancePool()",
      selector: "0xab2adc00",
    }),
    "insurancePool",
  );
  caller.recordDecoded(insurancePool);
  requireCheck(
    checks,
    "graph.insurance-pool",
    insurancePool === normalizeAddress(target.contracts.expectedInsurancePool),
    `registry insurance pool ${insurancePool} matches config`,
  );
  const liquidationHandler = decodeAddressWord(
    await caller.call({
      name: "registry.liquidationHandler",
      to: registry,
      signature: "liquidationHandler()",
      selector: "0xd25adeb3",
    }),
    "liquidationHandler",
  );
  caller.recordDecoded(liquidationHandler);
  requireCheck(
    checks,
    "graph.liquidation-handler",
    liquidationHandler === normalizeAddress(target.contracts.expectedLiquidationHandler),
    `registry liquidation handler ${liquidationHandler} matches config`,
  );
  const handlerInsurancePool = decodeAddressWord(
    await caller.call({
      name: "liquidationHandler.insurancePool",
      to: liquidationHandler,
      signature: "insurancePool()",
      selector: "0xab2adc00",
    }),
    "handler insurancePool",
  );
  caller.recordDecoded(handlerInsurancePool);
  requireCheck(
    checks,
    "graph.handler-insurance-pool",
    handlerInsurancePool === insurancePool,
    "liquidation handler points to the registered InsurancePool",
  );
  const handlerRegistry = decodeAddressWord(
    await caller.call({
      name: "liquidationHandler.registry",
      to: liquidationHandler,
      signature: "registry()",
      selector: "0x7b103999",
    }),
    "handler registry",
  );
  caller.recordDecoded(handlerRegistry);
  requireCheck(
    checks,
    "graph.handler-registry",
    handlerRegistry === registry,
    "liquidation handler points to registry",
  );

  const allowedUnderlyings = new Set(target.allowedUnderlyings.map((address) => normalizeAddress(address)));
  const pairs: ResupplyMeasurementEvidence["derived"]["pairs"] = [];
  const warnings = [
    "Collateral is valued as the protocol's ERC-4626 claim on crvUSD/frxUSD lending markets; this is layered par-value accounting, not proof of immediate underlying liquidity.",
  ];
  let totalDebtRaw = 0n;
  let totalCollateralAssetsRaw = 0n;
  for (let index = 0; index < pairAddresses.length; index += 1) {
    const address = pairAddresses[index]!;
    const underlying = decodeAddressWord(
      await caller.call({
        name: `pair[${index}].underlying`,
        to: address,
        signature: "underlying()",
        selector: "0x6f307dc3",
      }),
      `pair ${index} underlying`,
    );
    caller.recordDecoded(underlying);
    requireCheck(
      checks,
      `pair[${index}].underlying`,
      allowedUnderlyings.has(underlying),
      `underlying ${underlying} is in the reviewed crvUSD/frxUSD set`,
    );
    const accountingRaw = await caller.call({
      name: `pair[${index}].getPairAccounting`,
      to: address,
      signature: "getPairAccounting()",
      selector: "0xcdd72d52",
    });
    const [, totalBorrowRaw, , totalCollateralSharesRaw] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }],
      accountingRaw as `0x${string}`,
    );
    caller.recordDecoded(`borrow=${totalBorrowRaw} collateralShares=${totalCollateralSharesRaw}`);
    requireCheck(
      checks,
      `pair[${index}].state-readable`,
      totalBorrowRaw === 0n || totalCollateralSharesRaw > 0n,
      `positive debt ${totalBorrowRaw} has positive collateral shares ${totalCollateralSharesRaw}`,
    );
    const collateral = decodeAddressWord(
      await caller.call({
        name: `pair[${index}].collateral`,
        to: address,
        signature: "collateral()",
        selector: "0xd8dfeb45",
      }),
      `pair ${index} collateral`,
    );
    caller.recordDecoded(collateral);
    const convertedRaw = decodeUintWord(
      await caller.call({
        name: `collateral[${index}].convertToAssets`,
        to: collateral,
        signature: "convertToAssets(uint256)",
        selector: "0x07a2d13a",
        args: [totalCollateralSharesRaw],
      }),
      0,
      `pair ${index} converted collateral`,
    );
    caller.recordDecoded(convertedRaw.toString());
    if (totalBorrowRaw > 0n) {
      requireCheck(
        checks,
        `pair[${index}].converted-collateral-positive`,
        convertedRaw > 0n,
        `converted collateral ${convertedRaw} is positive`,
      );
    } else if (convertedRaw > 0n) {
      warnings.push(
        `Registered pair ${address} has zero debt; its ${convertedRaw} converted collateral assets are excluded from system CR.`,
      );
    }
    totalDebtRaw += totalBorrowRaw;
    if (totalBorrowRaw > 0n) totalCollateralAssetsRaw += convertedRaw;
    pairs.push({
      address,
      underlying,
      collateral,
      totalBorrowRaw: totalBorrowRaw.toString(),
      totalCollateralSharesRaw: totalCollateralSharesRaw.toString(),
      totalCollateralAssetsRaw: convertedRaw.toString(),
      active: totalBorrowRaw > 0n,
    });
  }

  const supplyDebtDivergencePct = Math.abs(relativeDeltaPct(totalDebtRaw, totalSupplyRaw));
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    supplyDebtDivergencePct <= target.maxSupplyDebtDivergencePct,
    `registered pair debt diverges ${supplyDebtDivergencePct.toFixed(6)}% from token supply`,
  );
  const insuranceAssetsRaw = decodeUintWord(
    await caller.call({
      name: "insurancePool.totalAssets",
      to: insurancePool,
      signature: "totalAssets()",
      selector: "0x01e1d114",
    }),
    0,
    "insurancePool totalAssets",
  );
  caller.recordDecoded(insuranceAssetsRaw.toString());
  const insuranceBalanceRaw = decodeUintWord(
    await caller.call({
      name: "token.balanceOf(insurancePool)",
      to: token,
      signature: "balanceOf(address)",
      selector: "0x70a08231",
      args: [BigInt(insurancePool)],
    }),
    0,
    "insurance pool token balance",
  );
  caller.recordDecoded(insuranceBalanceRaw.toString());
  requireCheck(
    checks,
    "insurance.assets-vs-balance",
    insuranceAssetsRaw > 0n && insuranceAssetsRaw === insuranceBalanceRaw,
    `InsurancePool assets exactly equal held reUSD (${insuranceAssetsRaw})`,
  );
  const withdrawTime = decodeUintWord(
    await caller.call({
      name: "insurancePool.withdrawTime",
      to: insurancePool,
      signature: "withdrawTime()",
      selector: "0x45cb3dde",
    }),
    0,
    "withdrawTime",
  );
  caller.recordDecoded(withdrawTime.toString());
  const withdrawTimeLimit = decodeUintWord(
    await caller.call({
      name: "insurancePool.withdrawTimeLimit",
      to: insurancePool,
      signature: "withdrawTimeLimit()",
      selector: "0x4f04a86b",
    }),
    0,
    "withdrawTimeLimit",
  );
  caller.recordDecoded(withdrawTimeLimit.toString());
  requireCheck(
    checks,
    "insurance.withdrawal-lock",
    withdrawTime > 0n && withdrawTimeLimit > 0n,
    `withdraw cooldown ${withdrawTime}s and claim window ${withdrawTimeLimit}s are positive`,
  );

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "resupply-pairs-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    metrics: {
      collateralizationRatio: ratioToRounded(totalCollateralAssetsRaw, totalDebtRaw),
      liquidationCapacityRatio: ratioToRounded(insuranceAssetsRaw, totalDebtRaw),
      applicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "measured" },
      },
    },
    completeness: { complete: true, blockers: [] },
    warnings,
    derived: {
      token,
      registry,
      insurancePool,
      liquidationHandler,
      totalSupplyRaw: totalSupplyRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      totalCollateralAssetsRaw: totalCollateralAssetsRaw.toString(),
      insuranceAssetsRaw: insuranceAssetsRaw.toString(),
      pairCount: pairs.length,
      supplyDebtDivergencePct: Math.round(supplyDebtDivergencePct * 1_000_000) / 1_000_000,
      pairs,
    },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
