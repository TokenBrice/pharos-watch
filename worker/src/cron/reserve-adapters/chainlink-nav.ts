import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "./chainlink";
import { fetchOnchainRawCall, fetchOnchainUint256, requireOnchainInput, reserveInfoWarning } from "./helpers";

const DECIMALS_SELECTOR = "0x313ce567";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
/** Ondo-style getPrice() — returns single uint256 with 18 decimals. */
const GET_PRICE_SELECTOR = "0x98d5fdca";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

export interface ChainlinkNavParams {
  oracleAddress: string;
  tokenAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  /** "latestRoundData" (default) = standard AggregatorV3Interface;
   *  "getPrice" = Ondo-style oracle returning a single uint256 with 18 decimals. */
  oracleMethod?: "latestRoundData" | "getPrice";
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
}

export interface ChainlinkNavData {
  navPerToken: bigint;
  navDecimals: number;
  totalSupply: bigint;
  tokenDecimals: number;
  roundId: bigint;
  updatedAt: number;
}

/** Format a bigint with `decimals` fractional digits, trimming trailing zeros. */
function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  const trimmed = fracPart.replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

function readParams(config: LiveReservesConfig): ChainlinkNavParams {
  return parseLiveReserveAdapterParams("chainlink-nav", config.params);
}

/** Pure transformation from decoded NAV oracle data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkNavResponse(data: ChainlinkNavData, params: ChainlinkNavParams): AdapterResult {
  if (data.navPerToken <= 0n) {
    throw new Error("chainlink-nav: oracle reported zero or negative NAV per token");
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
      navPerToken: formatUnits(data.navPerToken, data.navDecimals),
      totalSupplyFormatted: formatUnits(data.totalSupply, data.tokenDecimals),
      totalSupplyRaw: data.totalSupply.toString(),
      navDecimals: data.navDecimals,
      tokenDecimals: data.tokenDecimals,
      oracleRoundId: data.roundId.toString(),
      oracleUpdatedAt: data.updatedAt,
      oracleTimestampSource: data.roundId === 0n ? "unavailable" : "oracle-round",
      ...(data.updatedAt > 0 ? { sourceTimestamp: data.updatedAt, freshnessMode: "verified" as const } : { freshnessMode: "unverified" as const }),
    },
  };
}

export async function fetchChainlinkNavReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-nav");
  const params = readParams(config);
  const method = params.oracleMethod ?? "latestRoundData";

  const oracleCallBase = {
    contract: params.oracleAddress,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  };

  const tokenCallBase = {
    contract: params.tokenAddress,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  };

  // Fetch token decimals + totalSupply in parallel with oracle data
  const tokenDecimalsP = fetchOnchainUint256({ ...tokenCallBase, data: DECIMALS_SELECTOR });
  const totalSupplyP = fetchOnchainUint256({ ...tokenCallBase, data: TOTAL_SUPPLY_SELECTOR });

  let navPerToken: bigint;
  let navDecimals: number;
  let roundId: bigint;
  let updatedAt: number;
  const warnings = [];

  if (method === "getPrice") {
    // Ondo-style: getPrice() returns a single uint256 with 18 decimals.
    // The oracle does not expose an update timestamp, so freshness cannot be
    // verified here. Surface that explicitly instead of fabricating one.
    const rawPrice = await fetchOnchainUint256({ ...oracleCallBase, data: GET_PRICE_SELECTOR });
    if (rawPrice == null) {
      throw new Error("chainlink-nav: getPrice() call failed");
    }
    navPerToken = rawPrice;
    navDecimals = 18;
    roundId = 0n;
    updatedAt = 0;
    warnings.push(reserveInfoWarning(
      "oracle-freshness-unverified",
      "chainlink-nav getPrice() mode does not expose an oracle update timestamp",
    ));
  } else {
    // Standard AggregatorV3Interface: decimals() + latestRoundData()
    const rawOracleDecimals = await fetchOnchainUint256({ ...oracleCallBase, data: DECIMALS_SELECTOR });
    if (rawOracleDecimals == null) {
      throw new Error("chainlink-nav: oracle decimals() call failed");
    }
    navDecimals = Number(rawOracleDecimals);

    const rawRoundData = await fetchOnchainRawCall({
      ...oracleCallBase,
      data: LATEST_ROUND_DATA_SELECTOR,
    });
    if (rawRoundData == null) {
      throw new Error("chainlink-nav: latestRoundData() call failed");
    }
    const parsed = parseChainlinkLatestRoundData(rawRoundData, "chainlink-nav");
    navPerToken = parsed.answer;
    roundId = parsed.roundId;
    updatedAt = parsed.updatedAt;

    const maxOracleAgeSec = params.maxOracleAgeSec ?? DEFAULT_MAX_ORACLE_AGE_SEC;
    const ageSec = Math.max(0, (ctx?.nowSec ?? Math.floor(Date.now() / 1000)) - updatedAt);
    if (ageSec > maxOracleAgeSec) {
      throw new Error(`chainlink-nav: oracle data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
    }
  }

  const [rawTokenDecimals, rawTotalSupply] = await Promise.all([tokenDecimalsP, totalSupplyP]);
  if (rawTokenDecimals == null) {
    throw new Error("chainlink-nav: token decimals() call failed");
  }
  if (rawTotalSupply == null) {
    throw new Error("chainlink-nav: token totalSupply() call failed");
  }

  const adapted = adaptChainlinkNavResponse(
    {
      navPerToken,
      navDecimals,
      totalSupply: rawTotalSupply,
      tokenDecimals: Number(rawTokenDecimals),
      roundId,
      updatedAt,
    },
    params,
  );
  return warnings.length > 0 ? { ...adapted, warnings } : adapted;
}
