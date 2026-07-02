import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { formatAddress } from "@shared/lib/format";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeAddress } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { resolveCoinContractAddress } from "./evm";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  reserveDegradedWarning,
  reserveInfoWarning,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";
import { validateDecimals } from "./slice-math";
import { decodeAddressArrayWord, decodeBoolWord } from "./abi-decode";

const ADAPTER_KEY = "cap-vault";
const ASSETS_SELECTOR = "0x71a97305";
const TOTAL_SUPPLIES_SELECTOR = "0x9782e821";
const TOTAL_BORROWS_SELECTOR = "0x8d730124";
const AVAILABLE_BALANCE_SELECTOR = "0xa0821be3";
const PAUSED_SELECTOR = "0x2e48152c";

interface CapVaultAssetConfig {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  priceUsd?: number;
}

interface CapVaultAssetState {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  configured?: boolean;
  decimals: number;
  totalSupplied: number;
  totalBorrowed: number;
  available: number;
  paused: boolean;
  /**
   * When omitted, only recognized USD-like reserves use the 1.0 peg
   * assumption. Configured non-USD-like assets must provide priceUsd.
   */
  priceUsd?: number;
  /**
   * True when the asset's paused() call returned a value that could not be decoded.
   * When true, `paused` is conservatively set to true.
   */
  pausedStatusUnavailable: boolean;
}

function normalizeAssetConfigs(config: LiveReservesConfig): Map<string, CapVaultAssetConfig> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  return new Map(
    (params.assets ?? []).map((asset) => [
      asset.address.toLowerCase(),
      {
        address: asset.address.toLowerCase(),
        name: asset.name,
        risk: asset.risk,
        ...(asset.coinId ? { coinId: asset.coinId } : {}),
        ...(asset.depType ? { depType: asset.depType } : {}),
        ...(asset.priceUsd != null ? { priceUsd: asset.priceUsd } : {}),
      },
    ]),
  );
}

function resolveAssetConfig(address: string, configs: Map<string, CapVaultAssetConfig>): CapVaultAssetConfig {
  const configured = configs.get(address.toLowerCase());
  return configured ?? {
    address: address.toLowerCase(),
    name: `Cap asset ${formatAddress(address)}`,
    risk: "high",
  };
}

function isRecognizedUsdLikeReserve(asset: CapVaultAssetState): boolean {
  if (asset.priceUsd != null) return true;
  if (asset.coinId?.match(/^(usdc|usdt|pyusd|rlusd|usdp|gusd|usds|dai)-/)) return true;
  return /^(usdc|usdt|pyusd|rlusd|usdp|gusd|usds|dai)$/i.test(asset.name);
}

function priceForCapAsset(asset: CapVaultAssetState): number {
  if (asset.priceUsd != null) return asset.priceUsd;
  return 1.0;
}

export function adaptCapVaultState(args: {
  assets: CapVaultAssetState[];
  supplyUsd: number | null;
  contractAddress: string;
}): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const activeAssets = args.assets.filter((asset) => asset.totalSupplied > 0);
  const unknownAssets = activeAssets.filter((asset) => asset.configured === false);
  for (const asset of unknownAssets) {
    warnings.push(reserveDegradedWarning(
      "unknown-vault-asset",
      `Cap vault returned unconfigured asset "${asset.name}" (${asset.address}); exposure is classified high risk`,
    ));
  }
  const unknownUnpricedAssets = unknownAssets.filter((asset) => (
    asset.priceUsd == null && !isRecognizedUsdLikeReserve(asset)
  ));
  for (const asset of unknownUnpricedAssets) {
    warnings.push(reserveInfoWarning(
      "cap-vault-unknown-asset-peg-assumed",
      `Cap vault unconfigured asset "${asset.name}" (${asset.address}) has no configured priceUsd and is not USD-like; valued at 1 USD per unit, which may misstate reserve totals`,
    ));
  }
  const unpricedNonUsdAssets = activeAssets.filter((asset) => (
    asset.configured !== false
    && asset.priceUsd == null
    && !isRecognizedUsdLikeReserve(asset)
  ));
  if (unpricedNonUsdAssets.length > 0) {
    throw new Error(
      `cap-vault configured non-USD-like asset(s) missing priceUsd: ${unpricedNonUsdAssets.map((a) => a.name).join(", ")}`,
    );
  }
  const pegAssumedAssets = activeAssets.filter((asset) => (
    asset.configured !== false
    && asset.priceUsd == null
    && isRecognizedUsdLikeReserve(asset)
  ));
  if (pegAssumedAssets.length > 0) {
    warnings.push(reserveInfoWarning(
      "cap-vault-peg-assumed",
      `Cap vault asset(s) without configured priceUsd treated as 1 USD per unit: ${pegAssumedAssets.map((a) => a.name).join(", ")}`,
    ));
  }
  const totalReserveUsd = activeAssets.reduce(
    (sum, asset) => sum + asset.totalSupplied * priceForCapAsset(asset),
    0,
  );
  const immediateRedeemableUsd = activeAssets.reduce(
    (sum, asset) => sum + (asset.paused ? 0 : Math.max(0, asset.available) * priceForCapAsset(asset)),
    0,
  );
  const pausedAssets = activeAssets.filter((asset) => asset.paused);
  for (const asset of pausedAssets) {
    warnings.push(reserveDegradedWarning(
      "cap-asset-paused",
      `Cap vault asset "${asset.name}" is paused and excluded from immediate redeemable capacity`,
    ));
  }
  const statusUnavailableAssets = activeAssets.filter((asset) => asset.pausedStatusUnavailable);
  for (const asset of statusUnavailableAssets) {
    warnings.push(reserveInfoWarning(
      "cap-vault-asset-status-unavailable",
      `Cap vault asset "${asset.name}" paused status could not be read; conservatively treated as paused`,
    ));
  }

  return {
    slices: slicesFromValues(activeAssets.map((asset) => ({
      name: asset.name,
      value: asset.totalSupplied * priceForCapAsset(asset),
      risk: asset.risk,
      ...(asset.coinId ? { coinId: asset.coinId } : {}),
      ...(asset.depType ? { depType: asset.depType } : {}),
    }))),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "cap-vault-onchain" }),
      contractAddress: args.contractAddress,
      assetCount: activeAssets.length,
      pausedAssetCount: pausedAssets.length,
      totalReserveUsd,
      ...(args.supplyUsd != null ? { supplyUsd: args.supplyUsd } : {}),
      immediateRedeemableUsd,
      ...(args.supplyUsd != null && args.supplyUsd > 0
        ? { immediateRedeemableRatio: immediateRedeemableUsd / args.supplyUsd }
        : {}),
      assets: activeAssets.map((asset) => ({
        address: asset.address,
        name: asset.name,
        totalSupplied: asset.totalSupplied,
        totalBorrowed: asset.totalBorrowed,
        available: asset.available,
        paused: asset.paused,
        ...(asset.priceUsd != null ? { priceUsd: asset.priceUsd } : {}),
        ...(asset.configured === false ? { configured: false } : {}),
      })),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: immediateRedeemableUsd,
        ...(args.supplyUsd != null && args.supplyUsd > 0
          ? { capacityRatioOfSupply: immediateRedeemableUsd / args.supplyUsd }
          : {}),
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: immediateRedeemableUsd > 0 && pausedAssets.length === 0
          ? "open"
          : immediateRedeemableUsd > 0
            ? "degraded"
            : "paused",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://docs.cap.app/concepts/vault"],
      }),
    },
  };
}

export async function fetchCapVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const contractAddress = resolveCoinContractAddress(coin, input.chain);
  if (!contractAddress) {
    throw new Error(`${ADAPTER_KEY} could not find a ${input.chain} contract for ${coin.id}`);
  }

  const assetConfigs = normalizeAssetConfigs(config);
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const assetsRaw = await onchain.raw(contractAddress, ASSETS_SELECTOR);
  const assetAddresses = decodeAddressArrayWord(assetsRaw) ?? [];
  if (assetAddresses.length === 0) {
    throw new Error(`${ADAPTER_KEY} assets() returned no assets for ${coin.id}`);
  }

  const tokenSupplyRaw = await onchain.uint256(contractAddress, TOTAL_SUPPLY_SELECTOR);
  const supplyUsd = tokenSupplyRaw != null ? decimalNumberFromBigInt(tokenSupplyRaw, 18) : null;

  const assetStates = await Promise.all(assetAddresses.map(async (address) => {
    const encodedAddress = encodeAddress(address);
    const assetMetadataReads = Promise.all([
      onchain.uint256(address, DECIMALS_SELECTOR),
    ]);
    const vaultPositionReads = Promise.all([
      onchain.uint256(contractAddress, `${TOTAL_SUPPLIES_SELECTOR}${encodedAddress}`),
      onchain.uint256(contractAddress, `${TOTAL_BORROWS_SELECTOR}${encodedAddress}`),
      onchain.uint256(contractAddress, `${AVAILABLE_BALANCE_SELECTOR}${encodedAddress}`),
      onchain.raw(contractAddress, `${PAUSED_SELECTOR}${encodedAddress}`),
    ]);
    const [[decimalsRaw], [totalSuppliesRaw, totalBorrowsRaw, availableRaw, pausedRaw]] = await Promise.all([
      assetMetadataReads,
      vaultPositionReads,
    ]);

    // Fail closed: required reads must not be null. A partial RPC failure
    // would otherwise silently drop an asset or mis-scale values.
    if (decimalsRaw == null) {
      throw new Error(`${ADAPTER_KEY}: failed to read decimals() for asset ${address}`);
    }
    if (totalSuppliesRaw == null) {
      throw new Error(`${ADAPTER_KEY}: failed to read totalSupplies() for asset ${address}`);
    }
    if (totalBorrowsRaw == null) {
      throw new Error(`${ADAPTER_KEY}: failed to read totalBorrows() for asset ${address}`);
    }
    if (availableRaw == null) {
      throw new Error(`${ADAPTER_KEY}: failed to read available() for asset ${address}`);
    }

    const decimals = validateDecimals(decimalsRaw, `${ADAPTER_KEY}: decimals() for asset ${address}`);
    // Conservative: treat a missing/undecodable paused() response as paused.
    const pausedDecoded = decodeBoolWord(pausedRaw);
    const pausedStatusUnavailable = pausedDecoded == null;
    const paused = pausedDecoded ?? true;

    const assetConfig = resolveAssetConfig(address, assetConfigs);
    return {
      address,
      name: assetConfig.name,
      risk: assetConfig.risk,
      ...(assetConfig.coinId ? { coinId: assetConfig.coinId } : {}),
      ...(assetConfig.depType ? { depType: assetConfig.depType } : {}),
      configured: assetConfigs.has(address.toLowerCase()),
      decimals,
      totalSupplied: decimalNumberFromBigInt(totalSuppliesRaw, decimals),
      totalBorrowed: decimalNumberFromBigInt(totalBorrowsRaw, decimals),
      available: decimalNumberFromBigInt(availableRaw, decimals),
      paused,
      pausedStatusUnavailable,
      ...(assetConfig.priceUsd != null ? { priceUsd: assetConfig.priceUsd } : {}),
    } satisfies CapVaultAssetState;
  }));

  return adaptCapVaultState({
    assets: assetStates,
    supplyUsd,
    contractAddress,
  });
}
