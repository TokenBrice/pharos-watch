import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626CollateralizationRatio,
  makeContractRawCaller,
} from "./erc4626";

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
  const call = makeContractRawCaller({
    contractAddress,
    signal,
    ctx: _ctx,
    rpcMode: primaryInput.rpcMode,
    chain: primaryInput.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: timeout,
  });

  const [assetResult, totalAssetsResult, totalSupplyResult] = await Promise.all([
    call(ERC4626_ASSET_SELECTOR),
    call(ERC4626_TOTAL_ASSETS_SELECTOR),
    call(TOTAL_SUPPLY_SELECTOR),
  ]);

  const totalSupplyRaw = totalSupplyResult ? BigInt(totalSupplyResult) : undefined;

  if (!totalAssetsResult) {
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
    if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
      throw new Error(`ERC-7540 totalAssets() call failed for ${coin.id}`);
    }

    return {
      slices: [
        {
          name: params.slice.name,
          pct: 100,
          risk: params.slice.risk,
        },
      ],
      warnings: [
        reserveDegradedWarning(
          "centrifuge-vault-total-assets-unavailable",
          "Centrifuge vault totalAssets() was unavailable; validated accounting asset and token liveness with ERC-20 totalSupply()",
        ),
      ],
      metadata: {
        ...notApplicableFreshnessMetadata({
          proofKind: "centrifuge-vault-total-supply-liveness",
          totalAssetsUnavailable: true,
          assetAddressMatchesExpected: true,
        }),
        chain: primaryInput.chain,
        contractAddress,
        assetAddress,
        totalSupplyRaw: totalSupplyRaw.toString(),
        redemption: {
          capacityKind: "documented-eventual" as const,
          freshnessKind: "same-run-onchain" as const,
          routeStatus: "degraded" as const,
          routeStatusSource: "onchain" as const,
        },
      },
    };
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
  const navCheck = await computeErc4626CollateralizationRatio({
    call,
    totalAssetsRaw,
    totalSupplyRaw,
    warningCode: "centrifuge-vault-nav-divergence",
  });
  const { collateralizationRatio, convertToAssetsRaw } = navCheck;
  warnings.push(...navCheck.warnings);

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
        ...(warnings.length > 0 ? { routeStatusSource: "onchain" as const } : {}),
      },
    },
  };
}
