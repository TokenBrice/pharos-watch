import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getPublicRpcUrl } from "../../lib/public-rpc-registry";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import { decodeAddressWord, decodeBoolWord, decodeUint8Word } from "./abi-decode";
import { normalizeEvmAddress, resolveCoinContractAddress } from "./evm";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  type OnchainCallers,
} from "./helpers";
import { ratioFromRaw } from "./slice-math";
import { reserveDegradedWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "m0-wrapper-underlying";
const DEFAULT_M_TOKEN_SELECTOR = "0xc3b6f939"; // mToken()
const DEFAULT_SWAP_FACILITY_SELECTOR = "0xae06b7e4"; // swapFacility()
const DEFAULT_PAUSED_SELECTOR = "0x5c975abb"; // paused()
const DEFAULT_CAN_SWAP_VIA_PATH_SELECTOR = "0xd8e21132"; // canSwapViaPath(address,address,address)

type M0WrapperUnderlyingParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

interface SliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function normalizeAddress(address: string): `0x${string}` {
  const normalized = normalizeEvmAddress(address);
  if (!normalized) {
    throw new Error(`${ADAPTER_KEY} invalid EVM address: ${address}`);
  }
  return normalized as `0x${string}`;
}

function encodeCanSwapViaPathCall(
  selector: string,
  swapper: string,
  fromToken: string,
  toToken: string,
): `0x${string}` {
  return `${selector}${encodeAddress(swapper)}${encodeAddress(fromToken)}${encodeAddress(toToken)}` as `0x${string}`;
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

interface WrapperUnderlyingBalances {
  mTokenAddress: `0x${string}`;
  totalSupplyRaw: bigint;
  wrapperDecimals: number;
  underlyingBalanceRaw: bigint;
  underlyingDecimals: number;
}

// Reads mToken()/totalSupply()/decimals()/M-balance for one wrapper deployment.
// Shared by the primary chain and each `additionalDeployments` entry so a
// multichain coin's coverage ratio is computed from the true sum of supply and
// backing across every deployment rather than a single chain's snapshot.
async function readWrapperUnderlyingBalances(
  onchain: OnchainCallers,
  wrapperAddress: `0x${string}`,
  mTokenSelector: string,
  expectedMTokenAddress: `0x${string}` | null,
  coinId: string,
  deploymentLabel: string,
): Promise<WrapperUnderlyingBalances> {
  const mTokenRaw = await onchain.raw(wrapperAddress, mTokenSelector);
  const mTokenAddress = decodeAddressWord(mTokenRaw)?.toLowerCase() as `0x${string}` | undefined;
  if (!mTokenAddress) {
    throw new Error(`${ADAPTER_KEY} could not read mToken() for ${coinId}${deploymentLabel}`);
  }
  if (expectedMTokenAddress && mTokenAddress !== expectedMTokenAddress) {
    throw new Error(
      `${ADAPTER_KEY} mToken() returned ${mTokenAddress}, expected ${expectedMTokenAddress}${deploymentLabel}`,
    );
  }

  const [totalSupplyRaw, wrapperDecimalsRaw, underlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
    onchain.uint256(wrapperAddress, TOTAL_SUPPLY_SELECTOR),
    onchain.raw(wrapperAddress, DECIMALS_SELECTOR),
    onchain.uint256(mTokenAddress, encodeBalanceOfCallData(wrapperAddress)),
    onchain.raw(mTokenAddress, DECIMALS_SELECTOR),
  ]);
  if (totalSupplyRaw == null) throw new Error(`${ADAPTER_KEY} totalSupply() failed for ${coinId}${deploymentLabel}`);
  if (underlyingBalanceRaw == null) {
    throw new Error(`${ADAPTER_KEY} M balanceOf(wrapper) failed for ${coinId}${deploymentLabel}`);
  }
  const wrapperDecimals = decodeUint8Word(wrapperDecimalsRaw);
  const underlyingDecimals = decodeUint8Word(underlyingDecimalsRaw);
  if (wrapperDecimals == null) throw new Error(`${ADAPTER_KEY} wrapper decimals invalid for ${coinId}${deploymentLabel}`);
  if (underlyingDecimals == null) throw new Error(`${ADAPTER_KEY} M decimals invalid for ${coinId}${deploymentLabel}`);

  return { mTokenAddress, totalSupplyRaw, wrapperDecimals, underlyingBalanceRaw, underlyingDecimals };
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
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const primary = await readWrapperUnderlyingBalances(
    onchain,
    wrapperAddress,
    params.mTokenSelector ?? DEFAULT_M_TOKEN_SELECTOR,
    expectedMTokenAddress,
    coin.id,
    "",
  );
  const { mTokenAddress, wrapperDecimals, underlyingDecimals } = primary;
  let totalSupplyRaw = primary.totalSupplyRaw;
  let underlyingBalanceRaw = primary.underlyingBalanceRaw;

  const additionalDeployments = params.additionalDeployments ?? [];
  const deploymentBreakdown = [
    {
      chain: input.chain,
      totalSupplyRaw: primary.totalSupplyRaw.toString(),
      underlyingBalanceRaw: primary.underlyingBalanceRaw.toString(),
    },
  ];

  if (additionalDeployments.length > 0) {
    // Fail-closed: any additional-deployment read failure (RPC outage, decoding
    // failure, decimals mismatch) throws rather than computing coverage from
    // whichever deployments happened to succeed — a partial-chain aggregate is
    // exactly the false-snapshot failure mode this aggregation exists to fix.
    const additionalReads = await Promise.all(
      additionalDeployments.map(async (deployment) => {
        const deploymentRpcUrl = deployment.rpcUrl ?? getPublicRpcUrl(deployment.chain);
        if (!deploymentRpcUrl) {
          throw new Error(
            `${ADAPTER_KEY} no RPC URL available for additional deployment ${deployment.chain} on ${coin.id} (refusing partial aggregate)`,
          );
        }
        const deploymentOnchain = makeOnchainCallers(
          { chain: deployment.chain, rpcMode: "public-rpc" },
          { signal, ctx, rpcUrl: deploymentRpcUrl, timeoutMs },
        );
        const reads = await readWrapperUnderlyingBalances(
          deploymentOnchain,
          wrapperAddress,
          params.mTokenSelector ?? DEFAULT_M_TOKEN_SELECTOR,
          mTokenAddress,
          coin.id,
          ` on additional deployment ${deployment.chain} (refusing partial aggregate)`,
        );
        if (reads.wrapperDecimals !== wrapperDecimals || reads.underlyingDecimals !== underlyingDecimals) {
          throw new Error(
            `${ADAPTER_KEY} decimals mismatch on additional deployment ${deployment.chain} for ${coin.id} (refusing partial aggregate)`,
          );
        }
        return { chain: deployment.chain, ...reads };
      }),
    );

    for (const reads of additionalReads) {
      totalSupplyRaw += reads.totalSupplyRaw;
      underlyingBalanceRaw += reads.underlyingBalanceRaw;
      deploymentBreakdown.push({
        chain: reads.chain,
        totalSupplyRaw: reads.totalSupplyRaw.toString(),
        underlyingBalanceRaw: reads.underlyingBalanceRaw.toString(),
      });
    }
  }

  let swapFacilityAddress: `0x${string}` | undefined;
  let swapFacilityPaused: boolean | null = null;
  let swapperCanRedeem: boolean | null = null;
  let routeStatus: "open" | "paused" | "cohort-limited" | "unknown" = "open";
  let routeStatusReason: string | undefined;
  const holderEligibility = params.mode === "m-extension" ? "whitelisted-primary" : "any-holder";

  if (params.mode === "m-extension") {
    const swapFacilityRaw = await onchain.raw(
      wrapperAddress,
      params.swapFacilitySelector ?? DEFAULT_SWAP_FACILITY_SELECTOR,
    );
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
      onchain.raw(swapFacilityAddress, params.pausedSelector ?? DEFAULT_PAUSED_SELECTOR),
      params.swapperAddress
        ? onchain.raw(
            swapFacilityAddress,
            encodeCanSwapViaPathCall(
              params.canSwapViaPathSelector ?? DEFAULT_CAN_SWAP_VIA_PATH_SELECTOR,
              params.swapperAddress,
              wrapperAddress,
              mTokenAddress,
            ),
          )
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
  if (params.mode === "m-extension" && routeStatus === "unknown") {
    warnings.push(
      reserveDegradedWarning(
        "m0-extension-route-unverified",
        routeStatusReason ?? "Could not verify M0 SwapFacility redemption path status",
      ),
    );
  }
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
      ...(additionalDeployments.length > 0 ? { deployments: deploymentBreakdown } : {}),
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
