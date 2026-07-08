import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import { throwIfAborted } from "../../lib/abort";
import { mapWithConcurrency } from "../../lib/concurrency";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeUint256 } from "../../lib/evm-selectors";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";
import { decodeAddressWord, decodeUint256Word } from "./abi-decode";
import { normalizeEvmAddress } from "./evm";

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
  redemptionHandlerAddress?: string;
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
  maxRedeemableDebt?: bigint;
}

const UNDERLYING_SELECTOR = "0x6f307dc3";
const COLLATERAL_SELECTOR = "0xd8dfeb45";
const GET_PAIR_ACCOUNTING_SELECTOR = "0xcdd72d52";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const GET_MAX_REDEEMABLE_DEBT_SELECTOR = "0x43bad45b";
const GUARD_ENABLED_SELECTOR = "0x901654fc";
const PERMISSIONLESS_PRICE_THRESHOLD_SELECTOR = "0x0e3d9f3c";
const REUSD_ORACLE_PRICE_SELECTOR = "0xc6af1dda";
const UNDERLYING_DECIMALS = 18;
const PAIR_FETCH_CONCURRENCY = 2;

interface RedemptionGuardSnapshot {
  guardEnabled: boolean;
  permissionlessPriceThreshold: bigint;
  reUsdOraclePrice: bigint;
}

interface RedemptionTelemetryInput {
  redemptionHandlerAddress: `0x${string}`;
  guard: RedemptionGuardSnapshot;
}

function parseAddressResult(raw: string | null, context: string): `0x${string}` {
  const address = decodeAddressWord(raw);
  if (!address) {
    throw new Error(`resupply-pairs ${context} returned an invalid address`);
  }
  return address.toLowerCase() as `0x${string}`;
}

function parseConfiguredAddress(value: string, context: string): `0x${string}` {
  const address = normalizeEvmAddress(value);
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
    const address = normalizeEvmAddress(underlying.address);
    if (address) byAddress.set(address, underlying);
  }
  return byAddress;
}

function decodePairAccounting(
  raw: string | null,
  pairAddress: string,
): {
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
  const decoded = decodeUint256Word(raw);
  if (decoded == null) {
    throw new Error(`resupply-pairs ${context} call failed`);
  }
  return decoded;
}

function encodeConvertToAssetsCall(shares: bigint): `0x${string}` {
  return `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(shares)}` as `0x${string}`;
}

function encodeAddressArgument(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeGetMaxRedeemableDebtCall(pairAddress: `0x${string}`): `0x${string}` {
  return `${GET_MAX_REDEEMABLE_DEBT_SELECTOR}${encodeAddressArgument(pairAddress)}` as `0x${string}`;
}

function decodeBooleanResult(raw: string | null, context: string): boolean {
  const decoded = decodeUint256Word(raw);
  if (decoded == null || (decoded !== 0n && decoded !== 1n)) {
    throw new Error(`resupply-pairs ${context} call failed`);
  }
  return decoded === 1n;
}

function buildRedemptionTelemetry(
  snapshots: readonly ResupplyPairSnapshot[],
  input: RedemptionTelemetryInput | undefined,
): Pick<NonNullable<AdapterResult["metadata"]>, "redemption" | "immediateRedeemableUsd"> {
  if (!input) return {};
  let capacityUsd = 0;
  for (const snapshot of snapshots) {
    if (snapshot.maxRedeemableDebt == null) {
      throw new Error(`resupply-pairs missing redemption capacity for ${snapshot.pairAddress}`);
    }
    capacityUsd += decimalNumberFromBigInt(snapshot.maxRedeemableDebt, UNDERLYING_DECIMALS);
  }

  const permissionlessOpen =
    !input.guard.guardEnabled || input.guard.reUsdOraclePrice < input.guard.permissionlessPriceThreshold;
  const routeStatusReason = permissionlessOpen
    ? "Resupply redemption guard permits same-transaction holder redemptions"
    : "Resupply redemption guard currently limits redemptions to the protocol redemption operator until the reUSD oracle price is below the permissionless threshold";

  return {
    immediateRedeemableUsd: capacityUsd,
    ...buildRedemptionSnapshotMetadata({
      capacityUsd,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: permissionlessOpen ? "open" : "cohort-limited",
      routeStatusSource: "onchain",
      routeStatusReason,
      holderEligibility: permissionlessOpen ? "any-holder" : "whitelisted-primary",
      settlementDelaySec: 0,
      sourceUrls: [
        "https://docs.resupply.fi/resupply-protocol/stability-mechanics",
        "https://github.com/resupplyfi/resupply/blob/main/src/protocol/RedemptionHandler.sol",
      ],
      redemptionHandlerAddress: input.redemptionHandlerAddress,
      guardEnabled: input.guard.guardEnabled,
      reUsdOraclePrice: decimalNumberFromBigInt(input.guard.reUsdOraclePrice, UNDERLYING_DECIMALS),
      permissionlessPriceThreshold: decimalNumberFromBigInt(
        input.guard.permissionlessPriceThreshold,
        UNDERLYING_DECIMALS,
      ),
    }),
  };
}

export function adaptResupplyPairSnapshots(
  snapshots: readonly ResupplyPairSnapshot[],
  underlyings: readonly ResupplyUnderlyingDescriptor[] | undefined,
  redemptionTelemetry?: RedemptionTelemetryInput,
): AdapterResult {
  const underlyingByAddress = buildUnderlyingMap(underlyings);
  const valueByUnderlying = new Map<
    string,
    {
      value: number;
      descriptor: ResupplyUnderlyingDescriptor;
      pairCount: number;
    }
  >();
  const components: Array<Record<string, unknown>> = [];
  let totalBorrowUsd = 0;
  let totalCollateralAssetsUsd = 0;

  for (const snapshot of snapshots) {
    totalBorrowUsd += decimalNumberFromBigInt(snapshot.totalBorrowAmount, UNDERLYING_DECIMALS);
    if (snapshot.totalCollateralAssets === 0n) {
      if (snapshot.totalBorrowAmount > 0n) {
        throw new Error(
          `resupply-pairs ${snapshot.pairAddress} has positive borrow and zero converted collateral assets`,
        );
      }
      continue;
    }

    const underlyingAddress = normalizeEvmAddress(snapshot.underlyingAddress);
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
      ...(snapshot.maxRedeemableDebt != null ? { maxRedeemableDebt: snapshot.maxRedeemableDebt.toString() } : {}),
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
      ...buildRedemptionTelemetry(snapshots, redemptionTelemetry),
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
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: 12_000,
  });

  let redemptionHandlerAddress: `0x${string}` | undefined;
  let guard: RedemptionGuardSnapshot | undefined;
  if (params.redemptionHandlerAddress) {
    redemptionHandlerAddress = parseConfiguredAddress(params.redemptionHandlerAddress, "redemption handler");
    const [rawGuardEnabled, rawThreshold, rawOraclePrice] = await Promise.all([
      onchain.raw(redemptionHandlerAddress, GUARD_ENABLED_SELECTOR),
      onchain.raw(redemptionHandlerAddress, PERMISSIONLESS_PRICE_THRESHOLD_SELECTOR),
      onchain.raw(redemptionHandlerAddress, REUSD_ORACLE_PRICE_SELECTOR),
    ]);
    guard = {
      guardEnabled: decodeBooleanResult(rawGuardEnabled, `guardEnabled() for ${redemptionHandlerAddress}`),
      permissionlessPriceThreshold: decodeUint256Result(
        rawThreshold,
        `permissionlessPriceThreshold() for ${redemptionHandlerAddress}`,
      ),
      reUsdOraclePrice: decodeUint256Result(rawOraclePrice, `reUsdOraclePrice() for ${redemptionHandlerAddress}`),
    };
  }

  const snapshots = await mapWithConcurrency(params.pairs, PAIR_FETCH_CONCURRENCY, async (pair) => {
    throwIfAborted(signal);
    const pairAddress = parseConfiguredAddress(pair.address, `configured pair ${pair.key}`);
    const [rawUnderlying, rawAccounting, rawMaxRedeemableDebt] = await Promise.all([
      onchain.raw(pairAddress, UNDERLYING_SELECTOR),
      onchain.raw(pairAddress, GET_PAIR_ACCOUNTING_SELECTOR),
      redemptionHandlerAddress
        ? onchain.raw(redemptionHandlerAddress, encodeGetMaxRedeemableDebtCall(pairAddress))
        : Promise.resolve(null),
    ]);
    const underlyingAddress = parseAddressResult(rawUnderlying, `underlying() for ${pairAddress}`);
    const accounting = decodePairAccounting(rawAccounting, pairAddress);
    const rawCollateral = await onchain.raw(pairAddress, COLLATERAL_SELECTOR);
    const collateralAddress = parseAddressResult(rawCollateral, `collateral() for ${pairAddress}`);
    const rawCollateralAssets = await onchain.raw(
      collateralAddress,
      encodeConvertToAssetsCall(accounting.totalCollateral),
    );
    const totalCollateralAssets = decodeUint256Result(
      rawCollateralAssets,
      `convertToAssets() for ${collateralAddress}`,
    );
    return {
      pairKey: pair.key,
      pairAddress,
      underlyingAddress,
      collateralAddress,
      totalBorrowAmount: accounting.totalBorrowAmount,
      totalBorrowShares: accounting.totalBorrowShares,
      totalCollateralShares: accounting.totalCollateral,
      totalCollateralAssets,
      ...(redemptionHandlerAddress
        ? {
            maxRedeemableDebt: decodeUint256Result(rawMaxRedeemableDebt, `getMaxRedeemableDebt() for ${pairAddress}`),
          }
        : {}),
    };
  });

  return adaptResupplyPairSnapshots(
    snapshots,
    params.underlyings,
    redemptionHandlerAddress && guard ? { redemptionHandlerAddress, guard } : undefined,
  );
}
