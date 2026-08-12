import { CANONICAL_ETH_RESERVE_RISK } from "@shared/lib/reserve-asset-risk";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  isReserveRisk,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveInfoWarning,
} from "./helpers";
import { rethrowIfAborted } from "../../lib/abort";

const ADAPTER_KEY = "yamato";
const YAMATO_VALUE_DECIMALS = 18;
const YAMATO_PERCENT_DENOMINATOR = 100;
const PERTENK_DENOMINATOR = 10_000;
// Same DefiLlama ETH/USD proxy the Liquity V1 adapter uses; Yamato's own oracle
// only quotes ETH in JPY, so the payout leg needs one external USD reference.
const WETH_ETHEREUM_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const DEFAULT_ETH_SLICE: YamatoSliceConfig = {
  name: "ETH",
  risk: CANONICAL_ETH_RESERVE_RISK,
};

const YAMATO_ABI = parseAbi([
  "function getStates() view returns (uint256 totalColl, uint256 totalDebt, uint8 MCR, uint8 RRR, uint8 SRR, uint8 GRR)",
  "function priceFeed() view returns (address)",
]);
const YAMATO_PRICE_FEED_ABI = parseAbi(["function getPrice() view returns (uint256)"]);
const YAMATO_REDEMPTION_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function priorityRegistry() view returns (address)",
]);
const PRIORITY_REGISTRY_ABI = parseAbi([
  "function yamato() view returns (address)",
  "function getRedeemablesCap() view returns (uint256)",
]);

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
export const YAMATO_PAUSED_SELECTOR = encodeFunctionData({
  abi: YAMATO_REDEMPTION_ABI,
  functionName: "paused",
});
export const YAMATO_PRIORITY_REGISTRY_SELECTOR = encodeFunctionData({
  abi: YAMATO_REDEMPTION_ABI,
  functionName: "priorityRegistry",
});
export const PRIORITY_REGISTRY_YAMATO_SELECTOR = encodeFunctionData({
  abi: PRIORITY_REGISTRY_ABI,
  functionName: "yamato",
});
export const PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR = encodeFunctionData({
  abi: PRIORITY_REGISTRY_ABI,
  functionName: "getRedeemablesCap",
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

export interface YamatoRedemptionProbe {
  paused: boolean;
  priorityRegistryAddress: string;
  redeemableCapJpyRaw: bigint;
}

interface YamatoAdaptOptions {
  yamatoAddress?: string;
  priceFeedAddress?: string;
  ethJpyPriceRaw?: bigint;
  slice?: YamatoSliceConfig;
  redemption?: YamatoRedemptionProbe;
  ethPriceUsd?: number;
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

/**
 * Same-run read of what `redeem(amount, false)` could actually pay a holder now.
 *
 * `redeem()` only touches pledges whose live ICR is under MCR, so system
 * collateral is not capacity: the protocol's own `getRedeemablesCap()` sums the
 * per-pledge redeemable fragments over the priority queue and is the only
 * aggregate bound the deployed contracts expose. The registry is resolved from
 * the Yamato proxy and then bound back to it through `yamato()`, so a swapped
 * registry withholds telemetry instead of publishing a foreign contract's cap.
 * Returns `null` when any leg fails, and the caller then omits the whole
 * capacity surface rather than guessing.
 */
export async function probeYamatoRedemption(
  onchain: ReturnType<typeof makeOnchainCallers>,
  yamatoAddress: string,
  signal: AbortSignal,
): Promise<YamatoRedemptionProbe | null> {
  try {
    const [pausedRaw, registryRaw] = await Promise.all([
      onchain.raw(yamatoAddress, YAMATO_PAUSED_SELECTOR),
      onchain.raw(yamatoAddress, YAMATO_PRIORITY_REGISTRY_SELECTOR),
    ]);
    if (!pausedRaw || !registryRaw) return null;

    const paused = decodeFunctionResult({
      abi: YAMATO_REDEMPTION_ABI,
      functionName: "paused",
      data: asHex(pausedRaw, "yamato paused()"),
    });
    const priorityRegistryAddress = decodeFunctionResult({
      abi: YAMATO_REDEMPTION_ABI,
      functionName: "priorityRegistry",
      data: asHex(registryRaw, "yamato priorityRegistry()"),
    }).toLowerCase();

    const registryOwnerRaw = await onchain.raw(priorityRegistryAddress, PRIORITY_REGISTRY_YAMATO_SELECTOR);
    if (!registryOwnerRaw) return null;
    const registryOwner = decodeFunctionResult({
      abi: PRIORITY_REGISTRY_ABI,
      functionName: "yamato",
      data: asHex(registryOwnerRaw, "priorityRegistry yamato()"),
    }).toLowerCase();
    if (registryOwner !== yamatoAddress.toLowerCase()) return null;

    const capRaw = await onchain.raw(priorityRegistryAddress, PRIORITY_REGISTRY_GET_REDEEMABLES_CAP_SELECTOR);
    if (!capRaw) return null;
    const redeemableCapJpyRaw = decodeFunctionResult({
      abi: PRIORITY_REGISTRY_ABI,
      functionName: "getRedeemablesCap",
      data: asHex(capRaw, "priorityRegistry getRedeemablesCap()"),
    });
    if (redeemableCapJpyRaw < 0n) return null;

    return { paused, priorityRegistryAddress, redeemableCapJpyRaw };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
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
  let routeStatus: "open" | "degraded" | "paused" = "open";
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

  const probe = options.redemption;
  if (probe?.paused) {
    routeStatus = "paused";
    routeStatusReason = "Yamato paused() is true in the same run and redeem() is guarded by whenNotPaused";
  }

  // Capacity is the protocol's own redeemable cap, converted through the price
  // redeem() itself uses and then floored by the collateral actually measured.
  let capacityMetadata: Record<string, unknown> = {};
  let redemptionCapacityMetadata: Record<string, unknown> = {};
  if (probe && options.ethJpyPriceRaw != null && options.ethJpyPriceRaw > 0n) {
    const redeemableCapJpy = decimalNumberFromBigInt(probe.redeemableCapJpyRaw, YAMATO_VALUE_DECIMALS);
    const capacityEthRaw =
      (probe.redeemableCapJpyRaw * 10n ** BigInt(YAMATO_VALUE_DECIMALS)) / options.ethJpyPriceRaw;
    const capacityEth = Math.min(decimalNumberFromBigInt(capacityEthRaw, YAMATO_VALUE_DECIMALS), totalCollateralEth);
    // A zero cap needs no price to be worth zero, so a missing ETH/USD quote
    // still publishes the honest "nothing is redeemable right now" reading.
    const capacityUsd =
      capacityEth === 0
        ? 0
        : options.ethPriceUsd != null && options.ethPriceUsd > 0
          ? capacityEth * options.ethPriceUsd
          : undefined;

    capacityMetadata = {
      priorityRegistryAddress: probe.priorityRegistryAddress,
      redeemableCapJpyRaw: probe.redeemableCapJpyRaw.toString(),
      redeemableCapJpy,
      redeemableCapEth: capacityEth,
      ...(options.ethPriceUsd != null ? { ethPriceUsd: options.ethPriceUsd } : {}),
      ...(capacityUsd != null ? { immediateRedeemableUsd: capacityUsd } : {}),
    };
    redemptionCapacityMetadata = {
      ...(capacityUsd != null
        ? {
            capacityUsd,
            // Each redeem() call stops at maxRedeemableCount pledges, so the
            // aggregate cap is a bounded rather than single-transaction number.
            capacityKind: "live-direct-bounded" as const,
          }
        : {}),
      capacityRatioOfSupply: redeemableCapJpy / totalDebtJpy,
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
      ...capacityMetadata,
      redemption: {
        ...redemptionCapacityMetadata,
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

  const [priceRaw, redemption] = await Promise.all([
    onchain.raw(priceFeedAddress, YAMATO_GET_PRICE_SELECTOR),
    probeYamatoRedemption(onchain, params.yamatoAddress, signal),
  ]);
  if (!priceRaw) {
    throw new Error("yamato priceFeed.getPrice() call failed");
  }

  // Only a non-zero cap needs an external price, so a healthy system with
  // nothing redeemable costs no extra request.
  let ethPriceUsd: number | undefined;
  if (redemption != null && redemption.redeemableCapJpyRaw > 0n) {
    ethPriceUsd = (
      await fetchDefiLlamaPrices([{ key: "ETH", chain: "ethereum", address: WETH_ETHEREUM_ADDRESS }], signal, ctx)
    ).get("ETH");
  }

  const warnings: LiveReserveWarning[] = [];
  if (redemption == null) {
    warnings.push(
      reserveInfoWarning(
        "yamato-redeemables-cap-unreadable",
        `Yamato ${params.yamatoAddress} did not return a matching paused()/priorityRegistry()/getRedeemablesCap() set this run; redemption capacity withheld`,
      ),
    );
  } else if (redemption.redeemableCapJpyRaw > 0n && ethPriceUsd == null) {
    warnings.push(
      reserveInfoWarning(
        "yamato-eth-price-unavailable",
        "Yamato adapter could not fetch ETH/USD from DefiLlama; redemption capacity withheld",
      ),
    );
  }

  return {
    ...adaptYamatoStates(decodeYamatoGetStates(statesRaw), {
      yamatoAddress: params.yamatoAddress,
      priceFeedAddress,
      ethJpyPriceRaw: decodeYamatoEthJpyPrice(priceRaw),
      slice: params.slice,
      ...(redemption ? { redemption } : {}),
      ...(ethPriceUsd != null ? { ethPriceUsd } : {}),
    }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
