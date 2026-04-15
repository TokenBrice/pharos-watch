import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "./chainlink";
import {
  decimalStringFromBigInt,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  requireOnchainInput,
  reserveInfoWarning,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
/** Ondo-style getPrice() — returns single uint256 with 18 decimals. */
const GET_PRICE_SELECTOR = "0x98d5fdca";
const GET_ASSET_PRICE_SELECTOR = "0xb3596f07";
const TOKEN_TO_RWA_ORACLE_SELECTOR = "0xeca6f018";
const GET_PRICE_DATA_SELECTOR = "0xa4a28168";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

export interface ChainlinkNavParams {
  oracleAddress: string;
  tokenAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  /** "latestRoundData" (default) = standard AggregatorV3Interface;
   *  "getPrice" = Ondo-style oracle returning a single uint256 with 18 decimals.
   *  "getAssetPrice" = Ondo oracle router returning a token-scoped uint256 with 18 decimals. */
  oracleMethod?: "latestRoundData" | "getPrice" | "getAssetPrice";
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
  oracleTimestampSource?: "oracle-round" | "ondo-price-data" | "unavailable";
}

function encodeAddressArgument(selector: string, address: string): `0x${string}` {
  return `${selector}${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
}

function parseAddressResult(raw: string | null): `0x${string}` | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }

  const address = `0x${raw.slice(-40).toLowerCase()}` as `0x${string}`;
  return /^0x0{40}$/.test(address) ? null : address;
}

export function parseOndoPriceData(raw: string): { price: bigint; updatedAt: number } {
  if (!/^0x[0-9a-fA-F]{128}$/.test(raw)) {
    throw new Error("chainlink-nav: getPriceData() returned malformed payload");
  }

  const price = BigInt(`0x${raw.slice(2, 66)}`);
  const updatedAtRaw = BigInt(`0x${raw.slice(66, 130)}`);
  const updatedAt = Number(updatedAtRaw);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
    throw new Error("chainlink-nav: getPriceData() returned invalid timestamp");
  }

  return { price, updatedAt };
}

function readParams(config: LiveReservesConfig): ChainlinkNavParams {
  return parseLiveReserveAdapterParams("chainlink-nav", config.params);
}

/** Pure transformation from decoded NAV oracle data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkNavResponse(data: ChainlinkNavData, params: ChainlinkNavParams): AdapterResult {
  if (data.navPerToken <= 0n) {
    throw new Error("chainlink-nav: oracle reported zero or negative NAV per token");
  }

  const oracleTimestampSource = data.oracleTimestampSource ?? (data.roundId === 0n ? "unavailable" : "oracle-round");

  return {
    slices: [
      {
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    metadata: {
      navPerToken: decimalStringFromBigInt(data.navPerToken, data.navDecimals),
      totalSupplyFormatted: decimalStringFromBigInt(data.totalSupply, data.tokenDecimals),
      totalSupplyRaw: data.totalSupply.toString(),
      navDecimals: data.navDecimals,
      tokenDecimals: data.tokenDecimals,
      oracleRoundId: data.roundId.toString(),
      oracleUpdatedAt: data.updatedAt,
      oracleTimestampSource,
      ...(data.updatedAt > 0
        ? verifiedFreshnessMetadata(data.updatedAt)
        : unverifiedFreshnessMetadata(
            "onchain-oracle-getprice",
            "chainlink-nav getPrice() mode does not expose an oracle update timestamp",
          )),
      redemption: {
        capacityKind: "documented-bound" as const,
        freshnessKind: data.updatedAt > 0 ? "verified-source-timestamp" as const : "unverified" as const,
        ...(data.updatedAt > 0 ? { sourceTimestamp: data.updatedAt } : {}),
        routeStatus: "unknown" as const,
      },
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
  let oracleTimestampSource: ChainlinkNavData["oracleTimestampSource"];
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
    oracleTimestampSource = "unavailable";
    warnings.push(reserveInfoWarning(
      "oracle-freshness-unverified",
      "chainlink-nav getPrice() mode does not expose an oracle update timestamp",
    ));
  } else if (method === "getAssetPrice") {
    const rawPrice = await fetchOnchainUint256({
      ...oracleCallBase,
      data: encodeAddressArgument(GET_ASSET_PRICE_SELECTOR, params.tokenAddress),
    });
    if (rawPrice == null) {
      throw new Error("chainlink-nav: getAssetPrice(address) call failed");
    }

    navPerToken = rawPrice;
    navDecimals = 18;
    roundId = 0n;
    updatedAt = 0;
    oracleTimestampSource = "unavailable";

    const rawWrapperAddress = await fetchOnchainRawCall({
      ...oracleCallBase,
      data: encodeAddressArgument(TOKEN_TO_RWA_ORACLE_SELECTOR, params.tokenAddress),
    });
    const wrapperAddress = parseAddressResult(rawWrapperAddress);
    if (wrapperAddress) {
      const rawPriceData = await fetchOnchainRawCall({
        ...oracleCallBase,
        contract: wrapperAddress,
        data: GET_PRICE_DATA_SELECTOR,
      });
      if (rawPriceData != null) {
        const parsed = parseOndoPriceData(rawPriceData);
        navPerToken = parsed.price;
        updatedAt = parsed.updatedAt;
        oracleTimestampSource = "ondo-price-data";
      }
    }

    if (updatedAt <= 0) {
      warnings.push(reserveInfoWarning(
        "oracle-freshness-unverified",
        "chainlink-nav getAssetPrice() mode did not expose a trustworthy update timestamp",
      ));
    }
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
    oracleTimestampSource = "oracle-round";

  }

  if (updatedAt > 0) {
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
      oracleTimestampSource,
    },
    params,
  );
  return warnings.length > 0 ? { ...adapted, warnings } : adapted;
}
