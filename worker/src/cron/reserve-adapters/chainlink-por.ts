import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "./chainlink";
import { fetchOnchainRawCall, fetchOnchainUint256, requireOnchainInput } from "./helpers";

const DECIMALS_SELECTOR = "0x313ce567";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * 86400;

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

function readParams(config: LiveReservesConfig): ChainlinkPorParams {
  const params = (config.params ?? {}) as Partial<ChainlinkPorParams>;
  if (!params.porFeedAddress || !params.assetLabel || !params.assetRisk) {
    throw new Error("chainlink-por adapter requires params.porFeedAddress, assetLabel, and assetRisk");
  }
  return params as ChainlinkPorParams;
}

/** Pure transformation from decoded Chainlink data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkPorResponse(data: ChainlinkPorData, params: ChainlinkPorParams): AdapterResult {
  if (data.reserves <= 0n) {
    throw new Error("chainlink-por: feed reported zero or negative reserves");
  }

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
    },
  };
}

export async function fetchChainlinkPorReserves(
  _coin: StablecoinMeta,
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
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - updatedAt);
  if (ageSec > maxOracleAgeSec) {
    throw new Error(`chainlink-por: feed data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
  }

  return adaptChainlinkPorResponse(
    { reserves: answer, decimals, roundId, updatedAt },
    params,
  );
}
