import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
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
import {
  decodeStrictAddressWord,
  decodeStrictBoolWord,
  decodeUint256Word,
  decodeUint8Word,
} from "./abi-decode";
import {
  multicallResultByLabel,
  readImplementationSlotAddress,
  requireExpectedAddress,
} from "./onchain-identity";
import { ERC4626_TOTAL_ASSETS_SELECTOR } from "./erc4626";
import { reserveDegradedWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";
import { readWrapperCoverage, wrapperCoverageResult } from "./wrapper-coverage";

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
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const wrapperAddress = params.wrapperAddress.toLowerCase();

  const [results, implementation] = await Promise.all([
    fetchOnchainMulticall3({
      calls: [
        { label: "pyusdx", contract: wrapperAddress, data: PYUSDX_SELECTOR },
        { label: "wrapper-supply", contract: wrapperAddress, data: TOTAL_SUPPLY_SELECTOR },
        { label: "wrapper-decimals", contract: wrapperAddress, data: DECIMALS_SELECTOR },
        {
          label: "underlying-balance",
          contract: params.underlyingToken,
          data: encodeBalanceOfCallData(wrapperAddress),
        },
        { label: "underlying-decimals", contract: params.underlyingToken, data: DECIMALS_SELECTOR },
        { label: "wrapper-paused", contract: wrapperAddress, data: PAUSED_SELECTOR },
        { label: "alternative-assets", contract: wrapperAddress, data: ERC4626_TOTAL_ASSETS_SELECTOR },
      ],
      chain: input.chain,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs: 12_000,
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
  if (!results) {
    throw new Error(`${ADAPTER_KEY}: Multicall3 state batch unavailable for ${coin.id}`);
  }
  requireExpectedAddress(ADAPTER_KEY, implementation, params.expectedImplementation, "EIP-1967 implementation");

  const pyusdxAddress = decodeStrictAddressWord(multicallResultByLabel(results, "pyusdx"));
  if (!pyusdxAddress) {
    throw new Error(`${ADAPTER_KEY}: pyusdx() returned malformed payload for ${coin.id}`);
  }
  requireExpectedAddress(ADAPTER_KEY, pyusdxAddress, params.underlyingToken, "pyusdx()");

  const alternativeAssetsRaw = decodeUint256Word(multicallResultByLabel(results, "alternative-assets"));
  if (alternativeAssetsRaw == null) {
    throw new Error(`${ADAPTER_KEY}: totalAssets() alternative-backing scope unavailable for ${coin.id}`);
  }
  if (alternativeAssetsRaw !== 0n) {
    throw new Error(`${ADAPTER_KEY}: non-PYUSDx backing ${alternativeAssetsRaw} requires a reviewed multi-asset reserve scope for ${coin.id}`);
  }

  const totalSupplyRaw = decodeUint256Word(multicallResultByLabel(results, "wrapper-supply"));
  if (totalSupplyRaw == null) {
    throw new Error(`${ADAPTER_KEY}: totalSupply() returned malformed payload for ${coin.id}`);
  }
  const underlyingBalanceRaw = decodeUint256Word(multicallResultByLabel(results, "underlying-balance"));
  if (underlyingBalanceRaw == null) {
    throw new Error(`${ADAPTER_KEY}: PYUSDx balanceOf(wrapper) returned malformed payload for ${coin.id}`);
  }
  const wrapperDecimals = decodeUint8Word(multicallResultByLabel(results, "wrapper-decimals"));
  const underlyingDecimals = decodeUint8Word(multicallResultByLabel(results, "underlying-decimals"));
  if (wrapperDecimals == null || underlyingDecimals == null) {
    throw new Error(`${ADAPTER_KEY}: decimals returned malformed payload for ${coin.id}`);
  }
  const paused = decodeStrictBoolWord(multicallResultByLabel(results, "wrapper-paused"));

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
