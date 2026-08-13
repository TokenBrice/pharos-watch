import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import {
  fetchEvmStorageAtBlock,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { runAdapterIo } from "./concurrency";
import {
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import {
  EIP1967_IMPLEMENTATION_SLOT,
  implementationAddressFromSlot,
} from "./onchain-identity";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "usdai-hub";
const PYUSD_DECIMALS = 6;
const USDAI_DECIMALS = 18;
const PYUSD_TO_USDAI_SCALE = 10n ** BigInt(USDAI_DECIMALS - PYUSD_DECIMALS);

const SELECTORS = {
  baseToken: "0xc55dae63",
  bridgedSupply: "0x11c301e0",
  paused: "0x5c975abb",
} as const;

export type UsdaiHubParams = LiveReserveAdapterParamsByKey["usdai-hub"];

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

function rpcOptions(
  params: UsdaiHubParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): EvmRpcOptions {
  return {
    extraRpcUrls: [params.rpcUrl, params.fallbackRpcUrl].filter((url): url is string => url != null),
    signal,
    timeoutMs: 10_000,
    chainRpcs: ctx?.chainRpcs,
  };
}

async function readImplementationSlot(
  input: ReturnType<typeof requireOnchainInput>,
  params: UsdaiHubParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const raw = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:implementation-slot`,
    () => fetchEvmStorageAtBlock(
      input.chain,
      params.hubAddress,
      EIP1967_IMPLEMENTATION_SLOT,
      "latest",
      rpcOptions(params, signal, ctx),
    ),
    { signal },
  );
  const implementation = implementationAddressFromSlot(raw);
  if (implementation == null) {
    throw new Error(`${ADAPTER_KEY}: implementation slot returned malformed payload`);
  }
  return implementation;
}

function requireExpectedAddress(actual: string, expected: string, label: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY}: ${label} identity mismatch (${actual} != ${expected.toLowerCase()})`);
  }
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
    readImplementationSlot(input, params, signal, ctx),
  ]);

  const baseToken = requireAddress(rawBaseToken, "baseToken()");
  requireExpectedAddress(baseToken, params.baseTokenAddress, "baseToken()");
  requireExpectedAddress(implementation, params.implementationAddress, "EIP-1967 implementation");

  const baseTokenBalanceRaw = requireUint(rawBalance, "PYUSD balanceOf(hub)");
  const totalSupplyRaw = requireUint(rawTotalSupply, "totalSupply()");
  const bridgedSupplyRaw = requireUint(rawBridgedSupply, "bridgedSupply()");
  const paused = requireBool(rawPaused, "paused()");
  if (totalSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: totalSupply() returned zero`);
  }

  const bridgeSafeLiabilityRaw = totalSupplyRaw + bridgedSupplyRaw;
  if (baseTokenBalanceRaw * PYUSD_TO_USDAI_SCALE < bridgeSafeLiabilityRaw) {
    throw new Error(
      `${ADAPTER_KEY}: PYUSD balance is below bridge-safe USDai liabilities `
      + `(${baseTokenBalanceRaw} < ${bridgeSafeLiabilityRaw} at 6/18 decimals)`,
    );
  }

  const totalReserveUsd = decimalNumberFromBigInt(baseTokenBalanceRaw, PYUSD_DECIMALS);
  const supplyUsd = decimalNumberFromBigInt(bridgeSafeLiabilityRaw, USDAI_DECIMALS);
  const canonicalSupplyUsd = decimalNumberFromBigInt(totalSupplyRaw, USDAI_DECIMALS);
  const bridgedSupplyUsd = decimalNumberFromBigInt(bridgedSupplyRaw, USDAI_DECIMALS);
  const collateralizationRatio = totalReserveUsd / supplyUsd;
  if (![totalReserveUsd, supplyUsd, canonicalSupplyUsd, bridgedSupplyUsd, collateralizationRatio]
    .every(Number.isFinite)) {
    throw new Error(`${ADAPTER_KEY}: reserve/liability values are not finite`);
  }

  const capacityRouteStatus = REDEMPTION_BACKSTOP_CONFIGS[coin.id]?.routeStatus ?? "unknown";
  const routeStatus = paused ? "paused" : totalReserveUsd > 0 ? "open" : capacityRouteStatus;
  const routeStatusSource = paused || totalReserveUsd > 0 ? "onchain" : "static-config";
  const routeStatusReason = paused
    ? "USDai hub paused() returned true on-chain"
    : totalReserveUsd > 0
      ? "PYUSD balanceOf(hub) is positive and covers canonical plus bridged USDai liabilities"
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
    metadata: {
      ...notApplicableFreshnessMetadata(),
      totalSupplyRaw: totalSupplyRaw.toString(),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
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
