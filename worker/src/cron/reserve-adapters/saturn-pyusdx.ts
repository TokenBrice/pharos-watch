import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import {
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import { decodeStrictBoolWord } from "./abi-decode";
import {
  readImplementationSlotAddress,
  requireExpectedAddress,
} from "./onchain-identity";
import { ERC4626_TOTAL_ASSETS_SELECTOR } from "./erc4626";
import { reserveDegradedWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";
import { readWrapperCoverage, wrapperCoverageResult } from "./wrapper-coverage";
import {
  addressObservation,
  boolObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
} from "./evm-observation-plan";

const ADAPTER_KEY = "saturn-pyusdx";
const PYUSDX_SELECTOR = "0xda6b76b8"; // pyusdx()

/**
 * Independently measures Saturn USDat's complete PYUSDx reserve on Ethereum.
 *
 * USDat migrated at block 25789911 from its legacy M-backed implementation to
 * a MoonPay/M0 MultiMint extension whose wrap/unwrap is 1:1 against PYUSDx.
 * The adapter fails closed unless the EIP-1967 implementation slot still
 * carries the reviewed MultiMint implementation and `pyusdx()` still resolves
 * to the reviewed PYUSDx token, then reads the wrapper's PYUSDx balance and
 * total supply in one Multicall3 round. MultiMint's totalAssets() counts only
 * non-PYUSDx backing, unlike ERC-4626; it must be zero for this single-asset
 * observation to cover the complete reserve scope. The emitted PYUSDx slice maps to the
 * tracked PayPal USD coin: M0 documents PYUSDx extensions as 1:1 PYUSDx
 * wrappers and PYUSDx as MoonPay's PYUSD-backed tokenization framework, so
 * the wrapper's 1:1 PYUSDx backing extends the claim to PYUSD.
 */
export async function fetchSaturnPyusdxReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const wrapperAddress = params.wrapperAddress.toLowerCase();
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, ...params });
  ctx = plan.ctx;

  const [observation, implementation] = await Promise.all([
    executeEvmObservationPlan({
      adapterKey: ADAPTER_KEY,
      fields: [
        addressObservation({ label: "pyusdx", contract: wrapperAddress, data: PYUSDX_SELECTOR }),
        uint256Observation({ label: "wrapper-supply", contract: wrapperAddress, data: TOTAL_SUPPLY_SELECTOR }),
        uint256Observation({ label: "wrapper-decimals", contract: wrapperAddress, data: DECIMALS_SELECTOR }),
        uint256Observation({
          label: "underlying-balance",
          contract: params.underlyingToken,
          data: encodeBalanceOfCallData(wrapperAddress),
        }),
        uint256Observation({ label: "underlying-decimals", contract: params.underlyingToken, data: DECIMALS_SELECTOR }),
        {
          ...boolObservation({ label: "wrapper-paused", contract: wrapperAddress, data: PAUSED_SELECTOR, optional: true }),
          // Unlike required backing, an unreadable pause probe remains a local
          // degraded route observation, including malformed ABI words.
          decode: decodeStrictBoolWord,
        },
        uint256Observation({ label: "alternative-assets", contract: wrapperAddress, data: ERC4626_TOTAL_ASSETS_SELECTOR }),
      ],
      read: async (calls) => {
        const results = await fetchOnchainMulticall3({
          calls,
          chain: input.chain,
          signal,
          ctx,
          rpcUrl: params.rpcUrl,
          fallbackRpcUrl: params.fallbackRpcUrl,
          timeoutMs: 12_000,
        });
        if (!results) throw new Error(`${ADAPTER_KEY}: Multicall3 state batch unavailable for ${coin.id}`);
        return results;
      },
      onFailure: (label) => { throw new Error(malformedMessage(label)); },
      onDecodeError: (_error, label) => { throw new Error(malformedMessage(label)); },
    }),
    readImplementationSlotAddress({
      adapterKey: ADAPTER_KEY,
      input,
      contractAddress: params.wrapperAddress,
      params,
      signal,
      ctx,
    }),
  ]);
  function malformedMessage(label: string): string {
    const reason = label === "alternative-assets" ? "totalAssets() alternative-backing scope unavailable"
      : label === "pyusdx" ? "pyusdx() returned malformed payload"
        : label === "wrapper-supply" ? "totalSupply() returned malformed payload"
          : label === "underlying-balance" ? "PYUSDx balanceOf(wrapper) returned malformed payload"
            : "decimals returned malformed payload";
    return `${ADAPTER_KEY}: ${reason} for ${coin.id}`;
  }
  requireExpectedAddress(ADAPTER_KEY, implementation, params.expectedImplementation, "EIP-1967 implementation");
  const {
    pyusdx: pyusdxAddress,
    "alternative-assets": alternativeAssetsRaw,
    "wrapper-supply": totalSupplyRaw,
    "underlying-balance": underlyingBalanceRaw,
    "wrapper-decimals": wrapperDecimalsRaw,
    "underlying-decimals": underlyingDecimalsRaw,
    "wrapper-paused": paused,
  } = observation.values;
  requireExpectedAddress(ADAPTER_KEY, pyusdxAddress, params.underlyingToken, "pyusdx()");

  if (alternativeAssetsRaw !== 0n) {
    throw new Error(`${ADAPTER_KEY}: non-PYUSDx backing ${alternativeAssetsRaw} requires a reviewed multi-asset reserve scope for ${coin.id}`);
  }

  if (wrapperDecimalsRaw > 255n || underlyingDecimalsRaw > 255n) {
    throw new Error(`${ADAPTER_KEY}: decimals returned malformed payload for ${coin.id}`);
  }
  const wrapperDecimals = Number(wrapperDecimalsRaw);
  const underlyingDecimals = Number(underlyingDecimalsRaw);

  const coverage = readWrapperCoverage({
    underlyingBalanceRaw,
    underlyingDecimals,
    totalSupplyRaw,
    wrapperDecimals,
  });
  const warnings = [];
  if (totalSupplyRaw === 0n) {
    warnings.push(
      reserveDegradedWarning(
        "reserve-undercollateralized",
        "Saturn USDat totalSupply() returned zero",
      ),
    );
  }
  if (paused === true) {
    warnings.push(
      reserveDegradedWarning("route-paused", "Saturn USDat MultiMint paused() returned true on-chain"),
    );
  }
  if (paused == null) {
    warnings.push(
      reserveDegradedWarning(
        "saturn-pyusdx-route-unverified",
        "Could not verify Saturn USDat MultiMint paused() route status",
      ),
    );
  }
  return wrapperCoverageResult({
    coverage,
    slice: {
      sourceKey: "saturn-pyusdx:pyusd",
      name: params.slice.name,
      pct: 100,
      risk: params.slice.risk,
      coinId: params.slice.coinId,
      depType: params.slice.depType,
    },
    warningMessage: (coveragePct) =>
      `Saturn USDat PYUSDx balance covers ${coveragePct}% of USDat supply`,
    warnings,
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "saturn-pyusdx-wrapper-balance" }),
      chain: input.chain,
      observedBlock: plan.observedBlock,
      wrapperAddress,
      implementationAddress: implementation,
      pyusdxAddress,
      alternativeAssetsRaw: alternativeAssetsRaw.toString(),
    },
    redemption: {
      routeStatus: paused === true
        ? "paused"
        : paused === false && coverage.capacityUsd > 0
          ? "open"
          : "unknown",
      routeStatusSource: paused == null ? "static-config" : "onchain",
      ...(paused === true
        ? { routeStatusReason: "Saturn USDat MultiMint paused() returned true on-chain" }
        : paused == null
          ? { routeStatusReason: "Could not verify Saturn USDat MultiMint paused() route status" }
          : {}),
      holderEligibility: "whitelisted-primary",
      ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
    },
  });
}
