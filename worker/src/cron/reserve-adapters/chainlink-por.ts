import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "./chainlink";
import { resolveCoinContractAddress } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

export interface ChainlinkPorParams {
  porFeedAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
}

interface ChainlinkPorData {
  reserves: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: number;
}

interface ChainlinkPorSupplyData {
  raw: bigint;
  decimals: number;
  tokenAddress: string;
}

function readParams(config: LiveReservesConfig): ChainlinkPorParams {
  return parseLiveReserveAdapterParams("chainlink-por", config.params);
}

/** Pure transformation from decoded Chainlink data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkPorResponse(
  data: ChainlinkPorData,
  params: ChainlinkPorParams,
  supply?: ChainlinkPorSupplyData | null,
): AdapterResult {
  if (data.reserves <= 0n) {
    throw new Error("chainlink-por: feed reported zero or negative reserves");
  }

  const totalReserveUsd = decimalNumberFromBigInt(data.reserves, data.decimals);
  const supplyUsd = supply ? decimalNumberFromBigInt(supply.raw, supply.decimals) : null;
  const collateralizationRatio = supplyUsd != null && supplyUsd > 0 ? totalReserveUsd / supplyUsd : null;
  const warnings = collateralizationRatio != null && collateralizationRatio < 0.995
    ? [reserveDegradedWarning(
        "por-reserve-under-supply",
        `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of same-chain token supply`,
      )]
    : [];

  return {
    slices: [
      {
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    metadata: {
      totalReservesRaw: data.reserves.toString(),
      feedDecimals: data.decimals,
      feedRoundId: data.roundId.toString(),
      feedUpdatedAt: data.updatedAt,
      sourceTimestamp: data.updatedAt,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound" as const,
        freshnessKind: "verified-source-timestamp" as const,
        sourceTimestamp: data.updatedAt,
        routeStatus: "unknown" as const,
      },
      totalReserveUsd,
      ...(supply
        ? {
            supplyUsd,
            supplyRaw: supply.raw.toString(),
            supplyDecimals: supply.decimals,
            supplyTokenAddress: supply.tokenAddress,
          }
        : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function fetchChainlinkPorReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-por");
  const params = readParams(config);

  const callBase = {
    contract: params.porFeedAddress,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  };

  // 1. Fetch feed decimals (single uint8)
  const rawDecimals = await fetchOnchainUint256({
    ...callBase,
    data: DECIMALS_SELECTOR,
  });
  if (rawDecimals == null) {
    throw new Error("chainlink-por: decimals() call failed");
  }
  const decimals = Number(rawDecimals);

  // 2. Fetch latestRoundData() (5 words)
  const rawRoundData = await fetchOnchainRawCall({
    ...callBase,
    data: LATEST_ROUND_DATA_SELECTOR,
  });
  if (rawRoundData == null) {
    throw new Error("chainlink-por: latestRoundData() call failed");
  }

  const { roundId, answer, updatedAt } = parseChainlinkLatestRoundData(rawRoundData, "chainlink-por");
  const maxOracleAgeSec = params.maxOracleAgeSec ?? DEFAULT_MAX_ORACLE_AGE_SEC;
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  if (updatedAt > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(`chainlink-por: feed data timestamp is in the future (${updatedAt - now}s)`);
  }
  const ageSec = now - updatedAt;
  if (ageSec > maxOracleAgeSec) {
    throw new Error(`chainlink-por: feed data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
  }

  const tokenAddress = resolveCoinContractAddress(coin, input.chain);
  if (!tokenAddress) {
    throw new Error(`chainlink-por: missing ${input.chain} token contract metadata for ${coin.id}`);
  }
  const tokenContract = coin.contracts?.find((contract) => (
    contract.chain === input.chain
    && contract.address.toLowerCase() === tokenAddress.toLowerCase()
  ));
  const supplyRaw = await fetchErc20TotalSupply(
    input,
    tokenAddress,
    signal,
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  );
  if (supplyRaw == null || supplyRaw <= 0n) {
    throw new Error(`chainlink-por: totalSupply() call failed for ${coin.id}`);
  }

  return adaptChainlinkPorResponse(
    { reserves: answer, decimals, roundId, updatedAt },
    params,
    {
      raw: supplyRaw,
      decimals: tokenContract?.decimals ?? 18,
      tokenAddress,
    },
  );
}
