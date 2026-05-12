import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR, encodeUint256Arg } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainRawCall,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

// ERC-4626 selectors (also supported by ERC-7540, which is a superset).
const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

/**
 * Centrifuge V3 / ERC-7540 vault adapter.
 *
 * Unlike `erc4626-single-asset` (which describes a wrapper of a tracked coin
 * and emits the underlying tracked coin as the slice), this adapter describes
 * an RWA fund whose underlying portfolio (e.g. short-dated T-bills) is NOT a
 * tracked stablecoin. The on-chain `asset()` value (typically USDC) is only
 * the vault's accounting unit — used here as a sanity check — while the
 * reported slice is the configured real-world portfolio composition.
 */
export async function fetchCentrifugeVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, "centrifuge-vault");
  const params = parseLiveReserveAdapterParams("centrifuge-vault", config.params);
  const expectedAssetAddress = params.assetAddress.toLowerCase();

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
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs: timeout,
    });

  const [assetResult, totalAssetsResult] = await Promise.all([
    call(ERC4626_ASSET_SELECTOR),
    call(ERC4626_TOTAL_ASSETS_SELECTOR),
  ]);

  if (!totalAssetsResult) {
    throw new Error(`ERC-7540 totalAssets() call failed for ${coin.id}`);
  }
  const totalAssetsRaw = BigInt(totalAssetsResult);
  if (totalAssetsRaw <= 0n) {
    throw new Error(`ERC-7540 totalAssets() is zero for ${coin.id}`);
  }

  const assetAddress = assetResult ? parseEvmAddressResult(assetResult as `0x${string}`) : null;
  if (!assetAddress) {
    throw new Error(
      `ERC-7540 asset() could not be read for ${coin.id}; expected ${expectedAssetAddress}`,
    );
  }
  if (assetAddress !== expectedAssetAddress) {
    throw new Error(
      `ERC-7540 asset() returned ${assetAddress}, expected ${expectedAssetAddress} for ${coin.id}`,
    );
  }

  const warnings: LiveReserveWarning[] = [];

  // NAV cross-check: convertToAssets(totalSupply) vs totalAssets().
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
              "centrifuge-vault-nav-divergence",
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
        name: params.slice.name,
        pct: 100,
        risk: params.slice.risk,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "centrifuge-vault-total-assets",
        assetAddressMatchesExpected: true,
      }),
      chain: primaryInput.chain,
      contractAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      assetAddress,
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
