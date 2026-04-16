import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainRawCall,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

function encodeUint256Arg(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
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
  const [assetResult, totalAssetsResult] = await Promise.all([
    fetchOnchainRawCall({
      contract: contractAddress,
      data: ERC4626_ASSET_SELECTOR,
      signal,
      ctx: _ctx,
      rpcMode: primaryInput.rpcMode,
      chain: primaryInput.chain,
      rpcUrl: sliceConfig.rpcUrl,
      fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
      timeoutMs: timeout,
    }),
    fetchOnchainRawCall({
      contract: contractAddress,
      data: ERC4626_TOTAL_ASSETS_SELECTOR,
      signal,
      ctx: _ctx,
      rpcMode: primaryInput.rpcMode,
      chain: primaryInput.chain,
      rpcUrl: sliceConfig.rpcUrl,
      fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
      timeoutMs: timeout,
    }),
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
  const totalSupplyResult = await fetchOnchainRawCall({
    contract: contractAddress,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx: _ctx,
    rpcMode: primaryInput.rpcMode,
    chain: primaryInput.chain,
    rpcUrl: sliceConfig.rpcUrl,
    fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
    timeoutMs: timeout,
  });

  let collateralizationRatio: number | undefined;
  let convertToAssetsRaw: bigint | undefined;
  let totalSupplyRaw: bigint | undefined;
  if (totalSupplyResult) {
    totalSupplyRaw = BigInt(totalSupplyResult);
    if (totalSupplyRaw > 0n) {
      const convertResult = await fetchOnchainRawCall({
        contract: contractAddress,
        data: `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256Arg(totalSupplyRaw)}`,
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      });
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
      ...(totalSupplyRaw != null ? { totalSupplyRaw: totalSupplyRaw.toString() } : {}),
      ...(convertToAssetsRaw != null ? { convertToAssetsRaw: convertToAssetsRaw.toString() } : {}),
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      redemption: {
        capacityKind: "documented-eventual" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: warnings.length > 0 ? "degraded" as const : "unknown" as const,
      },
    },
  };
}
