import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import {
  readImplementationSlotAddress,
  requireExpectedAddress,
} from "./onchain-identity";
import type { AdapterContext, AdapterResult } from "./types";
import { reserveDegradedWarning } from "./warnings";
import {
  addressObservation,
  boolObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
} from "./evm-observation-plan";

const ADAPTER_KEY = "usdai-hub";
const PYUSD_DECIMALS = 6;
const USDAI_DECIMALS = 18;
const PYUSD_TO_USDAI_SCALE = 10n ** BigInt(USDAI_DECIMALS - PYUSD_DECIMALS);

const SELECTORS = {
  baseToken: "0xc55dae63",
  bridgedSupply: "0x11c301e0",
  paused: "0x5c975abb",
} as const;

/**
 * Independently measures USDai's complete PYUSD liability on Arbitrum. The
 * hub totalSupply covers canonical USDai and bridgedSupply covers the USDai
 * already minted on satellite chains, so the sum is the bridge-safe liability
 * against the PYUSD balance held by the canonical hub.
 *
 * Implementation pin reviewed 2026-09-22: source-verified USDai v1.7 at
 * 0xe6ee2cd3e4f2b3844689aa1be176e4dff744a6f9 preserves baseToken(),
 * totalSupply(), bridgedSupply(), and pause evidence. Relative to the prior
 * v1.6 pin, only the OUSDaiUtility blacklist exemption and version change;
 * the imported staking interface adds referral-deposit declarations.
 */
export async function fetchUsdaiHubReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, ...params });
  ctx = plan.ctx;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const [observation, implementation] = await Promise.all([
    executeEvmObservationPlan({
      adapterKey: ADAPTER_KEY,
      fields: [
        addressObservation({ label: "baseToken()", contract: params.hubAddress, data: SELECTORS.baseToken }),
        uint256Observation({ label: "PYUSD balanceOf(hub)", contract: params.baseTokenAddress, data: encodeBalanceOfCallData(params.hubAddress) }),
        uint256Observation({ label: "totalSupply()", contract: params.hubAddress, data: TOTAL_SUPPLY_SELECTOR }),
        uint256Observation({ label: "bridgedSupply()", contract: params.hubAddress, data: SELECTORS.bridgedSupply }),
        boolObservation({ label: "paused()", contract: params.hubAddress, data: SELECTORS.paused }),
      ],
      read: (calls) => Promise.all(calls.map(async ({ label, contract, data }) => {
        const raw = await onchain.raw(contract, data);
        return { label, success: raw != null, returnData: (raw ?? "0x") as `0x${string}` };
      })),
      onFailure: (label) => {
        const kind = label === "baseToken()" ? "address" : label === "paused()" ? "bool" : "uint256";
        throw new Error(`${ADAPTER_KEY}: ${label} returned malformed ${kind} payload`);
      },
      onDecodeError: (error) => {
        throw new Error(`${ADAPTER_KEY}: ${error instanceof Error ? error.message : String(error)}`);
      },
    }),
    readImplementationSlotAddress({
      adapterKey: ADAPTER_KEY,
      input,
      contractAddress: params.hubAddress,
      params,
      signal,
      ctx,
    }),
  ]);

  const {
    "baseToken()": baseToken,
    "PYUSD balanceOf(hub)": baseTokenBalanceRaw,
    "totalSupply()": totalSupplyRaw,
    "bridgedSupply()": bridgedSupplyRaw,
    "paused()": paused,
  } = observation.values;
  requireExpectedAddress(ADAPTER_KEY, baseToken, params.baseTokenAddress, "baseToken()");
  requireExpectedAddress(ADAPTER_KEY, implementation, params.implementationAddress, "EIP-1967 implementation");

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
      observedBlock: plan.observedBlock,
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
