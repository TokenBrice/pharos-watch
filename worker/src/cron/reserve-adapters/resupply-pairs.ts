import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeUint256Arg } from "../../lib/evm-selectors";
import {
  decimalNumberFromBigInt,
  fetchOnchainRawCall,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";
import { parseEvmAddressResult } from "./evm";

interface ResupplyUnderlyingDescriptor {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface ResupplyPairsParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  pairs?: ResupplyPairConfig[];
  underlyings?: ResupplyUnderlyingDescriptor[];
}

interface ResupplyPairConfig {
  key: string;
  address: string;
}

interface ResupplyPairSnapshot {
  pairKey: string;
  pairAddress: `0x${string}`;
  underlyingAddress: `0x${string}`;
  collateralAddress: `0x${string}`;
  totalBorrowAmount: bigint;
  totalBorrowShares: bigint;
  totalCollateralShares: bigint;
  totalCollateralAssets: bigint;
}

const UNDERLYING_SELECTOR = "0x6f307dc3";
const COLLATERAL_SELECTOR = "0xd8dfeb45";
const GET_PAIR_ACCOUNTING_SELECTOR = "0xcdd72d52";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const UNDERLYING_DECIMALS = 18;

function normalizeAddress(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function parseAddressResult(raw: string | null, context: string): `0x${string}` {
  const address = parseEvmAddressResult(raw as `0x${string}`);
  if (!address || /^0x0{40}$/.test(address)) {
    throw new Error(`resupply-pairs ${context} returned an invalid address`);
  }
  return address as `0x${string}`;
}

function parseConfiguredAddress(value: string, context: string): `0x${string}` {
  const address = normalizeAddress(value);
  if (!address) {
    throw new Error(`resupply-pairs ${context} is not a valid address`);
  }
  return address as `0x${string}`;
}

function buildUnderlyingMap(
  underlyings: readonly ResupplyUnderlyingDescriptor[] | undefined,
): Map<string, ResupplyUnderlyingDescriptor> {
  const byAddress = new Map<string, ResupplyUnderlyingDescriptor>();
  for (const underlying of underlyings ?? []) {
    const address = normalizeAddress(underlying.address);
    if (address) byAddress.set(address, underlying);
  }
  return byAddress;
}

function decodePairAccounting(raw: string | null, pairAddress: string): {
  totalBorrowAmount: bigint;
  totalBorrowShares: bigint;
  totalCollateral: bigint;
} {
  if (typeof raw !== "string") {
    throw new Error(`resupply-pairs getPairAccounting() call failed for ${pairAddress}`);
  }
  const [_claimableFees, totalBorrowAmount, totalBorrowShares, totalCollateral] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }],
    raw as `0x${string}`,
  ) as readonly [bigint, bigint, bigint, bigint];
  return { totalBorrowAmount, totalBorrowShares, totalCollateral };
}

function decodeUint256Result(raw: string | null, context: string): bigint {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`resupply-pairs ${context} call failed`);
  }
  return BigInt(raw);
}

function encodeConvertToAssetsCall(shares: bigint): `0x${string}` {
  return `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256Arg(shares)}` as `0x${string}`;
}

export function adaptResupplyPairSnapshots(
  snapshots: readonly ResupplyPairSnapshot[],
  underlyings: readonly ResupplyUnderlyingDescriptor[] | undefined,
): AdapterResult {
  const underlyingByAddress = buildUnderlyingMap(underlyings);
  const valueByUnderlying = new Map<string, {
    value: number;
    descriptor: ResupplyUnderlyingDescriptor;
    pairCount: number;
  }>();
  const components: Array<Record<string, unknown>> = [];
  let totalBorrowUsd = 0;
  let totalCollateralAssetsUsd = 0;

  for (const snapshot of snapshots) {
    totalBorrowUsd += decimalNumberFromBigInt(snapshot.totalBorrowAmount, UNDERLYING_DECIMALS);
    if (snapshot.totalCollateralAssets === 0n) {
      if (snapshot.totalBorrowAmount > 0n) {
        throw new Error(`resupply-pairs ${snapshot.pairAddress} has positive borrow and zero converted collateral assets`);
      }
      continue;
    }

    const underlyingAddress = normalizeAddress(snapshot.underlyingAddress);
    const descriptor = underlyingAddress ? underlyingByAddress.get(underlyingAddress) : undefined;
    if (!underlyingAddress || !descriptor) {
      throw new Error(`resupply-pairs unmapped positive-collateral underlying ${snapshot.underlyingAddress}`);
    }

    const value = decimalNumberFromBigInt(snapshot.totalCollateralAssets, UNDERLYING_DECIMALS);
    totalCollateralAssetsUsd += value;
    const current = valueByUnderlying.get(underlyingAddress);
    valueByUnderlying.set(underlyingAddress, {
      descriptor,
      value: (current?.value ?? 0) + value,
      pairCount: (current?.pairCount ?? 0) + 1,
    });
    components.push({
      pairKey: snapshot.pairKey,
      pairAddress: snapshot.pairAddress,
      underlyingAddress: snapshot.underlyingAddress,
      collateralAddress: snapshot.collateralAddress,
      totalBorrowAmount: snapshot.totalBorrowAmount.toString(),
      totalBorrowShares: snapshot.totalBorrowShares.toString(),
      totalCollateralShares: snapshot.totalCollateralShares.toString(),
      totalCollateralAssets: snapshot.totalCollateralAssets.toString(),
    });
  }

  if (totalCollateralAssetsUsd <= 0 || valueByUnderlying.size === 0) {
    throw new Error("resupply-pairs found no positive converted collateral assets");
  }

  return {
    slices: slicesFromValues(
      [...valueByUnderlying.values()].map(({ descriptor, value }) => ({
        value,
        name: descriptor.name,
        risk: descriptor.risk,
        ...(descriptor.coinId ? { coinId: descriptor.coinId } : {}),
        ...(descriptor.depType ? { depType: descriptor.depType } : {}),
      })),
    ),
    metadata: {
      totalBorrowUsd,
      totalCollateralAssetsUsd,
      pairCount: snapshots.length,
      activePairCount: components.length,
      ...notApplicableFreshnessMetadata({
        proofKind: "resupply-pair-accounting",
        components,
      }),
    },
  };
}

export async function fetchResupplyPairsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "resupply-pairs");
  const params = parseLiveReserveAdapterParams("resupply-pairs", config.params) as ResupplyPairsParams;
  if (!params.pairs || params.pairs.length === 0) {
    throw new Error("resupply-pairs requires at least one configured pair");
  }
  const callBase = {
    chain: input.chain,
    rpcMode: input.rpcMode,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    signal,
    ctx,
    timeoutMs: 12_000,
  };

  const snapshots: ResupplyPairSnapshot[] = [];
  for (const pair of params.pairs) {
    const pairAddress = parseConfiguredAddress(pair.address, `configured pair ${pair.key}`);
    const [rawUnderlying, rawAccounting] = await Promise.all([
      fetchOnchainRawCall({ ...callBase, contract: pairAddress, data: UNDERLYING_SELECTOR }),
      fetchOnchainRawCall({ ...callBase, contract: pairAddress, data: GET_PAIR_ACCOUNTING_SELECTOR }),
    ]);
    const underlyingAddress = parseAddressResult(rawUnderlying, `underlying() for ${pairAddress}`);
    const accounting = decodePairAccounting(rawAccounting, pairAddress);
    const rawCollateral = await fetchOnchainRawCall({ ...callBase, contract: pairAddress, data: COLLATERAL_SELECTOR });
    const collateralAddress = parseAddressResult(rawCollateral, `collateral() for ${pairAddress}`);
    const rawCollateralAssets = await fetchOnchainRawCall({
      ...callBase,
      contract: collateralAddress,
      data: encodeConvertToAssetsCall(accounting.totalCollateral),
    });
    const totalCollateralAssets = decodeUint256Result(rawCollateralAssets, `convertToAssets() for ${collateralAddress}`);
    snapshots.push({
      pairKey: pair.key,
      pairAddress,
      underlyingAddress,
      collateralAddress,
      totalBorrowAmount: accounting.totalBorrowAmount,
      totalBorrowShares: accounting.totalBorrowShares,
      totalCollateralShares: accounting.totalCollateral,
      totalCollateralAssets,
    });
  }

  return adaptResupplyPairSnapshots(snapshots, params.underlyings);
}
