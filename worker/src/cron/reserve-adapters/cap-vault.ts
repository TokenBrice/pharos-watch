import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { formatAddress } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveRedemptionOutputValuation,
  LiveReservesConfig,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import { parseChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  DECIMALS_SELECTOR,
  LATEST_ROUND_DATA_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
} from "../../lib/evm-selectors";
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
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
import { validateDecimals } from "./slice-math";
import { decodeAddressArrayWord, decodeBoolWord } from "./abi-decode";

const ADAPTER_KEY = "cap-vault";
const ASSETS_SELECTOR = "0x71a97305";
const TOTAL_SUPPLIES_SELECTOR = "0x9782e821";
const TOTAL_BORROWS_SELECTOR = "0x8d730124";
const AVAILABLE_BALANCE_SELECTOR = "0xa0821be3";
const PAUSED_SELECTOR = "0x2e48152c";
// Inherited from Cap's Minter; returns a ray (1e27 = 100%) flat redeem fee.
const GET_REDEEM_FEE_SELECTOR = "0xc6d98f1a";
const REDEEM_FEE_RAY_SCALE = 10n ** 27n;
const WTGXX_ASSET_ID = "wtgxx-wisdomtree";

function redeemFeeBpsFromRay(raw: bigint): number {
  return Number((raw * 10_000n + REDEEM_FEE_RAY_SCALE / 2n) / REDEEM_FEE_RAY_SCALE);
}

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
  /** Source-bound current unit value used for the proportional output basket. */
  priceSourceId?: string;
  priceObservedAt?: number;
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

function isTrackedFixedPegStablecoin(asset: CapVaultAssetState): boolean {
  if (asset.coinId?.match(/^(usdc|usdt|pyusd|rlusd|usdp|gusd|usds|dai)-/)) return true;
  return /^(usdc|usdt|pyusd|rlusd|usdp|gusd|usds|dai)$/i.test(asset.name);
}

function buildOutputValuation(args: {
  assets: readonly CapVaultAssetState[];
  totalReserveUsd: number;
  supplyUsd: number | null;
}): LiveReserveRedemptionOutputValuation | null {
  if (
    args.assets.length < 2 ||
    args.supplyUsd == null ||
    !Number.isFinite(args.supplyUsd) ||
    args.supplyUsd <= 0 ||
    !Number.isFinite(args.totalReserveUsd) ||
    args.totalReserveUsd <= 0
  ) {
    return null;
  }
  if (
    args.assets.some(
      (asset) =>
        !asset.coinId ||
        (!isTrackedFixedPegStablecoin(asset) &&
          (!asset.priceSourceId || asset.priceObservedAt == null)),
    )
  ) {
    return null;
  }
  const sourceBoundAssets = args.assets.filter(
    (asset) => asset.priceSourceId && asset.priceObservedAt != null,
  );
  if (sourceBoundAssets.length === 0) return null;
  const unitValueUsd = args.totalReserveUsd / args.supplyUsd;
  if (!Number.isFinite(unitValueUsd) || unitValueUsd <= 0) return null;
  return {
    sourceId: `cap-vault:${[...new Set(sourceBoundAssets.map((asset) => asset.priceSourceId!))].sort().join("+")}`,
    observedAt: Math.min(...sourceBoundAssets.map((asset) => asset.priceObservedAt!)),
    unitValueUsd,
    basketWeights: args.assets.map((asset) => ({
      assetId: asset.coinId!,
      weight: (asset.totalSupplied * priceForCapAsset(asset)) / args.totalReserveUsd,
    })),
  };
}

async function resolveSourceBoundOutputPrice(
  asset: CapVaultAssetState,
  onchain: ReturnType<typeof makeOnchainCallers>,
  now: number,
): Promise<CapVaultAssetState> {
  if (asset.coinId !== WTGXX_ASSET_ID) return asset;
  const navConfig = TRACKED_META_BY_ID.get(WTGXX_ASSET_ID)?.liveReservesConfig;
  if (navConfig?.adapter !== "chainlink-nav") {
    throw new Error("cap-vault: WTGXX output valuation requires the tracked Chainlink NAV config");
  }
  const params = parseLiveReserveAdapterParams("chainlink-nav", navConfig.params);
  const [rawDecimals, rawRoundData] = await Promise.all([
    onchain.uint256(params.oracleAddress, DECIMALS_SELECTOR),
    onchain.raw(params.oracleAddress, LATEST_ROUND_DATA_SELECTOR),
  ]);
  if (rawDecimals == null || rawRoundData == null) {
    throw new Error("cap-vault: WTGXX Chainlink NAV read failed");
  }
  const decimals = validateDecimals(rawDecimals, "cap-vault: WTGXX Chainlink NAV decimals");
  const round = parseChainlinkLatestRoundData(rawRoundData, "cap-vault: WTGXX Chainlink NAV");
  if (round.updatedAt > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(`cap-vault: WTGXX Chainlink NAV timestamp is in the future (${round.updatedAt - now}s)`);
  }
  const maxAgeSec = params.maxOracleAgeSec ?? 345_600;
  if (now - round.updatedAt > maxAgeSec) {
    throw new Error(`cap-vault: WTGXX Chainlink NAV is stale (${now - round.updatedAt}s > ${maxAgeSec}s)`);
  }
  const priceUsd = decimalNumberFromBigInt(round.answer, decimals);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("cap-vault: WTGXX Chainlink NAV is not a positive finite value");
  }
  return {
    ...asset,
    priceUsd,
    priceSourceId: `chainlink-nav:${params.oracleAddress.toLowerCase()}`,
    priceObservedAt: round.updatedAt,
  };
}

export function adaptCapVaultState(args: {
  assets: CapVaultAssetState[];
  supplyUsd: number | null;
  contractAddress: string;
  redemptionFeeBps?: number | null;
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
  const outputValuation = buildOutputValuation({
    assets: activeAssets,
    totalReserveUsd,
    supplyUsd: args.supplyUsd,
  });
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
        feeBps: args.redemptionFeeBps,
        ...(outputValuation ? { outputValuation } : {}),
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

  const [tokenSupplyRaw, redeemFeeRaw] = await Promise.all([
    onchain.uint256(contractAddress, TOTAL_SUPPLY_SELECTOR),
    onchain.uint256(contractAddress, GET_REDEEM_FEE_SELECTOR),
  ]);
  const supplyUsd = tokenSupplyRaw != null ? decimalNumberFromBigInt(tokenSupplyRaw, 18) : null;
  const redemptionFeeBps = redeemFeeRaw != null ? redeemFeeBpsFromRay(redeemFeeRaw) : null;

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

  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const sourceBoundAssetStates = await Promise.all(
    assetStates.map((asset) => resolveSourceBoundOutputPrice(asset, onchain, now)),
  );

  return adaptCapVaultState({
    assets: sourceBoundAssetStates,
    supplyUsd,
    contractAddress,
    redemptionFeeBps,
  });
}
