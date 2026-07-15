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
import type { LiquityV1MeasurementTarget } from "../targets";
import type { LiquityV1MeasurementEvidence } from "../schema";

const WAD = 10n ** 18n;

/**
 * Measures Liquity-V1-family system metrics at a pinned block:
 * collateralization ratio (TCR at the protocol's own fetchPrice) and
 * liquidation capacity (Stability Pool deposits / token supply). Every input
 * is an on-chain read; the contract graph is derived from the token and
 * asserted against the pinned config, and the protocol price is
 * cross-checked against Chainlink. Any failed assertion aborts the run.
 */
export async function measureLiquityV1(
  caller: EthCallJournal,
  target: LiquityV1MeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<LiquityV1MeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const { token, troveManager, stabilityPool, priceFeed } = target.contracts;

  const derivedTroveManager = decodeAddressWord(
    await caller.call({ name: "token.troveManagerAddress", to: token, signature: "troveManagerAddress()", selector: "0x5a4d28bb" }),
    "troveManagerAddress",
  );
  caller.recordDecoded(derivedTroveManager);
  requireCheck(
    checks,
    "graph.troveManager",
    derivedTroveManager === troveManager,
    `token.troveManagerAddress() ${derivedTroveManager} matches pinned config`,
  );

  const derivedStabilityPool = decodeAddressWord(
    await caller.call({ name: "token.stabilityPoolAddress", to: token, signature: "stabilityPoolAddress()", selector: "0x0b622ab2" }),
    "stabilityPoolAddress",
  );
  caller.recordDecoded(derivedStabilityPool);
  requireCheck(
    checks,
    "graph.stabilityPool",
    derivedStabilityPool === stabilityPool,
    `token.stabilityPoolAddress() ${derivedStabilityPool} matches pinned config`,
  );

  const derivedPriceFeed = decodeAddressWord(
    await caller.call({ name: "troveManager.priceFeed", to: troveManager, signature: "priceFeed()", selector: "0x741bef1a" }),
    "priceFeed",
  );
  caller.recordDecoded(derivedPriceFeed);
  requireCheck(
    checks,
    "graph.priceFeed",
    derivedPriceFeed === priceFeed,
    `troveManager.priceFeed() ${derivedPriceFeed} matches pinned config`,
  );

  // Canonical price: simulate the protocol's own fetchPrice() at the pinned
  // block. lastGoodPrice is a view but can freeze arbitrarily stale in quiet
  // systems (measured 5% stale on LUSD), so it is recorded informationally only.
  const priceWei = decodeUintWord(
    await caller.call({ name: "priceFeed.fetchPrice", to: priceFeed, signature: "fetchPrice()", selector: "0x0fdb11cf" }),
    0,
    "fetchPrice",
  );
  caller.recordDecoded(priceWei.toString());
  const priceUsd = Number(priceWei) / 1e18;
  requireCheck(
    checks,
    "price.sanity",
    priceUsd >= target.sanity.minPriceUsd && priceUsd <= target.sanity.maxPriceUsd,
    `fetchPrice ${priceUsd} within [${target.sanity.minPriceUsd}, ${target.sanity.maxPriceUsd}]`,
  );

  const lastGoodPriceWei = decodeUintWord(
    await caller.call({ name: "priceFeed.lastGoodPrice", to: priceFeed, signature: "lastGoodPrice()", selector: "0x0490be83" }),
    0,
    "lastGoodPrice",
  );
  caller.recordDecoded(lastGoodPriceWei.toString());

  const roundData = await caller.call({
    name: "chainlink.latestRoundData",
    to: target.chainlink.feed,
    signature: "latestRoundData()",
    selector: "0xfeaf968c",
  });
  const chainlinkAnswer = decodeUintWord(roundData, 1, "latestRoundData.answer");
  const chainlinkUpdatedAt = decodeUintWord(roundData, 3, "latestRoundData.updatedAt");
  caller.recordDecoded(`answer=${chainlinkAnswer} updatedAt=${chainlinkUpdatedAt}`);
  const chainlinkWei = chainlinkAnswer * 10n ** 10n; // 8-decimal feed -> 18 decimals
  const chainlinkDeltaPct = relativeDeltaPct(priceWei, chainlinkWei);
  const chainlinkAgeSeconds = block.timestampUnix - Number(chainlinkUpdatedAt);
  requireCheck(
    checks,
    "price.chainlink-fresh",
    chainlinkAnswer > 0n && chainlinkAgeSeconds >= 0 && chainlinkAgeSeconds <= target.chainlink.heartbeatSeconds + 300,
    `Chainlink answer ${chainlinkAnswer} is ${chainlinkAgeSeconds}s old at the pinned block (heartbeat ${target.chainlink.heartbeatSeconds}s)`,
  );
  requireCheck(
    checks,
    "price.chainlink-agree",
    Math.abs(chainlinkDeltaPct) <= target.chainlink.tolerancePct,
    `fetchPrice deviates ${chainlinkDeltaPct.toFixed(4)}% from Chainlink (tolerance ${target.chainlink.tolerancePct}%)`,
  );

  const collateral = decodeUintWord(
    await caller.call({ name: "troveManager.getEntireSystemColl", to: troveManager, signature: "getEntireSystemColl()", selector: "0x887105d3" }),
    0,
    "getEntireSystemColl",
  );
  caller.recordDecoded(collateral.toString());
  const debt = decodeUintWord(
    await caller.call({ name: "troveManager.getEntireSystemDebt", to: troveManager, signature: "getEntireSystemDebt()", selector: "0x795d26c3" }),
    0,
    "getEntireSystemDebt",
  );
  caller.recordDecoded(debt.toString());

  const tcrWei = decodeUintWord(
    await caller.call({
      name: "troveManager.getTCR",
      to: troveManager,
      signature: "getTCR(uint256)",
      selector: "0xb82f263d",
      args: [priceWei],
    }),
    0,
    "getTCR",
  );
  caller.recordDecoded(tcrWei.toString());
  const expectedTcr = debt === 0n ? null : (collateral * priceWei) / debt;
  requireCheck(
    checks,
    "derivation.tcr",
    expectedTcr !== null && tcrWei === expectedTcr,
    `getTCR(${priceWei}) == floor(coll * price / debt) == ${tcrWei}`,
  );

  const totalSupply = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupply.toString());
  const supplyDebtDivergencePct = Math.abs(relativeDeltaPct(debt, totalSupply));
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    totalSupply > 0n && supplyDebtDivergencePct <= target.sanity.maxSupplyDebtDivergencePct,
    `entire system debt diverges ${supplyDebtDivergencePct.toFixed(4)}% from token totalSupply (max ${target.sanity.maxSupplyDebtDivergencePct}%)`,
  );

  const spDeposits = decodeUintWord(
    await caller.call({
      name: "stabilityPool.getTotalLUSDDeposits",
      to: stabilityPool,
      signature: "getTotalLUSDDeposits()",
      selector: "0x9bf2f1ac",
    }),
    0,
    "getTotalLUSDDeposits",
  );
  caller.recordDecoded(spDeposits.toString());

  const recoveryModeWord = decodeUintWord(
    await caller.call({
      name: "troveManager.checkRecoveryMode",
      to: troveManager,
      signature: "checkRecoveryMode(uint256)",
      selector: "0x4e443d9e",
      args: [priceWei],
    }),
    0,
    "checkRecoveryMode",
  );
  caller.recordDecoded(recoveryModeWord === 0n ? "false" : "true");
  const mcr = decodeUintWord(
    await caller.call({ name: "troveManager.MCR", to: troveManager, signature: "MCR()", selector: "0x794e5724" }),
    0,
    "MCR",
  );
  caller.recordDecoded(mcr.toString());
  const ccr = decodeUintWord(
    await caller.call({ name: "troveManager.CCR", to: troveManager, signature: "CCR()", selector: "0x5733d58f" }),
    0,
    "CCR",
  );
  caller.recordDecoded(ccr.toString());

  const collateralizationRatio = wadToRounded(tcrWei);
  requireCheck(
    checks,
    "metric.cr-sanity",
    collateralizationRatio >= target.sanity.minCollateralizationRatio &&
      collateralizationRatio <= target.sanity.maxCollateralizationRatio,
    `collateralization ratio ${collateralizationRatio} within [${target.sanity.minCollateralizationRatio}, ${target.sanity.maxCollateralizationRatio}]`,
  );
  const liquidationCapacityRatio = wadToRounded((spDeposits * WAD) / totalSupply);
  requireCheck(
    checks,
    "metric.capacity-sanity",
    liquidationCapacityRatio >= 0 && liquidationCapacityRatio <= 1,
    `liquidation capacity ratio ${liquidationCapacityRatio} within [0, 1]`,
  );

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: target.family,
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
      priceWei: priceWei.toString(),
      priceUsd,
      chainlink: {
        answer: chainlinkAnswer.toString(),
        updatedAt: Number(chainlinkUpdatedAt),
        ageSeconds: chainlinkAgeSeconds,
        deltaPct: Math.round(chainlinkDeltaPct * 10_000) / 10_000,
      },
      lastGoodPrice: {
        valueWei: lastGoodPriceWei.toString(),
        deltaPct: Math.round(relativeDeltaPct(lastGoodPriceWei, priceWei) * 10_000) / 10_000,
        informational: true,
      },
      collateral: collateral.toString(),
      debt: debt.toString(),
      spDeposits: spDeposits.toString(),
      totalSupply: totalSupply.toString(),
    },
    metrics: { collateralizationRatio, liquidationCapacityRatio },
    checks,
    notesHints: {
      recoveryMode: recoveryModeWord !== 0n,
      mcr: wadToRounded(mcr),
      ccr: wadToRounded(ccr),
    },
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "1" },
  };
}
