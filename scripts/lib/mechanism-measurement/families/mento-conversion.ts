import { decodeAbiParameters } from "viem/utils";
import {
  decodeUintWord,
  normalizeAddress,
  ratioToRounded,
  requireCheck,
  type EthCallJournal,
  type MeasurementCheck,
  type PinnedBlock,
} from "../core";
import type { MentoConversionMeasurementEvidence } from "../schema";
import type { MentoConversionMeasurementTarget } from "../targets";

const POOL_EXCHANGE_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "asset0", type: "address" },
      { name: "asset1", type: "address" },
      { name: "pricingModule", type: "address" },
      { name: "bucket0", type: "uint256" },
      { name: "bucket1", type: "uint256" },
      { name: "lastBucketUpdate", type: "uint256" },
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "spread", type: "uint256" },
          { name: "referenceRateFeedID", type: "address" },
          { name: "referenceRateResetFrequency", type: "uint256" },
          { name: "minimumReports", type: "uint256" },
          { name: "stablePoolResetSize", type: "uint256" },
        ],
      },
    ],
  },
] as const;

interface PoolExchange {
  asset0: `0x${string}`;
  asset1: `0x${string}`;
  bucket0: bigint;
  bucket1: bigint;
  config: { spread: bigint };
}

const CR_NA =
  "This token is a reserve/conversion product without an independently collateralized per-token vault system.";
const LIQUIDATION_NA =
  "The measured counter-asset conversion inventory is redemption liquidity, not capital contractually committed to debt-offset liquidation.";

export async function measureMentoConversion(
  caller: EthCallJournal,
  target: MentoConversionMeasurementTarget,
  block: PinnedBlock,
  rpcUrl: string,
): Promise<MentoConversionMeasurementEvidence> {
  const checks: MeasurementCheck[] = [];
  const selfToken = normalizeAddress(target.contracts.token);
  const counterToken = normalizeAddress(target.contracts.counterToken);
  const totalSupplyRaw = decodeUintWord(
    await caller.call({ name: "token.totalSupply", to: selfToken, signature: "totalSupply()", selector: "0x18160ddd" }),
    0,
    "totalSupply",
  );
  caller.recordDecoded(totalSupplyRaw.toString());
  requireCheck(checks, "supply.positive", totalSupplyRaw > 0n, `token supply ${totalSupplyRaw} is positive`);

  let derived: MentoConversionMeasurementEvidence["derived"];
  let conversionCapacityRaw: bigint;

  if (target.mode === "broker-pool") {
    const manager = normalizeAddress(target.contracts.biPoolManager);
    const rawIds = await caller.call({
      name: "biPoolManager.getExchangeIds",
      to: manager,
      signature: "getExchangeIds()",
      selector: "0xdc162e36",
    });
    const [exchangeIds] = decodeAbiParameters([{ type: "bytes32[]" }], rawIds as `0x${string}`);
    caller.recordDecoded(`count=${exchangeIds.length}`);
    requireCheck(
      checks,
      "exchanges.count",
      exchangeIds.length > 0 && exchangeIds.length <= target.maxExchangeIds,
      `enumerated ${exchangeIds.length} exchange ids (max ${target.maxExchangeIds})`,
    );
    const normalizedIds = exchangeIds.map((id) => id.toLowerCase());
    requireCheck(
      checks,
      "exchanges.unique",
      new Set(normalizedIds).size === normalizedIds.length,
      "every exchange id is unique",
    );

    const matches: Array<{ exchangeId: string; exchange: PoolExchange }> = [];
    for (let index = 0; index < exchangeIds.length; index += 1) {
      const exchangeId = exchangeIds[index]!;
      const rawExchange = await caller.call({
        name: `biPoolManager.getPoolExchange(${index})`,
        to: manager,
        signature: "getPoolExchange(bytes32)",
        selector: "0x278488a4",
        args: [BigInt(exchangeId)],
      });
      const [decoded] = decodeAbiParameters(POOL_EXCHANGE_PARAMETERS, rawExchange as `0x${string}`);
      const exchange = decoded as unknown as PoolExchange;
      const asset0 = normalizeAddress(exchange.asset0, `exchange ${index} asset0`);
      const asset1 = normalizeAddress(exchange.asset1, `exchange ${index} asset1`);
      caller.recordDecoded(
        `asset0=${asset0} asset1=${asset1} bucket0=${exchange.bucket0} bucket1=${exchange.bucket1} spread=${exchange.config.spread}`,
      );
      if ((asset0 === selfToken && asset1 === counterToken) || (asset0 === counterToken && asset1 === selfToken)) {
        matches.push({ exchangeId: exchangeId.toLowerCase(), exchange });
      }
    }

    requireCheck(
      checks,
      "exchange.exact-match",
      matches.length === 1,
      `configured self/counter pair appears exactly once (matches=${matches.length})`,
    );
    const match = matches[0]!;
    conversionCapacityRaw =
      normalizeAddress(match.exchange.asset0) === counterToken ? match.exchange.bucket0 : match.exchange.bucket1;
    requireCheck(
      checks,
      "conversion.capacity-positive",
      conversionCapacityRaw > 0n,
      `counter bucket ${conversionCapacityRaw} is positive`,
    );
    const feeBps = Number((match.exchange.config.spread * 10_000n) / 10n ** 24n);
    derived = {
      mode: "broker-pool",
      exchangeId: match.exchangeId,
      exchangeCount: exchangeIds.length,
      selfToken,
      counterToken,
      counterCapacityRaw: conversionCapacityRaw.toString(),
      feeBps,
      totalSupplyRaw: totalSupplyRaw.toString(),
    };
  } else {
    const pool = normalizeAddress(target.contracts.pool);
    conversionCapacityRaw = decodeUintWord(
      await caller.call({
        name: "counterToken.balanceOf(pool)",
        to: counterToken,
        signature: "balanceOf(address)",
        selector: "0x70a08231",
        args: [BigInt(pool)],
      }),
      0,
      "counterToken.balanceOf(pool)",
    );
    caller.recordDecoded(conversionCapacityRaw.toString());
    requireCheck(
      checks,
      "conversion.capacity-positive",
      conversionCapacityRaw > 0n,
      `pool counter balance ${conversionCapacityRaw} is positive`,
    );
    derived = {
      mode: "fpmm-pool",
      selfToken,
      counterToken,
      pool,
      counterCapacityRaw: conversionCapacityRaw.toString(),
      feeBps: null,
      totalSupplyRaw: totalSupplyRaw.toString(),
    };
  }

  return {
    schemaVersion: 1,
    kind: "cdp-mechanism-measurement",
    assetId: target.assetId,
    archetype: "cdp",
    family: "mento-conversion-evidence-v1",
    chain: target.chain,
    rpcUrl,
    block,
    calls: caller.calls,
    metrics: {
      collateralizationRatio: null,
      liquidationCapacityRatio: null,
      applicability: {
        collateralizationRatio: { state: "not-applicable", rationale: CR_NA },
        liquidationCapacityRatio: { state: "not-applicable", rationale: LIQUIDATION_NA },
      },
    },
    completeness: { complete: true, blockers: [] },
    derived,
    analogousMetrics: {
      conversionCapacityCounterUnits: ratioToRounded(conversionCapacityRaw, 10n ** 18n, 8),
    },
    checks,
    overlaySources: [...target.overlaySources],
    tool: { name: "measure-cdp-mechanism-metrics", version: "2" },
  };
}
