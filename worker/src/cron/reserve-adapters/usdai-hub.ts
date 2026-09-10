import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import {
  readImplementationSlotAddress,
  requireExpectedAddress,
} from "./onchain-identity";
import type { AdapterContext, AdapterResult } from "./types";
import { reserveDegradedWarning } from "./warnings";

const ADAPTER_KEY = "usdai-hub";
const PYUSD_DECIMALS = 6;
const USDAI_DECIMALS = 18;
const PYUSD_TO_USDAI_SCALE = 10n ** BigInt(USDAI_DECIMALS - PYUSD_DECIMALS);

const SELECTORS = {
  baseToken: "0xc55dae63",
  bridgedSupply: "0x11c301e0",
  paused: "0x5c975abb",
} as const;

function requireUint(raw: string | null, label: string): bigint {
  const value = decodeUint256Word(raw);
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed payload`);
  return value;
}

function requireAddress(raw: string | null, label: string): string {
  const value = decodeStrictAddressWord(raw);
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed address payload`);
  return value.toLowerCase();
}

function requireBool(raw: string | null, label: string): boolean {
  const value = decodeStrictBoolWord(raw);
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} returned malformed bool payload`);
  return value;
}

/**
 * Independently measures USDai's complete PYUSD liability on Arbitrum. The
 * hub totalSupply covers canonical USDai and bridgedSupply covers the USDai
 * already minted on satellite chains, so the sum is the bridge-safe liability
 * against the PYUSD balance held by the canonical hub.
 *
 * Implementation pin reviewed 2026-08-14: source-verified USDai v1.5 at
 * 0x0ab74Df531c0D8f1c46643E404B3d14723bbc212 is a semantics-preserving
 * upgrade for baseToken(), totalSupply(), bridgedSupply(), and pause evidence.
 */
export async function fetchUsdaiHubReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const [[rawBaseToken, rawBalance, rawTotalSupply, rawBridgedSupply, rawPaused], implementation] = await Promise.all([
    Promise.all([
      onchain.raw(params.hubAddress, SELECTORS.baseToken),
      onchain.raw(params.baseTokenAddress, encodeBalanceOfCallData(params.hubAddress)),
      onchain.raw(params.hubAddress, TOTAL_SUPPLY_SELECTOR),
      onchain.raw(params.hubAddress, SELECTORS.bridgedSupply),
      onchain.raw(params.hubAddress, SELECTORS.paused),
    ]),
    readImplementationSlotAddress({
      adapterKey: ADAPTER_KEY,
      input,
      contractAddress: params.hubAddress,
      params,
      signal,
      ctx,
    }),
  ]);

  const baseToken = requireAddress(rawBaseToken, "baseToken()");
  requireExpectedAddress(ADAPTER_KEY, baseToken, params.baseTokenAddress, "baseToken()");
  requireExpectedAddress(ADAPTER_KEY, implementation, params.implementationAddress, "EIP-1967 implementation");

  const baseTokenBalanceRaw = requireUint(rawBalance, "PYUSD balanceOf(hub)");
  const totalSupplyRaw = requireUint(rawTotalSupply, "totalSupply()");
  const bridgedSupplyRaw = requireUint(rawBridgedSupply, "bridgedSupply()");
  const paused = requireBool(rawPaused, "paused()");

  const bridgeSafeLiabilityRaw = totalSupplyRaw + bridgedSupplyRaw;
  const warnings = [];
  if (baseTokenBalanceRaw * PYUSD_TO_USDAI_SCALE < bridgeSafeLiabilityRaw || bridgeSafeLiabilityRaw === 0n) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY}: observed PYUSD balance ${baseTokenBalanceRaw} against bridge-safe liability ${bridgeSafeLiabilityRaw} at 6/18 decimals`,
    ));
  }
  if (paused) warnings.push(reserveDegradedWarning("route-paused", "USDai hub paused() returned true on-chain"));

  const totalReserveUsd = decimalNumberFromBigInt(baseTokenBalanceRaw, PYUSD_DECIMALS);
  const supplyUsd = decimalNumberFromBigInt(bridgeSafeLiabilityRaw, USDAI_DECIMALS);
  const canonicalSupplyUsd = decimalNumberFromBigInt(totalSupplyRaw, USDAI_DECIMALS);
  const bridgedSupplyUsd = decimalNumberFromBigInt(bridgedSupplyRaw, USDAI_DECIMALS);
  const collateralizationRatio = supplyUsd > 0 ? totalReserveUsd / supplyUsd : undefined;
  if (![totalReserveUsd, supplyUsd, canonicalSupplyUsd, bridgedSupplyUsd].every(Number.isFinite) ||
      (collateralizationRatio !== undefined && !Number.isFinite(collateralizationRatio))) {
    throw new Error(`${ADAPTER_KEY}: reserve/liability values are not finite`);
  }

  const capacityRouteStatus = REDEMPTION_BACKSTOP_CONFIGS[coin.id]?.routeStatus ?? "unknown";
  const routeStatus = paused ? "paused" : totalReserveUsd > 0 ? "open" : capacityRouteStatus;
  const routeStatusSource = paused || totalReserveUsd > 0 ? "onchain" : "static-config";
  const routeStatusReason = paused
    ? "USDai hub paused() returned true on-chain"
    : totalReserveUsd > 0
      ? "PYUSD balanceOf(hub) is positive"
      : undefined;

  const slice: ReserveSlice = {
    name: "PYUSD held by the canonical USDai hub",
    pct: 100,
    risk: "low",
    coinId: "pyusd-paypal",
    depType: "collateral",
  };

  return {
    slices: [slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      totalSupplyRaw: totalSupplyRaw.toString(),
      totalReserveUsd,
      supplyUsd,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
      redemption: {
        capacityUsd: totalReserveUsd,
        capacityRaw: baseTokenBalanceRaw.toString(),
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        holderEligibility: params.redemptionCapacity.holderEligibility,
        settlementDelaySec: 0,
        routeStatus,
        routeStatusSource,
        ...(routeStatusReason ? { routeStatusReason } : {}),
        sourceUrls: [...params.redemptionCapacity.sourceUrls],
      },
      details: {
        hubAddress: params.hubAddress,
        baseTokenAddress: baseToken,
        implementationAddress: implementation,
        totalSupplyRaw: totalSupplyRaw.toString(),
        bridgedSupplyRaw: bridgedSupplyRaw.toString(),
        bridgeSafeLiabilityRaw: bridgeSafeLiabilityRaw.toString(),
        baseTokenBalanceRaw: baseTokenBalanceRaw.toString(),
        canonicalSupplyUsd,
        bridgedSupplyUsd,
        paused,
      },
    },
  };
}
