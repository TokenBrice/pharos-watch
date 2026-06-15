import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import { decodeAddressWord, decodeBoolWord, decodeUint8Word } from "./abi-decode";
import { resolveCoinContractAddress } from "./evm";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "m0-wrapper-underlying";
const DEFAULT_M_TOKEN_SELECTOR = "0xc3b6f939"; // mToken()
const DEFAULT_SWAP_FACILITY_SELECTOR = "0xae06b7e4"; // swapFacility()
const DEFAULT_PAUSED_SELECTOR = "0x5c975abb"; // paused()
const DEFAULT_CAN_SWAP_VIA_PATH_SELECTOR = "0xd8e21132"; // canSwapViaPath(address,address,address)

const RATIO_SCALE = 1_000_000_000_000n;
type M0WrapperUnderlyingParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

interface SliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function normalizeAddress(address: string): `0x${string}` {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    throw new Error(`${ADAPTER_KEY} invalid EVM address: ${address}`);
  }
  return lower as `0x${string}`;
}

function encodeCanSwapViaPathCall(
  selector: string,
  swapper: string,
  fromToken: string,
  toToken: string,
): `0x${string}` {
  return `${selector}${encodeAddress(swapper)}${encodeAddress(fromToken)}${encodeAddress(toToken)}` as `0x${string}`;
}

function ratioFromRaw(numerator: bigint, denominator: bigint): number | undefined {
  if (denominator <= 0n) return undefined;
  if (numerator >= denominator) return 1;
  const ratio = Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
  return Number.isFinite(ratio) ? ratio : undefined;
}

function ratioFromTokenAmounts(
  numeratorRaw: bigint,
  numeratorDecimals: number,
  denominatorRaw: bigint,
  denominatorDecimals: number,
): number | undefined {
  if (denominatorRaw <= 0n) return undefined;
  if (numeratorDecimals === denominatorDecimals) {
    return ratioFromRaw(numeratorRaw, denominatorRaw);
  }
  const numerator = decimalNumberFromBigInt(numeratorRaw, numeratorDecimals);
  const denominator = decimalNumberFromBigInt(denominatorRaw, denominatorDecimals);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  return Math.min(1, numerator / denominator);
}

function collateralizationRatioFromTokenAmounts(
  numeratorRaw: bigint,
  numeratorDecimals: number,
  denominatorRaw: bigint,
  denominatorDecimals: number,
): number | undefined {
  const numerator = decimalNumberFromBigInt(numeratorRaw, numeratorDecimals);
  const denominator = decimalNumberFromBigInt(denominatorRaw, denominatorDecimals);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  return numerator / denominator;
}

function parseSliceConfig(params: M0WrapperUnderlyingParams): SliceConfig {
  return {
    name: params.slice.name,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
  };
}

export async function fetchM0WrapperUnderlyingReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const wrapperAddress = normalizeAddress(params.wrapperAddress ?? resolveCoinContractAddress(coin, input.chain) ?? "");
  const expectedMTokenAddress = params.expectedMTokenAddress
    ? normalizeAddress(params.expectedMTokenAddress)
    : null;
  const timeoutMs = 12_000;

  const mTokenRaw = await fetchOnchainRawCall({
    contract: wrapperAddress,
    data: params.mTokenSelector ?? DEFAULT_M_TOKEN_SELECTOR,
    signal,
    ctx,
    rpcMode: input.rpcMode,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });
  const mTokenAddress = decodeAddressWord(mTokenRaw)?.toLowerCase() as `0x${string}` | undefined;
  if (!mTokenAddress) {
    throw new Error(`${ADAPTER_KEY} could not read mToken() for ${coin.id}`);
  }
  if (expectedMTokenAddress && mTokenAddress !== expectedMTokenAddress) {
    throw new Error(`${ADAPTER_KEY} mToken() returned ${mTokenAddress}, expected ${expectedMTokenAddress}`);
  }

  const [totalSupplyRaw, wrapperDecimalsRaw, underlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
    fetchOnchainUint256({
      contract: wrapperAddress,
      data: TOTAL_SUPPLY_SELECTOR,
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    }),
    fetchOnchainRawCall({
      contract: wrapperAddress,
      data: DECIMALS_SELECTOR,
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    }),
    fetchOnchainUint256({
      contract: mTokenAddress,
      data: encodeBalanceOfCallData(wrapperAddress),
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    }),
    fetchOnchainRawCall({
      contract: mTokenAddress,
      data: DECIMALS_SELECTOR,
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    }),
  ]);
  if (totalSupplyRaw == null) throw new Error(`${ADAPTER_KEY} totalSupply() failed for ${coin.id}`);
  if (underlyingBalanceRaw == null) throw new Error(`${ADAPTER_KEY} M balanceOf(wrapper) failed for ${coin.id}`);
  const wrapperDecimals = decodeUint8Word(wrapperDecimalsRaw);
  const underlyingDecimals = decodeUint8Word(underlyingDecimalsRaw);
  if (wrapperDecimals == null) throw new Error(`${ADAPTER_KEY} wrapper decimals invalid for ${coin.id}`);
  if (underlyingDecimals == null) throw new Error(`${ADAPTER_KEY} M decimals invalid for ${coin.id}`);

  let swapFacilityAddress: `0x${string}` | undefined;
  let swapFacilityPaused: boolean | null = null;
  let swapperCanRedeem: boolean | null = null;
  let routeStatus: "open" | "paused" | "cohort-limited" | "unknown" = "open";
  let routeStatusReason: string | undefined;
  const holderEligibility = params.mode === "m-extension" ? "whitelisted-primary" : "any-holder";

  if (params.mode === "m-extension") {
    const swapFacilityRaw = await fetchOnchainRawCall({
      contract: wrapperAddress,
      data: params.swapFacilitySelector ?? DEFAULT_SWAP_FACILITY_SELECTOR,
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    });
    swapFacilityAddress = decodeAddressWord(swapFacilityRaw)?.toLowerCase() as `0x${string}` | undefined;
    if (!swapFacilityAddress) {
      throw new Error(`${ADAPTER_KEY} could not read swapFacility() for ${coin.id}`);
    }
    if (params.expectedSwapFacilityAddress) {
      const expectedSwapFacilityAddress = normalizeAddress(params.expectedSwapFacilityAddress);
      if (swapFacilityAddress !== expectedSwapFacilityAddress) {
        throw new Error(
          `${ADAPTER_KEY} swapFacility() returned ${swapFacilityAddress}, expected ${expectedSwapFacilityAddress}`,
        );
      }
    }

    const [pausedRaw, canSwapRaw] = await Promise.all([
      fetchOnchainRawCall({
        contract: swapFacilityAddress,
        data: params.pausedSelector ?? DEFAULT_PAUSED_SELECTOR,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
        timeoutMs,
      }),
      params.swapperAddress
        ? fetchOnchainRawCall({
            contract: swapFacilityAddress,
            data: encodeCanSwapViaPathCall(
              params.canSwapViaPathSelector ?? DEFAULT_CAN_SWAP_VIA_PATH_SELECTOR,
              params.swapperAddress,
              wrapperAddress,
              mTokenAddress,
            ),
            signal,
            ctx,
            rpcMode: input.rpcMode,
            chain: input.chain,
            rpcUrl: params.rpcUrl,
            fallbackRpcUrl: params.fallbackRpcUrl,
            timeoutMs,
          })
        : Promise.resolve(null),
    ]);
    swapFacilityPaused = decodeBoolWord(pausedRaw);
    swapperCanRedeem = decodeBoolWord(canSwapRaw);
    if (swapFacilityPaused === true) {
      routeStatus = "paused";
      routeStatusReason = "M0 SwapFacility is paused for this extension route";
    } else if (swapperCanRedeem === false) {
      routeStatus = "cohort-limited";
      routeStatusReason = "Configured M0 swapper cannot redeem this extension into M";
    } else if (swapFacilityPaused == null || swapperCanRedeem == null) {
      routeStatus = "unknown";
      routeStatusReason = "Could not verify M0 SwapFacility redemption path status";
    }
  }

  const capacityUsd = decimalNumberFromBigInt(underlyingBalanceRaw, underlyingDecimals);
  const capacityRatioOfSupply = ratioFromTokenAmounts(
    underlyingBalanceRaw,
    underlyingDecimals,
    totalSupplyRaw,
    wrapperDecimals,
  );
  const collateralizationRatio = collateralizationRatioFromTokenAmounts(
    underlyingBalanceRaw,
    underlyingDecimals,
    totalSupplyRaw,
    wrapperDecimals,
  );
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `M0 wrapper underlying balance covers ${pct}% of wrapper supply`,
    coverageRatio: collateralizationRatio,
  });
  const sliceConfig = parseSliceConfig(params);

  return {
    slices: [
      {
        name: sliceConfig.name,
        pct: 100,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "m0-wrapper-underlying-balance",
        ...(expectedMTokenAddress ? { mTokenAddressMatchesExpected: true } : {}),
      }),
      chain: input.chain,
      wrapperAddress,
      mTokenAddress,
      totalSupplyRaw: totalSupplyRaw.toString(),
      wrapperDecimals,
      underlyingBalanceRaw: underlyingBalanceRaw.toString(),
      underlyingDecimals,
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      ...(swapFacilityAddress ? { swapFacilityAddress } : {}),
      ...(swapFacilityPaused != null ? { swapFacilityPaused } : {}),
      ...(swapperCanRedeem != null ? { swapperCanRedeem } : {}),
      redemption: {
        capacityUsd,
        ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus,
        routeStatusSource: "onchain" as const,
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility,
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
      },
    },
  };
}
