import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveRedemptionTelemetry, LiveReservesConfig } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  DECIMALS_SELECTOR,
  LATEST_ROUND_DATA_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
  encodeUint256,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  decimalNumberFromBigInt,
  decimalStringFromBigInt,
  fetchOnchainMulticall3,
  freshnessMetadataFromTimestamp,
  makeOnchainCallers,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import type { OnchainCallers } from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
import { decodeAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { validateDecimals } from "./slice-math";

/** Ondo-style getPrice() — returns single uint256 with 18 decimals. */
const GET_PRICE_SELECTOR = "0x98d5fdca";
const GET_ASSET_PRICE_SELECTOR = "0xb3596f07";
const TOKEN_TO_RWA_ORACLE_SELECTOR = "0xeca6f018";
const GET_PRICE_DATA_SELECTOR = "0xa4a28168";
const ONDO_TOKEN_ROUTER_SELECTOR = "0x8f4f9613";
const ACCEPTED_REDEMPTION_TOKENS_SELECTOR = "0x884a0501";
const MINIMUM_REDEMPTION_USD_SELECTOR = "0x8f8eb812";
const WITHDRAW_TOKEN_SOURCES_SELECTOR = "0x2021065d";
const AVAILABLE_TO_WITHDRAW_SELECTOR = "0x6cde714a";
const DEFAULT_REDEEM_PAUSED_SELECTOR = "0xb235d468";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

// Verified source: https://etherscan.io/address/0x93358db73B6cd4b98D89c8F5f230E81a95c2643a#code
// The manager delegates each redemption to the pinned router, whose default OUSG/USDC
// source atomically converts BUIDL when its direct USDC float is insufficient.
const ONDO_OUSG_REDEMPTION_SOURCE_URLS = [
  "https://etherscan.io/address/0x93358db73B6cd4b98D89c8F5f230E81a95c2643a#code",
  "https://etherscan.io/address/0x99B8d1D1c17a10CD1A878d1A44c11fd7E4daD7bC#code",
  "https://etherscan.io/address/0x9F205E1aC7698F59EdbAa0a28C4A4c4ed605b722#code",
  "https://docs.ondo.finance/qualified-access-products/ousg/instant-limits",
] as const;

export interface ChainlinkNavRedemptionCapacityParams {
  managerAddress: string;
  usdcAddress: string;
  routerAddress: string;
  sourceAddress: string;
  pauseSelector?: string;
}

export interface ChainlinkNavParams {
  oracleAddress: string;
  tokenAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  sourceKey?: string;
  /** "latestRoundData" (default) = standard AggregatorV3Interface;
   *  "getPrice" = Ondo-style oracle returning a single uint256 with 18 decimals.
   *  "getPriceData" = Ondo-style oracle returning uint256 price + uint256 timestamp.
   *  "getAssetPrice" = Ondo oracle router returning a token-scoped uint256 with 18 decimals. */
  oracleMethod?: "latestRoundData" | "getPrice" | "getPriceData" | "getAssetPrice";
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
  redemptionCapacity?: ChainlinkNavRedemptionCapacityParams;
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

function parseAddressResult(raw: string | null): `0x${string}` | null {
  const address = decodeAddressWord(raw);
  return address ? address.toLowerCase() as `0x${string}` : null;
}

function decodeDecimalsResult(raw: bigint | null, source: string): number {
  if (raw == null) {
    throw new Error(`chainlink-nav: ${source} decimals() call failed`);
  }
  try {
    return validateDecimals(raw, `chainlink-nav: ${source} decimals`);
  } catch {
    throw new Error(`chainlink-nav: ${source} decimals out of range (${raw})`);
  }
}

async function probeRedemptionCapacity(
  params: ChainlinkNavParams,
  onchain: OnchainCallers,
): Promise<LiveReserveRedemptionTelemetry | null> {
  const redemption = params.redemptionCapacity;
  if (!redemption) return null;

  try {
    const tokenAndUsdcArgs = `${encodeAddress(params.tokenAddress)}${encodeAddress(redemption.usdcAddress)}`;
    const [routerRaw, sourceRaw, pausedRaw, acceptedRaw, minimumRedemptionRaw, capacityRaw] = await Promise.all([
      onchain.raw(redemption.managerAddress, ONDO_TOKEN_ROUTER_SELECTOR),
      onchain.raw(
        redemption.routerAddress,
        `${WITHDRAW_TOKEN_SOURCES_SELECTOR}${tokenAndUsdcArgs}${encodeUint256(0n)}`,
      ),
      onchain.raw(redemption.managerAddress, redemption.pauseSelector ?? DEFAULT_REDEEM_PAUSED_SELECTOR),
      onchain.raw(
        redemption.managerAddress,
        `${ACCEPTED_REDEMPTION_TOKENS_SELECTOR}${encodeAddress(redemption.usdcAddress)}`,
      ),
      onchain.uint256(redemption.managerAddress, MINIMUM_REDEMPTION_USD_SELECTOR),
      onchain.uint256(
        redemption.routerAddress,
        `${AVAILABLE_TO_WITHDRAW_SELECTOR}${tokenAndUsdcArgs}${encodeUint256(0n)}`,
      ),
    ]);

    const routerAddress = parseAddressResult(routerRaw);
    const sourceAddress = parseAddressResult(sourceRaw);
    const paused = decodeStrictBoolWord(pausedRaw);
    const acceptsUsdc = decodeStrictBoolWord(acceptedRaw);
    if (
      routerAddress !== redemption.routerAddress.toLowerCase() ||
      sourceAddress !== redemption.sourceAddress.toLowerCase() ||
      paused == null ||
      acceptsUsdc == null ||
      minimumRedemptionRaw == null ||
      capacityRaw == null
    ) {
      return null;
    }

    const routeOpen = !paused && acceptsUsdc;
    return {
      capacityUsd: decimalNumberFromBigInt(capacityRaw, 6),
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: routeOpen ? "open" : "paused",
      routeStatusSource: "onchain",
      routeStatusReason: paused
        ? "OUSG InstantManager redeemPaused() is true"
        : acceptsUsdc
        ? "OUSG InstantManager redeemPaused() is false and USDC is accepted for redemption"
        : "OUSG InstantManager does not accept USDC for redemption",
      holderEligibility: "whitelisted-primary",
      settlementDelaySec: 0,
      minRedeemUsd: decimalNumberFromBigInt(minimumRedemptionRaw, 18),
      sourceUrls: [...ONDO_OUSG_REDEMPTION_SOURCE_URLS],
    };
  } catch {
    return null;
  }
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

function readChainlinkNavParams(config: LiveReservesConfig): ChainlinkNavParams {
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
        ...(params.sourceKey ? { sourceKey: params.sourceKey } : {}),
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
      ...freshnessMetadataFromTimestamp(
        data.updatedAt > 0 ? data.updatedAt : null,
        "onchain-oracle-getprice",
        "chainlink-nav getPrice() mode does not expose an oracle update timestamp",
      ),
      ...(!params.redemptionCapacity
        ? { redemption: buildDocumentedRedemptionTelemetry(data.updatedAt > 0 ? data.updatedAt : null) }
        : {}),
    },
  };
}

/**
 * Shared NAV-read core. Fetches oracle + token data, validates freshness, and
 * produces an AdapterResult. Used by both `chainlink-nav` and
 * `superstate-liquidity` registry-bound adapters.
 */
export async function fetchChainlinkNavCore(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-nav");
  const params = readChainlinkNavParams(config);
  const method = params.oracleMethod ?? "latestRoundData";

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  // Ondo variants keep their independent token reads in flight with the
  // method-specific oracle path. Standard Chainlink reads are one same-chain
  // aggregate because every target and calldata value is known up front.
  const tokenDecimalsP = method === "latestRoundData"
    ? null
    : onchain.uint256(params.tokenAddress, DECIMALS_SELECTOR);
  const totalSupplyP = method === "latestRoundData"
    ? null
    : onchain.uint256(params.tokenAddress, TOTAL_SUPPLY_SELECTOR);
  let rawTokenDecimals: bigint | null = null;
  let rawTotalSupply: bigint | null = null;

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
    const rawPrice = await onchain.uint256(params.oracleAddress, GET_PRICE_SELECTOR);
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
  } else if (method === "getPriceData") {
    const rawPriceData = await onchain.raw(params.oracleAddress, GET_PRICE_DATA_SELECTOR);
    if (rawPriceData == null) {
      throw new Error("chainlink-nav: getPriceData() call failed");
    }

    const parsed = parseOndoPriceData(rawPriceData);
    navPerToken = parsed.price;
    navDecimals = 18;
    roundId = 0n;
    updatedAt = parsed.updatedAt;
    oracleTimestampSource = "ondo-price-data";
  } else if (method === "getAssetPrice") {
    const rawPrice = await onchain.uint256(
      params.oracleAddress,
      `${GET_ASSET_PRICE_SELECTOR}${encodeAddress(params.tokenAddress)}`,
    );
    if (rawPrice == null) {
      throw new Error("chainlink-nav: getAssetPrice(address) call failed");
    }

    navPerToken = rawPrice;
    navDecimals = 18;
    roundId = 0n;
    updatedAt = 0;
    oracleTimestampSource = "unavailable";

    const rawWrapperAddress = await onchain.raw(
      params.oracleAddress,
      `${TOKEN_TO_RWA_ORACLE_SELECTOR}${encodeAddress(params.tokenAddress)}`,
    );
    const wrapperAddress = parseAddressResult(rawWrapperAddress);
    if (wrapperAddress) {
      const rawPriceData = await onchain.raw(wrapperAddress, GET_PRICE_DATA_SELECTOR);
      if (rawPriceData != null) {
        try {
          const parsed = parseOndoPriceData(rawPriceData);
          navPerToken = parsed.price;
          updatedAt = parsed.updatedAt;
          oracleTimestampSource = "ondo-price-data";
        } catch (error) {
          warnings.push(reserveDegradedWarning(
            "chainlink-nav-wrapper-oracle-malformed",
            `chainlink-nav wrapper oracle at ${wrapperAddress} returned malformed getPriceData(): ${
              toErrorMessage(error)
            }`,
          ));
        }
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
    const feedReads = await fetchOnchainMulticall3({
      calls: [
        { label: "token-decimals", contract: params.tokenAddress, data: DECIMALS_SELECTOR },
        { label: "token-total-supply", contract: params.tokenAddress, data: TOTAL_SUPPLY_SELECTOR },
        { label: "oracle-decimals", contract: params.oracleAddress, data: DECIMALS_SELECTOR },
        { label: "oracle-latest-round-data", contract: params.oracleAddress, data: LATEST_ROUND_DATA_SELECTOR },
      ],
      chain: input.chain,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
    });
    const resultData = (label: string) => {
      const result = feedReads?.find((entry) => entry.label === label);
      return result?.success ? result.returnData : null;
    };
    rawTokenDecimals = decodeUint256Word(resultData("token-decimals"));
    rawTotalSupply = decodeUint256Word(resultData("token-total-supply"));
    const rawOracleDecimals = decodeUint256Word(resultData("oracle-decimals"));
    navDecimals = decodeDecimalsResult(rawOracleDecimals, "oracle");

    const rawRoundData = resultData("oracle-latest-round-data");
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
    const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    if (updatedAt > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
      throw new Error(`chainlink-nav: oracle data timestamp is in the future (${updatedAt - now}s)`);
    }
    const ageSec = now - updatedAt;
    if (ageSec > maxOracleAgeSec) {
      throw new Error(`chainlink-nav: oracle data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
    }
  }

  if (tokenDecimalsP && totalSupplyP) {
    [rawTokenDecimals, rawTotalSupply] = await Promise.all([tokenDecimalsP, totalSupplyP]);
  }
  const tokenDecimals = decodeDecimalsResult(rawTokenDecimals, "token");
  if (rawTotalSupply == null) {
    throw new Error("chainlink-nav: token totalSupply() call failed");
  }

  const adapted = adaptChainlinkNavResponse(
    {
      navPerToken,
      navDecimals,
      totalSupply: rawTotalSupply,
      tokenDecimals,
      roundId,
      updatedAt,
      oracleTimestampSource,
    },
    params,
  );
  if (params.redemptionCapacity) {
    const redemption = await probeRedemptionCapacity(params, onchain);
    if (redemption) {
      adapted.metadata = { ...adapted.metadata, redemption };
    }
  }
  return warnings.length > 0 ? { ...adapted, warnings } : adapted;
}
