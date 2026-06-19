import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeUint256 } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  makeContractRawCaller,
} from "./erc4626";
import { decimalNumberFromBigInt, parseBoundedDecimals } from "./slice-math";

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
    const assetAddressMatchesExpected = assetAddress === expectedAssetAddress;
    const livenessWarnings: LiveReserveWarning[] = [];

    if (assetAddress == null) {
      livenessWarnings.push(
        reserveInfoWarning(
          "centrifuge-vault-asset-unavailable",
          `Centrifuge vault ${coin.id} asset() was unavailable while resolving fallback liveness`,
        ),
      );
    } else if (!assetAddressMatchesExpected) {
      livenessWarnings.push(
        reserveInfoWarning(
          "centrifuge-vault-asset-mismatch",
          `Centrifuge vault ${coin.id} asset() read ${assetAddress}, expected ${expectedAssetAddress}`,
        ),
      );
    }

    if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
      livenessWarnings.push(
        reserveInfoWarning(
          "centrifuge-vault-total-assets-unavailable",
          "Centrifuge vault totalAssets() and totalSupply() were both unavailable; scoring fallback uses configured slice coverage only.",
        ),
      );

      return {
        slices: [
          {
            name: params.slice.name,
            pct: 100,
            risk: params.slice.risk,
          },
        ],
        ...(livenessWarnings.length > 0 ? { warnings: livenessWarnings } : {}),
        metadata: {
          ...notApplicableFreshnessMetadata({
            proofKind: "centrifuge-vault-total-supply-liveness",
            totalAssetsUnavailable: true,
          }),
          chain: primaryInput.chain,
          contractAddress,
          ...(totalSupplyRaw != null ? { totalSupplyRaw: totalSupplyRaw.toString() } : {}),
          ...(assetAddress != null ? { assetAddress } : {}),
          ...(assetAddress != null ? { assetAddressMatchesExpected } : {}),
          redemption: {
            capacityKind: "documented-eventual" as const,
            freshnessKind: "same-run-onchain" as const,
            routeStatus: "unknown" as const,
          },
        },
      };
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
        ...livenessWarnings,
        reserveInfoWarning(
          "centrifuge-vault-total-assets-unavailable",
          "Centrifuge vault totalAssets() was unavailable; validated token liveness with ERC-20 totalSupply()",
        ),
      ].filter((warning): warning is LiveReserveWarning => warning != null),
      metadata: {
        ...notApplicableFreshnessMetadata({
          proofKind: "centrifuge-vault-total-supply-liveness",
          totalAssetsUnavailable: true,
        }),
        chain: primaryInput.chain,
        contractAddress,
        totalSupplyRaw: totalSupplyRaw.toString(),
        redemption: {
          capacityKind: "documented-eventual" as const,
          freshnessKind: "same-run-onchain" as const,
          routeStatus: "unknown" as const,
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
    throw new Error(`ERC-7540 asset() could not be read for ${coin.id}; expected ${expectedAssetAddress}`);
  }
  if (assetAddress !== expectedAssetAddress) {
    throw new Error(`ERC-7540 asset() returned ${assetAddress}, expected ${expectedAssetAddress} for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];

  // NAV cross-check: compare the asset/share price against 1:1 after decimal normalization.
  let collateralizationRatio: number | undefined;
  let convertToAssetsRaw: bigint | undefined;
  const shareDecimalsRaw = await call(DECIMALS_SELECTOR);
  const assetDecimalsRaw = await fetchOnchainUint256({
    contract: assetAddress,
    data: DECIMALS_SELECTOR,
    signal,
    ctx: _ctx,
    rpcMode: primaryInput.rpcMode,
    chain: primaryInput.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: timeout,
  });
  const shareDecimals = shareDecimalsRaw == null ? null : parseBoundedDecimals(BigInt(shareDecimalsRaw));
  const assetDecimals = parseBoundedDecimals(assetDecimalsRaw);

  if (totalSupplyRaw != null && totalSupplyRaw > 0n && shareDecimals != null && assetDecimals != null) {
    const shareUnit = 10n ** BigInt(shareDecimals);
    const convertResult = await call(`${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(shareUnit)}`);
    if (convertResult) {
      convertToAssetsRaw = BigInt(convertResult);
    }

    const assets = decimalNumberFromBigInt(totalAssetsRaw, assetDecimals);
    const shares = decimalNumberFromBigInt(totalSupplyRaw, shareDecimals);
    if (shares > 0) {
      collateralizationRatio = assets / shares;
      if (Number.isFinite(collateralizationRatio) && Math.abs(collateralizationRatio - 1) > 0.01) {
        warnings.push(
          reserveDegradedWarning(
            "centrifuge-vault-nav-divergence",
            `Centrifuge vault share price diverges from 1:1 by ${((collateralizationRatio - 1) * 100).toFixed(2)}%`,
          ),
        );
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
      ...(shareDecimals != null ? { shareDecimals } : {}),
      ...(assetDecimals != null ? { assetDecimals } : {}),
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio) ? { collateralizationRatio } : {}),
      redemption: {
        capacityKind: "documented-eventual" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: warnings.length > 0 ? ("degraded" as const) : ("unknown" as const),
        ...(warnings.length > 0 ? { routeStatusSource: "onchain" as const } : {}),
      },
    },
  };
}
