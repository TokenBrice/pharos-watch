import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { parseChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { fetchEvmCallHexAtBlock, fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./optional-source-runtime";
import type { ResolvedYieldCandidate } from "./types";

const MIDAS_MMEV_ID = "mmev-midas";
const MIDAS_MMEV_SYMBOL = "mMEV";
const MIDAS_MMEV_CHAIN = "ethereum";
const MIDAS_MMEV_TOKEN = "0x030b69280892c888670edcdcd8b69fd8026a0bf3";
const MIDAS_MMEV_NAV_ORACLE = "0x5f09Aff8B9b1f488B7d1bbaD4D89648579e55d61";
const MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY = "protocol-api:midas-mmev-nav-oracle";
const MIDAS_MMEV_NAV_ORACLE_LABEL = "Midas mMEV/USD Oracle";
const MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC = 3 * DAY_SECONDS;
const MIDAS_NAV_ORACLE_MAX_DECIMALS = 36;
const MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC = 5 * 60;

interface MidasMmevNavOracleOptions {
  prevExchangeRate?: number | null;
  daysDelta?: number;
  comparisonAnchorObservedAt?: number | null;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
}

function decodeMidasNavOracleDecimals(rawDecimals: bigint | null): number | null {
  if (rawDecimals == null || rawDecimals < 0n || rawDecimals > BigInt(MIDAS_NAV_ORACLE_MAX_DECIMALS)) {
    return null;
  }
  return Number(rawDecimals);
}

function isFreshMidasNavOracleUpdate(updatedAt: number, nowSec: number): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (updatedAt > nowSec + MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC) return false;
  return nowSec - updatedAt <= MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC;
}

function buildMidasMmevNavCandidate(params: {
  apy: number;
  apyBase: number | null;
  exchangeRate: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number | null;
}): ResolvedYieldCandidate {
  return {
    stablecoinId: MIDAS_MMEV_ID,
    symbol: MIDAS_MMEV_SYMBOL,
    chain: MIDAS_MMEV_CHAIN,
    address: MIDAS_MMEV_TOKEN,
    yield: {
      currentApy: params.apy,
      apyBase: params.apyBase,
      apyReward: null,
      sourcePool: MIDAS_MMEV_NAV_ORACLE,
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: params.exchangeRate,
      sourceKey: MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY,
      yieldSource: MIDAS_MMEV_NAV_ORACLE_LABEL,
      yieldType: "nav-appreciation",
      sourceObservedAt: params.sourceObservedAt,
      comparisonAnchorObservedAt: params.comparisonAnchorObservedAt,
    },
  };
}

export async function fetchMidasMmevNavOracleSource(
  options: MidasMmevNavOracleOptions = {},
): Promise<ResolvedYieldCandidate | null> {
  const {
    prevExchangeRate = null,
    daysDelta = 0,
    comparisonAnchorObservedAt = null,
    signal,
    chainRpcs,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  try {
    const callOptions = {
      chainRpcs,
      signal,
      timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    };
    const [rawDecimals, rawRoundData] = await Promise.all([
      fetchEvmUint256AtBlock(
        MIDAS_MMEV_CHAIN,
        MIDAS_MMEV_NAV_ORACLE,
        DECIMALS_SELECTOR,
        "latest",
        callOptions,
      ),
      fetchEvmCallHexAtBlock(
        MIDAS_MMEV_CHAIN,
        MIDAS_MMEV_NAV_ORACLE,
        LATEST_ROUND_DATA_SELECTOR,
        "latest",
        callOptions,
      ),
    ]);

    const decimals = decodeMidasNavOracleDecimals(rawDecimals);
    if (decimals == null || rawRoundData == null) return null;

    const round = parseChainlinkLatestRoundData(rawRoundData, "midas-mmev-nav-oracle");
    if (!isFreshMidasNavOracleUpdate(round.updatedAt, nowSec)) return null;

    const currentPriceFloat = finiteDecimalNumberFromBigInt(round.answer, decimals);
    if (currentPriceFloat == null || currentPriceFloat <= 0) return null;

    const prevPriceFloat = typeof prevExchangeRate === "number" && Number.isFinite(prevExchangeRate) && prevExchangeRate > 0
      ? prevExchangeRate
      : null;

    if (prevPriceFloat == null || daysDelta < 1) {
      return buildMidasMmevNavCandidate({
        apy: 0,
        apyBase: null,
        exchangeRate: currentPriceFloat,
        sourceObservedAt: round.updatedAt,
        comparisonAnchorObservedAt: null,
      });
    }

    const apy = (Math.pow(currentPriceFloat / prevPriceFloat, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return buildMidasMmevNavCandidate({
      apy,
      apyBase: apy,
      exchangeRate: currentPriceFloat,
      sourceObservedAt: round.updatedAt,
      comparisonAnchorObservedAt,
    });
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    return null;
  }
}
