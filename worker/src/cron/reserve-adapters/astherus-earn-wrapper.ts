import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeBalanceOfCallData, PAUSED_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";

const ADAPTER_KEY = "astherus-earn-wrapper";
const USDF_SELECTOR = "0xb249b35d";
const ASUSDF_SELECTOR = "0x1d30e266";
const EXCHANGE_PRICE_SELECTOR = "0x9e65741e";
const GET_UNVESTED_AMOUNT_SELECTOR = "0xe7c2a608";
const TOKEN_DECIMALS = 18;
const EXCHANGE_PRICE_DECIMALS = 18;
const NAV_DIVERGENCE_TOLERANCE_BPS = 10;

type AstherusEarnWrapperParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

type MulticallResult = EvmMulticall3Result[] | null;

function successfulResult(results: MulticallResult, label: string): `0x${string}` | null {
  const result = results?.find((candidate) => candidate.label === label);
  return result?.success && result.returnData !== "0x" ? result.returnData : null;
}

function requireUint256(results: MulticallResult, label: string, coinId: string): bigint {
  const value = decodeUint256Word(successfulResult(results, label));
  if (value == null) {
    throw new Error(`${ADAPTER_KEY} ${label} read failed for ${coinId}`);
  }
  return value;
}

function requireIdentity(
  results: MulticallResult,
  label: string,
  expectedAddress: string,
  coinId: string,
): `0x${string}` {
  const observedAddress = decodeStrictAddressWord(successfulResult(results, label));
  if (!observedAddress) {
    throw new Error(`${ADAPTER_KEY} ${label} identity read failed for ${coinId}`);
  }
  const expected = expectedAddress.toLowerCase();
  if (observedAddress.toLowerCase() !== expected) {
    throw new Error(
      `${ADAPTER_KEY} ${label} identity drifted to ${observedAddress}; expected ${expected} for ${coinId}`,
    );
  }
  return observedAddress.toLowerCase() as `0x${string}`;
}

function ratioWithinTolerance(
  backingRaw: bigint,
  underlyingDecimals: number,
  supplyRaw: bigint,
  shareDecimals: number,
  exchangePriceRaw: bigint,
): boolean {
  const underlyingScale = 10n ** BigInt(underlyingDecimals);
  const shareScale = 10n ** BigInt(shareDecimals);
  const exchangePriceScale = 10n ** BigInt(EXCHANGE_PRICE_DECIMALS);
  const computedNumerator = backingRaw * shareScale * exchangePriceScale;
  const reportedNumerator = supplyRaw * underlyingScale * exchangePriceRaw;
  const difference = computedNumerator >= reportedNumerator
    ? computedNumerator - reportedNumerator
    : reportedNumerator - computedNumerator;
  return difference * 10_000n <= reportedNumerator * BigInt(NAV_DIVERGENCE_TOLERANCE_BPS);
}

function readSlice(params: AstherusEarnWrapperParams): ReserveSlice {
  return {
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
  };
}

/**
 * Reads Astherus's custom asUSDFEarn wrapper. It is not ERC-4626: the earn
 * contract exposes USDF()/asUSDF(), while the underlying balance and share
 * supply live on the two returned token contracts. The published backing is
 * net USDF balance after subtracting getUnvestedAmount(), because unvested
 * strategy yield is not yet attributable to the wrapper's redeemable backing.
 */
export async function fetchAstherusEarnWrapperReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain !== "bsc") {
    throw new Error(`${ADAPTER_KEY} only supports bsc, got "${input.chain}"`);
  }
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  if (params.underlyingDecimals !== TOKEN_DECIMALS || params.shareDecimals !== TOKEN_DECIMALS) {
    throw new Error(`${ADAPTER_KEY} token decimals must remain pinned to ${TOKEN_DECIMALS} for ${coin.id}`);
  }
  const calls = [
    { label: "underlying-address", contract: params.earnAddress, data: USDF_SELECTOR },
    { label: "share-address", contract: params.earnAddress, data: ASUSDF_SELECTOR },
    {
      label: "underlying-balance",
      contract: params.expectedUnderlyingAddress,
      data: encodeBalanceOfCallData(params.earnAddress),
    },
    { label: "share-total-supply", contract: params.expectedShareAddress, data: TOTAL_SUPPLY_SELECTOR },
    { label: "exchange-price", contract: params.earnAddress, data: EXCHANGE_PRICE_SELECTOR },
    { label: "unvested-amount", contract: params.earnAddress, data: GET_UNVESTED_AMOUNT_SELECTOR },
    { label: "paused", contract: params.earnAddress, data: PAUSED_SELECTOR, allowFailure: true },
  ] as const;

  const results = await fetchOnchainMulticall3({
    calls,
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: 12_000,
  });
  if (!results) {
    throw new Error(`${ADAPTER_KEY} aggregate3 call failed for ${coin.id}`);
  }

  const underlyingAddress = requireIdentity(
    results,
    "underlying-address",
    params.expectedUnderlyingAddress,
    coin.id,
  );
  const shareAddress = requireIdentity(results, "share-address", params.expectedShareAddress, coin.id);
  const underlyingBalanceRaw = requireUint256(results, "underlying-balance", coin.id);
  const totalSupplyRaw = requireUint256(results, "share-total-supply", coin.id);
  const exchangePriceRaw = requireUint256(results, "exchange-price", coin.id);
  const unvestedAmountRaw = requireUint256(results, "unvested-amount", coin.id);

  if (underlyingBalanceRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} USDF balance is zero for ${coin.id}`);
  }
  if (totalSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} asUSDF totalSupply is zero for ${coin.id}`);
  }
  if (exchangePriceRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} exchangePrice is zero for ${coin.id}`);
  }
  if (unvestedAmountRaw >= underlyingBalanceRaw) {
    throw new Error(`${ADAPTER_KEY} net USDF backing is non-positive for ${coin.id}`);
  }

  const netBackingRaw = underlyingBalanceRaw - unvestedAmountRaw;
  const backingAmount = decimalNumberFromBigInt(netBackingRaw, params.underlyingDecimals);
  const supplyAmount = decimalNumberFromBigInt(totalSupplyRaw, params.shareDecimals);
  const exchangePrice = decimalNumberFromBigInt(exchangePriceRaw, EXCHANGE_PRICE_DECIMALS);
  if (!Number.isFinite(backingAmount) || backingAmount <= 0) {
    throw new Error(`${ADAPTER_KEY} net USDF backing is invalid for ${coin.id}`);
  }
  if (!Number.isFinite(supplyAmount) || supplyAmount <= 0) {
    throw new Error(`${ADAPTER_KEY} asUSDF supply is invalid for ${coin.id}`);
  }
  if (!Number.isFinite(exchangePrice) || exchangePrice <= 0) {
    throw new Error(`${ADAPTER_KEY} exchangePrice is invalid for ${coin.id}`);
  }

  const collateralizationRatio = backingAmount / supplyAmount;
  if (!Number.isFinite(collateralizationRatio) || collateralizationRatio <= 0) {
    throw new Error(`${ADAPTER_KEY} backing coverage is invalid for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];
  if (!ratioWithinTolerance(
    netBackingRaw,
    params.underlyingDecimals,
    totalSupplyRaw,
    params.shareDecimals,
    exchangePriceRaw,
  )) {
    warnings.push(
      reserveDegradedWarning(
        "erc4626-nav-divergence",
        `${ADAPTER_KEY} net USDF backing / asUSDF supply diverges from exchangePrice() by more than ${NAV_DIVERGENCE_TOLERANCE_BPS} bps`,
      ),
    );
  }
  warnings.push(...buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `${ADAPTER_KEY} net USDF backing covers ${pct}% of asUSDF supply`,
    coverageRatio: collateralizationRatio,
    thresholdRatio: 1,
  }));

  const paused = decodeStrictBoolWord(successfulResult(results, "paused"));
  if (paused == null) {
    warnings.push(
      reserveInfoWarning(
        "astherus-earn-wrapper-pause-unavailable",
        `${ADAPTER_KEY} paused() could not be read; redemption route status is unknown`,
      ),
    );
  }
  const routeStatus = paused == null ? "unknown" : paused ? "paused" : "open";
  const routeStatusReason = paused == null
    ? "The optional paused() probe failed"
    : paused
      ? "asUSDFEarn paused() returned true"
      : "asUSDFEarn paused() returned false";

  return {
    slices: [readSlice(params)],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "astherus-earn-wrapper-net-usdf-balance",
        earnAddress: params.earnAddress,
        underlyingAddress,
        shareAddress,
        underlyingDecimals: params.underlyingDecimals,
        shareDecimals: params.shareDecimals,
        underlyingBalanceRaw: underlyingBalanceRaw.toString(),
        unvestedAmountRaw: unvestedAmountRaw.toString(),
        netBackingRaw: netBackingRaw.toString(),
        totalSupplyRaw: totalSupplyRaw.toString(),
        exchangePriceRaw: exchangePriceRaw.toString(),
      }),
      chain: input.chain,
      contractAddress: params.earnAddress,
      underlyingAmount: backingAmount,
      supplyTokens: supplyAmount,
      collateralizationRatio,
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        routeStatusReason,
      },
    },
  };
}
