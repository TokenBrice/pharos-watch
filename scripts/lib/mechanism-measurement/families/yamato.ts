import {
  decodeAddressWord,
  decodeUintWord,
  normalizeAddress,
  ratioToRounded,
  requireCheck,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { YamatoMeasurementEvidence } from "../schema";
import type { YamatoMeasurementTarget } from "../targets";

const LIQUIDATION_NA =
  "Yamato documents a no-liquidation design; the protocol pool is a redemption/sweep resource, not committed liquidation capital.";

export async function measureYamato(
  caller: EthCallJournal,
  target: YamatoMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<YamatoMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const token = normalizeAddress(target.contracts.token);
  const yamato = normalizeAddress(target.contracts.yamato);

  const currencyOs = decodeAddressWord(
    await caller.call({ name: "yamato.currencyOS", to: yamato, signature: "currencyOS()", selector: "0x19eb292c" }),
    "currencyOS",
  );
  caller.recordDecoded(currencyOs);
  const currency = decodeAddressWord(
    await caller.call({ name: "currencyOS.currency", to: currencyOs, signature: "currency()", selector: "0xe5a6b10f" }),
    "currencyOS.currency",
  );
  caller.recordDecoded(currency);
  requireCheck(checks, "graph.currency", currency === token, `CurrencyOS token ${currency} equals configured CJPY`);

  const statesRaw = await caller.call({
    name: "yamato.getStates",
    to: yamato,
    signature: "getStates()",
    selector: "0xd8ab8274",
  });
  const totalCollateralRaw = decodeUintWord(statesRaw, 0, "getStates.totalColl");
  const totalDebtRaw = decodeUintWord(statesRaw, 1, "getStates.totalDebt");
  const mcrPct = Number(decodeUintWord(statesRaw, 2, "getStates.MCR"));
  const rrrPct = decodeUintWord(statesRaw, 3, "getStates.RRR");
  const srrPct = decodeUintWord(statesRaw, 4, "getStates.SRR");
  const grrPct = decodeUintWord(statesRaw, 5, "getStates.GRR");
  caller.recordDecoded(
    `collateral=${totalCollateralRaw} debt=${totalDebtRaw} MCR=${mcrPct} RRR=${rrrPct} SRR=${srrPct} GRR=${grrPct}`,
  );
  requireCheck(
    checks,
    "system.positive",
    totalCollateralRaw > 0n && totalDebtRaw > 0n,
    `collateral ${totalCollateralRaw} and debt ${totalDebtRaw} are positive`,
  );

  const priceFeed = decodeAddressWord(
    await caller.call({ name: "yamato.priceFeed", to: yamato, signature: "priceFeed()", selector: "0x741bef1a" }),
    "priceFeed",
  );
  caller.recordDecoded(priceFeed);
  const priceRaw = decodeUintWord(
    await caller.call({ name: "priceFeed.getPrice", to: priceFeed, signature: "getPrice()", selector: "0x98d5fdca" }),
    0,
    "getPrice",
  );
  caller.recordDecoded(priceRaw.toString());
  requireCheck(checks, "price.positive", priceRaw > 0n, `protocol ETH/JPY price ${priceRaw} is positive`);

  const pool = decodeAddressWord(
    await caller.call({ name: "yamato.pool", to: yamato, signature: "pool()", selector: "0x16f0115b" }),
    "pool",
  );
  caller.recordDecoded(pool);
  requireCheck(
    checks,
    "graph.pool",
    pool === normalizeAddress(target.contracts.expectedPool),
    `protocol pool ${pool} matches configured graph`,
  );

  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: token, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  requireCheck(
    checks,
    "derivation.supply-vs-debt",
    totalSupplyRaw === totalDebtRaw,
    `token supply ${totalSupplyRaw} exactly equals Yamato debt`,
  );

  const poolBalanceRaw = decodeUintWord(
    await caller.call({
      name: "token.balanceOf(pool)",
      to: token,
      signature: "balanceOf(address)",
      selector: "0x70a08231",
      args: [BigInt(pool)],
    }),
    0,
    "pool balance",
  );
  caller.recordDecoded(poolBalanceRaw.toString());
  requireCheck(
    checks,
    "pool.balance-positive",
    poolBalanceRaw > 0n,
    `protocol pool balance ${poolBalanceRaw} is positive`,
  );

  const collateralizationRatio = ratioToRounded(totalCollateralRaw * priceRaw, totalDebtRaw * 10n ** 18n);
  const protocolRedemptionPoolRatio = ratioToRounded(poolBalanceRaw, totalDebtRaw);

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "yamato-system-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    metrics: {
      collateralizationRatio,
      liquidationCapacityRatio: null,
      applicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "not-applicable", rationale: LIQUIDATION_NA },
      },
    },
    completeness: { complete: true, blockers: [] },
    derived: {
      yamato,
      currencyOs,
      token,
      priceFeed,
      pool,
      totalCollateralRaw: totalCollateralRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      totalSupplyRaw: totalSupplyRaw.toString(),
      priceRaw: priceRaw.toString(),
      poolBalanceRaw: poolBalanceRaw.toString(),
      mcrPct,
    },
    analogousMetrics: { protocolRedemptionPoolRatio },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
