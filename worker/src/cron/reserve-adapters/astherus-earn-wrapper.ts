import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeBalanceOfCallData, PAUSED_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictBoolWord } from "./abi-decode";
import { addressObservation, customObservation, executeEvmObservationPlan, uint256Observation } from "./evm-observation-plan";
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
    sourceKey: "astherus-earn-wrapper:usdf",
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
  coin: ReserveAdapterCoin,
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
  const snapshot = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: [
      addressObservation({
        label: "underlying-address", contract: params.earnAddress, data: USDF_SELECTOR,
        verify: (value) => {
          if (value !== params.expectedUnderlyingAddress.toLowerCase()) {
            throw new Error(`${ADAPTER_KEY} underlying-address identity drifted to ${value}; expected ${params.expectedUnderlyingAddress.toLowerCase()} for ${coin.id}`);
          }
          return null;
        },
      }),
      addressObservation({
        label: "share-address", contract: params.earnAddress, data: ASUSDF_SELECTOR,
        verify: (value) => {
          if (value !== params.expectedShareAddress.toLowerCase()) {
            throw new Error(`${ADAPTER_KEY} share-address identity drifted to ${value}; expected ${params.expectedShareAddress.toLowerCase()} for ${coin.id}`);
          }
          return null;
        },
      }),
      uint256Observation({
        label: "underlying-balance", contract: params.expectedUnderlyingAddress,
        data: encodeBalanceOfCallData(params.earnAddress),
      }),
      uint256Observation({ label: "share-total-supply", contract: params.expectedShareAddress, data: TOTAL_SUPPLY_SELECTOR }),
      uint256Observation({ label: "exchange-price", contract: params.earnAddress, data: EXCHANGE_PRICE_SELECTOR }),
      uint256Observation({ label: "unvested-amount", contract: params.earnAddress, data: GET_UNVESTED_AMOUNT_SELECTOR }),
      customObservation({
        label: "paused", contract: params.earnAddress, data: PAUSED_SELECTOR,
        allowFailure: true, optional: true, decode: decodeStrictBoolWord,
      }),
    ] as const,
    onFailure: (label) => {
      throw new Error(`${ADAPTER_KEY} ${label} ${label.endsWith("-address") ? "identity read" : "read"} failed for ${coin.id}`);
    },
    onDecodeError: (_error, label) => {
      throw new Error(`${ADAPTER_KEY} ${label} ${label.endsWith("-address") ? "identity read" : "read"} failed for ${coin.id}`);
    },
    read: async (calls) => {
      const results = await fetchOnchainMulticall3({
        calls, chain: input.chain, signal, ctx, rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl, timeoutMs: 12_000,
      });
      if (!results) throw new Error(`${ADAPTER_KEY} aggregate3 call failed for ${coin.id}`);
      return results;
    },
  });
  const {
    "underlying-address": underlyingAddress,
    "share-address": shareAddress,
    "underlying-balance": underlyingBalanceRaw,
    "share-total-supply": totalSupplyRaw,
    "exchange-price": exchangePriceRaw,
    "unvested-amount": unvestedAmountRaw,
    paused,
  } = snapshot.values;

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

  // Share price: net USDF held per asUSDF share. Published as details.sharePrice,
  // never as collateralizationRatio (it is a price, not a coverage ratio).
  const sharePrice = backingAmount / supplyAmount;
  if (!Number.isFinite(sharePrice) || sharePrice <= 0) {
    throw new Error(`${ADAPTER_KEY} share price is invalid for ${coin.id}`);
  }
  // Real assets ÷ liability: net USDF backing vs the share supply valued at the
  // same exchangePrice() the wrapper reports, so ≈1.0 when the two agree.
  const collateralizationRatio = backingAmount / (supplyAmount * exchangePrice);
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

  if (paused == null) {
    warnings.push(
      reserveInfoWarning(
        "astherus-earn-wrapper-pause-unavailable",
        `${ADAPTER_KEY} paused() could not be read; redemption route status is unknown`,
      ),
    );
  }
  const routeStatus = paused === true ? "paused" : "unknown";
  const routeStatusReason = paused == null
    ? "The optional paused() probe failed"
    : paused
      ? "asUSDFEarn paused() returned true"
      : "asUSDFEarn paused() returned false, but no redemption availability gate was observed";

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
        sharePrice,
      }),
      chain: input.chain,
      contractAddress: params.earnAddress,
      underlyingAmount: backingAmount,
      supplyTokens: supplyAmount,
      collateralizationRatio,
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus,
        ...(paused === true
          ? { routeStatusSource: "onchain" as const }
          : paused === false
            ? { routeStatusSource: "static-config" as const }
            : {}),
        routeStatusReason,
      },
    },
  };
}
