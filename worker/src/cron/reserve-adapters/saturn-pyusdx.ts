import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  fetchEvmStorageAtBlock,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import { runAdapterIo } from "./concurrency";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
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
  EIP1967_IMPLEMENTATION_SLOT,
  implementationAddressFromSlot,
  multicallResultByLabel,
} from "./onchain-identity";
import { ratioFromRaw } from "./slice-math";
import { reserveDegradedWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "saturn-pyusdx";
const PYUSDX_SELECTOR = "0xda6b76b8"; // pyusdx()

type SaturnPyusdxParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

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

function rpcOptions(
  params: SaturnPyusdxParams,
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

async function readImplementationAddress(
  input: ReturnType<typeof requireOnchainInput>,
  params: SaturnPyusdxParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const raw = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:implementation-slot`,
    () =>
      fetchEvmStorageAtBlock(
        input.chain,
        params.wrapperAddress,
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
    throw new Error(
      `${ADAPTER_KEY}: ${label} identity mismatch (${actual} != ${expected.toLowerCase()})`,
    );
  }
}

/**
 * Independently measures Saturn USDat's complete PYUSDx reserve on Ethereum.
 *
 * USDat migrated at block 25789911 from its legacy M-backed implementation to
 * a MoonPay/M0 MultiMint extension whose wrap/unwrap is 1:1 against PYUSDx.
 * The adapter fails closed unless the EIP-1967 implementation slot still
 * carries the reviewed MultiMint implementation and `pyusdx()` still resolves
 * to the reviewed PYUSDx token, then reads the wrapper's PYUSDx balance and
 * total supply in one Multicall3 round. The emitted PYUSDx slice maps to the
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
      ],
      chain: input.chain,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs: 12_000,
    }),
    readImplementationAddress(input, params, signal, ctx),
  ]);
  if (!results) {
    throw new Error(`${ADAPTER_KEY}: Multicall3 state batch unavailable for ${coin.id}`);
  }
  requireExpectedAddress(implementation, params.expectedImplementation, "EIP-1967 implementation");

  const pyusdxAddress = decodeStrictAddressWord(multicallResultByLabel(results, "pyusdx"));
  if (!pyusdxAddress) {
    throw new Error(`${ADAPTER_KEY}: pyusdx() returned malformed payload for ${coin.id}`);
  }
  requireExpectedAddress(pyusdxAddress, params.underlyingToken, "pyusdx()");

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
    message: (coveragePct) => `Saturn USDat PYUSDx balance covers ${coveragePct}% of USDat supply`,
    coverageRatio: collateralizationRatio,
  });
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

  const slice: ReserveSlice = {
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    coinId: params.slice.coinId,
    depType: params.slice.depType,
  };

  return {
    slices: [slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "saturn-pyusdx-wrapper-balance" }),
      chain: input.chain,
      wrapperAddress,
      implementationAddress: implementation,
      pyusdxAddress,
      totalSupplyRaw: totalSupplyRaw.toString(),
      wrapperDecimals,
      underlyingBalanceRaw: underlyingBalanceRaw.toString(),
      underlyingDecimals,
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      redemption: {
        capacityUsd,
        ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: paused === true ? "paused" : capacityUsd > 0 ? "open" : "unknown",
        routeStatusSource: "onchain" as const,
        ...(paused === true
          ? { routeStatusReason: "Saturn USDat MultiMint paused() returned true on-chain" }
          : {}),
        // Reviewed: USDat wrap/unwrap is KYC-gated through the PYUSDx
        // SwapFacility and the MultiMint retains whitelist controls.
        holderEligibility: "whitelisted-primary" as const,
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
      },
    },
  };
}
