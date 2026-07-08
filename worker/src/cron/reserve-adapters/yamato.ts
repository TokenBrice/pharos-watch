import { CANONICAL_ETH_RESERVE_RISK } from "@shared/lib/reserve-asset-risk";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  isReserveRisk,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";

const ADAPTER_KEY = "yamato";
const YAMATO_VALUE_DECIMALS = 18;
const YAMATO_PERCENT_DENOMINATOR = 100;
const PERTENK_DENOMINATOR = 10_000;

const DEFAULT_ETH_SLICE: YamatoSliceConfig = {
  name: "ETH",
  risk: CANONICAL_ETH_RESERVE_RISK,
};

const YAMATO_ABI = parseAbi([
  "function getStates() view returns (uint256 totalColl, uint256 totalDebt, uint8 MCR, uint8 RRR, uint8 SRR, uint8 GRR)",
  "function priceFeed() view returns (address)",
]);
const YAMATO_PRICE_FEED_ABI = parseAbi(["function getPrice() view returns (uint256)"]);

export const YAMATO_GET_STATES_SELECTOR = encodeFunctionData({
  abi: YAMATO_ABI,
  functionName: "getStates",
});
export const YAMATO_PRICE_FEED_SELECTOR = encodeFunctionData({
  abi: YAMATO_ABI,
  functionName: "priceFeed",
});
export const YAMATO_GET_PRICE_SELECTOR = encodeFunctionData({
  abi: YAMATO_PRICE_FEED_ABI,
  functionName: "getPrice",
});

export interface YamatoStates {
  totalCollateralRaw: bigint;
  totalDebtRaw: bigint;
  mcrPct: number;
  rrrPct: number;
  srrPct: number;
  grrPct: number;
}

interface YamatoSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface YamatoParams {
  yamatoAddress: string;
  priceFeedAddress?: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  slice: YamatoSliceConfig;
}

interface YamatoAdaptOptions {
  yamatoAddress?: string;
  priceFeedAddress?: string;
  ethJpyPriceRaw?: bigint;
  slice?: YamatoSliceConfig;
}

function asHex(raw: string, context: string): `0x${string}` {
  if (!raw.startsWith("0x")) {
    throw new Error(`${context} returned non-hex data`);
  }
  return raw as `0x${string}`;
}

function uint8Result(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error(`yamato getStates() returned invalid ${field}`);
  }
  return parsed;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSlice(params: Record<string, unknown>): YamatoSliceConfig {
  const raw = params.slice;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_ETH_SLICE;
  }
  const slice = raw as Record<string, unknown>;
  const name =
    typeof slice.name === "string" && slice.name.trim().length > 0 ? slice.name.trim() : DEFAULT_ETH_SLICE.name;
  const risk = isReserveRisk(slice.risk) ? slice.risk : DEFAULT_ETH_SLICE.risk;
  const coinId = typeof slice.coinId === "string" && slice.coinId.trim().length > 0 ? slice.coinId.trim() : undefined;
  const depType =
    typeof slice.depType === "string" && slice.depType.trim().length > 0
      ? (slice.depType as ReserveSlice["depType"])
      : undefined;

  return {
    name,
    risk,
    ...(coinId ? { coinId } : {}),
    ...(depType ? { depType } : {}),
  };
}

function readParams(config: LiveReservesConfig): YamatoParams {
  const params = config.params ?? {};
  const yamatoAddress = optionalString(params, "yamatoAddress") ?? optionalString(params, "contractAddress");
  if (!yamatoAddress) {
    throw new Error("yamato adapter params invalid.yamatoAddress: expected contract address string");
  }

  return {
    yamatoAddress,
    priceFeedAddress: optionalString(params, "priceFeedAddress"),
    rpcUrl: optionalString(params, "rpcUrl"),
    fallbackRpcUrl: optionalString(params, "fallbackRpcUrl"),
    slice: readSlice(params),
  };
}

export function decodeYamatoGetStates(raw: string): YamatoStates {
  const decoded = decodeFunctionResult({
    abi: YAMATO_ABI,
    functionName: "getStates",
    data: asHex(raw, "yamato getStates()"),
  }) as readonly [bigint, bigint, unknown, unknown, unknown, unknown];

  return {
    totalCollateralRaw: decoded[0],
    totalDebtRaw: decoded[1],
    mcrPct: uint8Result(decoded[2], "MCR"),
    rrrPct: uint8Result(decoded[3], "RRR"),
    srrPct: uint8Result(decoded[4], "SRR"),
    grrPct: uint8Result(decoded[5], "GRR"),
  };
}

function decodeYamatoPriceFeedAddress(raw: string): string {
  return decodeFunctionResult({
    abi: YAMATO_ABI,
    functionName: "priceFeed",
    data: asHex(raw, "yamato priceFeed()"),
  }).toLowerCase();
}

function decodeYamatoEthJpyPrice(raw: string): bigint {
  return decodeFunctionResult({
    abi: YAMATO_PRICE_FEED_ABI,
    functionName: "getPrice",
    data: asHex(raw, "yamato priceFeed.getPrice()"),
  });
}

export function adaptYamatoStates(states: YamatoStates, options: YamatoAdaptOptions = {}): AdapterResult {
  if (states.totalCollateralRaw <= 0n) {
    throw new Error("yamato getStates() returned zero collateral");
  }
  if (states.totalDebtRaw <= 0n) {
    throw new Error("yamato getStates() returned zero debt");
  }

  const slice = options.slice ?? DEFAULT_ETH_SLICE;
  const totalCollateralEth = decimalNumberFromBigInt(states.totalCollateralRaw, YAMATO_VALUE_DECIMALS);
  const totalDebtJpy = decimalNumberFromBigInt(states.totalDebtRaw, YAMATO_VALUE_DECIMALS);
  const minimumCollateralRatio = states.mcrPct / YAMATO_PERCENT_DENOMINATOR;
  const thresholdMetadata = {
    mcrRaw: states.mcrPct,
    rrrRaw: states.rrrPct,
    srrRaw: states.srrPct,
    grrRaw: states.grrPct,
    minimumCollateralRatio,
    minimumCollateralRatioPct: states.mcrPct,
    minimumCollateralRatioPerTenThousand: states.mcrPct * (PERTENK_DENOMINATOR / YAMATO_PERCENT_DENOMINATOR),
    redemptionReserveRatePct: states.rrrPct,
    sweepReserveRatePct: states.srrPct,
    gasReserveRatePct: states.grrPct,
  };

  let priceMetadata: Record<string, unknown> = {};
  let routeStatus: "open" | "degraded" = "open";
  let routeStatusReason: string | undefined;
  if (options.ethJpyPriceRaw != null) {
    if (options.ethJpyPriceRaw <= 0n) {
      throw new Error("yamato priceFeed.getPrice() returned zero ETH/JPY price");
    }
    const ethJpyPrice = decimalNumberFromBigInt(options.ethJpyPriceRaw, YAMATO_VALUE_DECIMALS);
    const totalCollateralJpy = totalCollateralEth * ethJpyPrice;
    const collateralizationRatio = totalCollateralJpy / totalDebtJpy;
    if (collateralizationRatio < minimumCollateralRatio) {
      routeStatus = "degraded";
      routeStatusReason = `System collateralization ratio ${collateralizationRatio.toFixed(3)} is below MCR ${minimumCollateralRatio.toFixed(3)}`;
    }
    priceMetadata = {
      ethJpyPriceRaw: options.ethJpyPriceRaw.toString(),
      ethJpyPrice,
      totalCollateralJpy,
      collateralizationRatio,
      collateralizationRatioPct: collateralizationRatio * YAMATO_PERCENT_DENOMINATOR,
      collateralizationRatioPerTenThousand: Math.round(collateralizationRatio * PERTENK_DENOMINATOR),
    };
  }

  return {
    slices: [
      {
        name: slice.name,
        pct: 100,
        risk: slice.risk,
        ...(slice.coinId ? { coinId: slice.coinId } : {}),
        ...(slice.depType ? { depType: slice.depType } : {}),
      },
    ],
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "yamato-get-states",
        freshnessReason: "same-run-onchain-state",
      }),
      ...(options.yamatoAddress ? { yamatoAddress: options.yamatoAddress } : {}),
      ...(options.priceFeedAddress ? { priceFeedAddress: options.priceFeedAddress } : {}),
      totalCollateralRaw: states.totalCollateralRaw.toString(),
      totalDebtRaw: states.totalDebtRaw.toString(),
      totalCollateralEth,
      totalDebtJpy,
      ...thresholdMetadata,
      ...priceMetadata,
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.yamato.fi/v/en",
          "https://github.com/DeFiGeek-Community/yamato",
        ],
      },
    },
  };
}

export async function fetchYamatoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const [statesRaw, priceFeedAddress] = await Promise.all([
    onchain.raw(params.yamatoAddress, YAMATO_GET_STATES_SELECTOR),
    params.priceFeedAddress
      ? Promise.resolve(params.priceFeedAddress)
      : onchain.raw(params.yamatoAddress, YAMATO_PRICE_FEED_SELECTOR).then((raw) => {
          if (!raw) throw new Error("yamato priceFeed() call failed");
          return decodeYamatoPriceFeedAddress(raw);
        }),
  ]);

  if (!statesRaw) {
    throw new Error("yamato getStates() call failed");
  }

  const priceRaw = await onchain.raw(priceFeedAddress, YAMATO_GET_PRICE_SELECTOR);
  if (!priceRaw) {
    throw new Error("yamato priceFeed.getPrice() call failed");
  }

  return adaptYamatoStates(decodeYamatoGetStates(statesRaw), {
    yamatoAddress: params.yamatoAddress,
    priceFeedAddress,
    ethJpyPriceRaw: decodeYamatoEthJpyPrice(priceRaw),
    slice: params.slice,
  });
}
