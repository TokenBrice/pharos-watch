import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
  encodeUint256Arg,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const MAX_ERC20_DECIMALS = 36;
const RATIO_SCALE = 1_000_000_000_000n;

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

interface RedemptionCapacityTelemetry {
  capacityUsd: number;
  idleUnderlyingBalanceRaw: string;
  underlyingDecimals: number;
  capacityRatioOfSupply?: number;
}

function parseSliceConfig(config: LiveReservesConfig): SingleAssetSliceConfig {
  const params = parseLiveReserveAdapterParams("erc4626-single-asset", config.params);
  return {
    name: params.slice.name,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    ...(params.slice.expectedAssetAddress
      ? { expectedAssetAddress: params.slice.expectedAssetAddress.toLowerCase() }
      : {}),
    ...(params.rpcUrl ? { rpcUrl: params.rpcUrl } : {}),
    ...(params.fallbackRpcUrl ? { fallbackRpcUrl: params.fallbackRpcUrl } : {}),
  };
}

function decodeErc20Decimals(raw: bigint | null): number | null {
  if (raw == null || raw > BigInt(MAX_ERC20_DECIMALS)) return null;
  return Number(raw);
}

function ratioFromRaw(numerator: bigint, denominator: bigint): number | undefined {
  if (denominator <= 0n) return undefined;
  if (numerator >= denominator) return 1;
  const ratio = Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
  return Number.isFinite(ratio) ? ratio : undefined;
}

function buildRedemptionCapacityTelemetry(
  idleUnderlyingBalanceRaw: bigint | null,
  underlyingDecimalsRaw: bigint | null,
  supplyAssetsRaw: bigint,
): RedemptionCapacityTelemetry | null {
  if (idleUnderlyingBalanceRaw == null) return null;
  const underlyingDecimals = decodeErc20Decimals(underlyingDecimalsRaw);
  if (underlyingDecimals == null) return null;

  const capacityUsd = decimalNumberFromBigInt(idleUnderlyingBalanceRaw, underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

  const capacityRatioOfSupply = ratioFromRaw(idleUnderlyingBalanceRaw, supplyAssetsRaw);
  return {
    capacityUsd,
    idleUnderlyingBalanceRaw: idleUnderlyingBalanceRaw.toString(),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
  };
}

export async function fetchErc4626SingleAssetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, "erc4626-single-asset");
  const sliceConfig = parseSliceConfig(config);
  const contractAddress = resolveCoinContractAddress(coin, primaryInput.chain);
  if (!contractAddress) {
    throw new Error(`No ${primaryInput.chain} contract configured for ${coin.id}`);
  }

  const timeout = 12_000;
  const call = (data: string) =>
    fetchOnchainRawCall({
      contract: contractAddress,
      data,
      signal,
      ctx: _ctx,
      rpcMode: primaryInput.rpcMode,
      chain: primaryInput.chain,
      rpcUrl: sliceConfig.rpcUrl,
      fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
      timeoutMs: timeout,
    });
  const [assetResult, totalAssetsResult] = await Promise.all([
    call(ERC4626_ASSET_SELECTOR),
    call(ERC4626_TOTAL_ASSETS_SELECTOR),
  ]);

  if (!totalAssetsResult) {
    throw new Error(`ERC-4626 totalAssets() call failed for ${coin.id}`);
  }
  const totalAssetsRaw = BigInt(totalAssetsResult);
  if (totalAssetsRaw <= 0n) {
    throw new Error(`ERC-4626 totalAssets() is zero for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];
  const assetAddress = assetResult ? parseEvmAddressResult(assetResult as `0x${string}`) : null;
  if (!assetAddress && sliceConfig.expectedAssetAddress) {
    throw new Error(
      `ERC-4626 asset() could not be read for ${coin.id}; expected ${sliceConfig.expectedAssetAddress}`,
    );
  }
  if (
    assetAddress
    && sliceConfig.expectedAssetAddress
    && assetAddress !== sliceConfig.expectedAssetAddress
  ) {
    throw new Error(
      `ERC-4626 asset() returned ${assetAddress}, expected ${sliceConfig.expectedAssetAddress} for ${coin.id}`,
    );
  }

  // NAV cross-check: totalSupply() shares valued through convertToAssets() vs totalAssets()
  const totalSupplyResult = await call(TOTAL_SUPPLY_SELECTOR);

  let collateralizationRatio: number | undefined;
  let convertToAssetsRaw: bigint | undefined;
  let totalSupplyRaw: bigint | undefined;
  if (totalSupplyResult) {
    totalSupplyRaw = BigInt(totalSupplyResult);
    if (totalSupplyRaw > 0n) {
      const convertResult = await call(
        `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256Arg(totalSupplyRaw)}`,
      );
      if (convertResult) {
        convertToAssetsRaw = BigInt(convertResult);
        if (totalAssetsRaw > 0n) {
          collateralizationRatio = Number(convertToAssetsRaw) / Number(totalAssetsRaw);
          if (
            Number.isFinite(collateralizationRatio)
            && Math.abs(collateralizationRatio - 1) > 0.01
          ) {
            warnings.push(reserveDegradedWarning(
              "erc4626-nav-divergence",
              `convertToAssets(totalSupply) diverges from totalAssets by ${((collateralizationRatio - 1) * 100).toFixed(2)}%`,
            ));
          }
        }
      }
    }
  }

  let redemptionCapacity: RedemptionCapacityTelemetry | null = null;
  if (assetAddress) {
    const [idleUnderlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
      fetchOnchainUint256({
        contract: assetAddress,
        data: encodeBalanceOfCallData(contractAddress),
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      }),
      fetchOnchainUint256({
        contract: assetAddress,
        data: DECIMALS_SELECTOR,
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      }),
    ]);
    redemptionCapacity = buildRedemptionCapacityTelemetry(
      idleUnderlyingBalanceRaw,
      underlyingDecimalsRaw,
      convertToAssetsRaw ?? totalAssetsRaw,
    );
  }

  return {
    slices: [
      {
        name: sliceConfig.name,
        pct: 100,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "erc4626-total-assets",
        ...(assetAddress
          ? { assetAddressMatchesExpected: sliceConfig.expectedAssetAddress == null || assetAddress === sliceConfig.expectedAssetAddress }
          : {}),
      }),
      chain: primaryInput.chain,
      contractAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      ...(assetAddress ? { assetAddress } : {}),
      ...(redemptionCapacity
        ? {
            idleUnderlyingBalanceRaw: redemptionCapacity.idleUnderlyingBalanceRaw,
            underlyingDecimals: redemptionCapacity.underlyingDecimals,
          }
        : {}),
      ...(totalSupplyRaw != null ? { totalSupplyRaw: totalSupplyRaw.toString() } : {}),
      ...(convertToAssetsRaw != null ? { convertToAssetsRaw: convertToAssetsRaw.toString() } : {}),
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      redemption: {
        ...(redemptionCapacity
          ? {
              capacityUsd: redemptionCapacity.capacityUsd,
              ...(redemptionCapacity.capacityRatioOfSupply != null
                ? { capacityRatioOfSupply: redemptionCapacity.capacityRatioOfSupply }
                : {}),
              capacityKind: "live-direct" as const,
            }
          : {
              capacityKind: "documented-eventual" as const,
            }),
        freshnessKind: "same-run-onchain" as const,
        routeStatus: warnings.length > 0 ? "degraded" as const : "unknown" as const,
        routeStatusSource: "onchain" as const,
      },
    },
  };
}
