import {
  decodeAddressWord,
  decodeUintWord,
  relativeDeltaPct,
  requireCheck,
  wadToRounded,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { LiquityV2MeasurementTarget } from "../targets";
import type { LiquityV2MeasurementEvidence } from "../schema";

const WAD = 10n ** 18n;

interface BranchReading {
  index: number;
  collateralToken: string;
  troveManager: string;
  stabilityPool: string;
  collateral: bigint;
  debt: bigint;
  spDeposits: bigint;
  priceWei: bigint;
  redeemable: boolean;
  shutdownTime: number;
}

/**
 * Measures Liquity-V2-family (multi-branch) system metrics at a pinned block:
 * system collateralization (sum of branch collateral valued at each branch's
 * protocol price over total debt) and liquidation capacity (Stability Pool
 * deposits over token supply), plus the branch-capped capacity that respects
 * branch isolation. The branch price comes from the TroveManager's own
 * getUnbackedPortionPriceAndRedeemability — the same fresh fetchPrice-backed
 * value the CollateralRegistry uses for redemptions. Forks rename the SP
 * deposits getter; the target config carries its signature and selector.
 */
export async function measureLiquityV2(
  caller: EthCallJournal,
  target: LiquityV2MeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<LiquityV2MeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const { token, collateralRegistry } = target.contracts;

  const derivedRegistry = decodeAddressWord(
    await caller.call({
      name: "token.collateralRegistryAddress",
      to: token,
      signature: "collateralRegistryAddress()",
      selector: "0x45a74626",
    }),
    "collateralRegistryAddress",
  );
  caller.recordDecoded(derivedRegistry);
  requireCheck(
    checks,
    "graph.collateralRegistry",
    derivedRegistry === collateralRegistry,
    `token.collateralRegistryAddress() ${derivedRegistry} matches pinned config`,
  );

  const totalSupply = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupply.toString());
  requireCheck(checks, "supply.positive", totalSupply > 0n, `token totalSupply ${totalSupply} is positive`);

  const branchCount = Number(
    decodeUintWord(
      await caller.call({
        name: "registry.totalCollaterals",
        to: collateralRegistry,
        signature: "totalCollaterals()",
        selector: "0x30504b6f",
      }),
      0,
      "totalCollaterals",
    ),
  );
  caller.recordDecoded(String(branchCount));
  requireCheck(
    checks,
    "branches.count",
    branchCount >= 1 && branchCount <= target.sanity.maxBranches,
    `registry enumerates ${branchCount} branches (max ${target.sanity.maxBranches})`,
  );

  const branches: BranchReading[] = [];
  for (let index = 0; index < branchCount; index++) {
    const troveManager = decodeAddressWord(
      await caller.call({
        name: `registry.getTroveManager(${index})`,
        to: collateralRegistry,
        signature: "getTroveManager(uint256)",
        selector: "0x0bc17feb",
        args: [BigInt(index)],
      }),
      "getTroveManager",
    );
    caller.recordDecoded(troveManager);
    const collateralToken = decodeAddressWord(
      await caller.call({
        name: `registry.getToken(${index})`,
        to: collateralRegistry,
        signature: "getToken(uint256)",
        selector: "0xe4b50cb8",
        args: [BigInt(index)],
      }),
      "getToken",
    );
    caller.recordDecoded(collateralToken);

    const collateral = decodeUintWord(
      await caller.call({
        name: `troveManager[${index}].getEntireBranchColl`,
        to: troveManager,
        signature: "getEntireBranchColl()",
        selector: "0x3ecaaa3f",
      }),
      0,
      "getEntireBranchColl",
    );
    caller.recordDecoded(collateral.toString());
    const debt = decodeUintWord(
      await caller.call({
        name: `troveManager[${index}].getEntireBranchDebt`,
        to: troveManager,
        signature: "getEntireBranchDebt()",
        selector: "0x105b403b",
      }),
      0,
      "getEntireBranchDebt",
    );
    caller.recordDecoded(debt.toString());

    const stabilityPool = decodeAddressWord(
      await caller.call({
        name: `troveManager[${index}].stabilityPool`,
        to: troveManager,
        signature: "stabilityPool()",
        selector: "0x048c661d",
      }),
      "stabilityPool",
    );
    caller.recordDecoded(stabilityPool);
    const spDeposits = decodeUintWord(
      await caller.call({
        name: `stabilityPool[${index}].${target.spDeposits.signature}`,
        to: stabilityPool,
        signature: target.spDeposits.signature,
        selector: target.spDeposits.selector,
      }),
      0,
      target.spDeposits.signature,
    );
    caller.recordDecoded(spDeposits.toString());

    const shutdownTime = Number(
      decodeUintWord(
        await caller.call({
          name: `troveManager[${index}].shutdownTime`,
          to: troveManager,
          signature: "shutdownTime()",
          selector: "0x58569081",
        }),
        0,
        "shutdownTime",
      ),
    );
    caller.recordDecoded(String(shutdownTime));
    // A shut-down branch has a frozen price and asymmetric mechanics; measuring
    // through it silently would misstate system health, so adjudicate manually.
    requireCheck(
      checks,
      `branch[${index}].not-shut-down`,
      shutdownTime === 0,
      `branch ${index} shutdownTime is 0 (never shut down)`,
    );

    // (uint256 unbacked, uint256 price, bool redeemable): fresh fetchPrice-backed
    // branch price; the redeemable flag doubles as the protocol's own oracle-health signal.
    const unbackedRet = await caller.call({
      name: `troveManager[${index}].getUnbackedPortionPriceAndRedeemability`,
      to: troveManager,
      signature: "getUnbackedPortionPriceAndRedeemability()",
      selector: "0x4ea15f37",
    });
    const priceWei = decodeUintWord(unbackedRet, 1, "getUnbackedPortionPriceAndRedeemability.price");
    const redeemable = decodeUintWord(unbackedRet, 2, "getUnbackedPortionPriceAndRedeemability.redeemable") !== 0n;
    caller.recordDecoded(`price=${priceWei} redeemable=${redeemable}`);
    requireCheck(
      checks,
      `branch[${index}].price`,
      priceWei > 0n && redeemable,
      `branch ${index} protocol price ${priceWei} with redeemable=true`,
    );

    branches.push({
      index,
      collateralToken,
      troveManager,
      stabilityPool,
      collateral,
      debt,
      spDeposits,
      priceWei,
      redeemable,
      shutdownTime,
    });
  }

  const totalDebt = branches.reduce((sum, branch) => sum + branch.debt, 0n);
  const totalCollateralValueWei = branches.reduce(
    (sum, branch) => sum + (branch.collateral * branch.priceWei) / WAD,
    0n,
  );
  const spDepositsTotal = branches.reduce((sum, branch) => sum + branch.spDeposits, 0n);
  const branchCappedNumerator = branches.reduce(
    (sum, branch) => sum + (branch.spDeposits < branch.debt ? branch.spDeposits : branch.debt),
    0n,
  );
  requireCheck(checks, "debt.positive", totalDebt > 0n, `total branch debt ${totalDebt} is positive`);

  const supplyDebtDivergencePct = Math.abs(relativeDeltaPct(totalDebt, totalSupply));
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    supplyDebtDivergencePct <= target.sanity.maxSupplyDebtDivergencePct,
    `total branch debt diverges ${supplyDebtDivergencePct.toFixed(4)}% from token totalSupply (max ${target.sanity.maxSupplyDebtDivergencePct}%)`,
  );

  let priceCrossCheck: LiquityV2MeasurementEvidence["derived"]["priceCrossCheck"];
  if (target.chainlinkBranch0) {
    const roundData = await caller.call({
      name: "chainlink.latestRoundData",
      to: target.chainlinkBranch0.feed,
      signature: "latestRoundData()",
      selector: "0xfeaf968c",
    });
    const answer = decodeUintWord(roundData, 1, "latestRoundData.answer");
    const updatedAt = decodeUintWord(roundData, 3, "latestRoundData.updatedAt");
    caller.recordDecoded(`answer=${answer} updatedAt=${updatedAt}`);
    const answerWei = answer * 10n ** 10n; // 8-decimal feed -> 18 decimals
    const branch0 = branches[0]!;
    const deltaPct = relativeDeltaPct(branch0.priceWei, answerWei);
    const ageSeconds = block.timestampUnix - Number(updatedAt);
    requireCheck(
      checks,
      "price.chainlink-branch0-fresh",
      answer > 0n && ageSeconds >= 0 && ageSeconds <= target.chainlinkBranch0.heartbeatSeconds + 300,
      `Chainlink answer ${answer} is ${ageSeconds}s old at the pinned block (heartbeat ${target.chainlinkBranch0.heartbeatSeconds}s)`,
    );
    requireCheck(
      checks,
      "price.chainlink-branch0-agree",
      Math.abs(deltaPct) <= target.chainlinkBranch0.tolerancePct,
      `branch 0 protocol price deviates ${deltaPct.toFixed(4)}% from Chainlink (tolerance ${target.chainlinkBranch0.tolerancePct}%)`,
    );
    priceCrossCheck = {
      mode: "chainlink-branch0",
      chainlink: {
        answer: answer.toString(),
        updatedAt: Number(updatedAt),
        ageSeconds,
        deltaPct: Math.round(deltaPct * 10_000) / 10_000,
      },
    };
  } else {
    requireCheck(
      checks,
      "price.protocol-feed-only",
      true,
      "No independent oracle is configured on this chain; branch prices rest on each TroveManager's own redeemability-checked feed",
    );
    priceCrossCheck = { mode: "protocol-feed-only" };
  }

  const collateralizationRatio = wadToRounded((totalCollateralValueWei * WAD) / totalDebt);
  requireCheck(
    checks,
    "metric.cr-sanity",
    collateralizationRatio >= target.sanity.minCollateralizationRatio &&
      collateralizationRatio <= target.sanity.maxCollateralizationRatio,
    `collateralization ratio ${collateralizationRatio} within [${target.sanity.minCollateralizationRatio}, ${target.sanity.maxCollateralizationRatio}]`,
  );
  const liquidationCapacityRatio = wadToRounded((spDepositsTotal * WAD) / totalSupply);
  requireCheck(
    checks,
    "metric.capacity-sanity",
    liquidationCapacityRatio >= 0,
    `liquidation capacity ratio ${liquidationCapacityRatio} is non-negative`,
  );
  const branchCappedLiquidationCapacityRatio = wadToRounded((branchCappedNumerator * WAD) / totalDebt);

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "liquity-v2",
    chain: { key: target.chain.key, evmChainId: target.chain.evmChainId },
    rpcUrl,
    block: {
      number: block.number,
      hash: block.hash,
      timestampUnix: block.timestampUnix,
      timestampIso: block.timestampIso,
      selection: block.selection,
    },
    calls: caller.calls,
    derived: {
      branches: branches.map((branch) => ({
        index: branch.index,
        collateralToken: branch.collateralToken,
        troveManager: branch.troveManager,
        stabilityPool: branch.stabilityPool,
        collateral: branch.collateral.toString(),
        debt: branch.debt.toString(),
        spDeposits: branch.spDeposits.toString(),
        priceWei: branch.priceWei.toString(),
        priceUsd: Number(branch.priceWei) / 1e18,
        redeemable: branch.redeemable,
        shutdownTime: branch.shutdownTime,
      })),
      totalCollateralValueWei: totalCollateralValueWei.toString(),
      totalDebt: totalDebt.toString(),
      spDepositsTotal: spDepositsTotal.toString(),
      totalSupply: totalSupply.toString(),
      supplyDebtDivergencePct: Math.round(supplyDebtDivergencePct * 10_000) / 10_000,
      branchCappedLiquidationCapacityRatio,
      priceCrossCheck,
    },
    metrics: { collateralizationRatio, liquidationCapacityRatio },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "1" },
  };
}
