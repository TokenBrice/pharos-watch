import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictBoolWord } from "./abi-decode";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626CollateralizationRatio,
  makeContractRawCaller,
} from "./erc4626";
import {
  buildExecutableRedemptionCapacityTelemetry,
  finalizeErc4626RedemptionCapacity,
  observeConfiguredErc4626Capacity,
  projectErc4626RedemptionMetadata,
  type Erc4626CapacityObservation,
  type Erc4626CapacityPauseProbe,
  type Erc4626RedemptionLiquidityConfig,
  type RedemptionCapacityTelemetry,
} from "./erc4626-redemption-capacity";
import {
  observeExecutableRedemptionRoute,
} from "./executable-redemption-observers";

const YEARN_V3_IS_SHUTDOWN_SELECTOR = "0xbf86d690";

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  redemptionLiquidity?: Erc4626RedemptionLiquidityConfig;
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
    ...(params.redemptionLiquidity ? { redemptionLiquidity: params.redemptionLiquidity } : {}),
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
  const call = makeContractRawCaller({
    contractAddress,
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

  let totalSupplyRaw: bigint | undefined;
  if (totalSupplyResult) {
    totalSupplyRaw = BigInt(totalSupplyResult);
  }
  const navCheck = await computeErc4626CollateralizationRatio({
    call,
    totalAssetsRaw,
    totalSupplyRaw,
    warningCode: "erc4626-nav-divergence",
  });
  const { collateralizationRatio, convertToAssetsRaw } = navCheck;
  warnings.push(...navCheck.warnings);

  let redemptionCapacity: RedemptionCapacityTelemetry | null = null;
  let configuredCapacity: Erc4626CapacityObservation | null = null;
  if (assetAddress) {
    const supplyAssetsRaw = convertToAssetsRaw ?? totalAssetsRaw;
    const executableObservation = await observeExecutableRedemptionRoute(
      coin.id,
      contractAddress,
      signal,
      _ctx,
      {
        extraRpcUrls: [sliceConfig.rpcUrl, sliceConfig.fallbackRpcUrl].filter(
          (url): url is string => Boolean(url),
        ),
      },
    );
    if (executableObservation) {
      redemptionCapacity = buildExecutableRedemptionCapacityTelemetry(
        executableObservation,
        convertToAssetsRaw ?? totalAssetsRaw,
      );
      if (!redemptionCapacity) {
        throw new Error(
          `${coin.id} executable redemption observer returned invalid capacity telemetry`,
        );
      }
    } else {
      const usesSfrxusdCrosschainRoute =
        sliceConfig.redemptionLiquidity?.source === "fraxtal-hop-withdrawable";
      let idleUnderlyingBalanceRaw: bigint | null = null;
      let underlyingDecimalsRaw: bigint | null = usesSfrxusdCrosschainRoute ? 18n : null;
      if (!usesSfrxusdCrosschainRoute) {
        const onchain = makeOnchainCallers(primaryInput, {
          signal,
          ctx: _ctx,
          rpcUrl: sliceConfig.rpcUrl,
          fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
          timeoutMs: timeout,
        });
        [idleUnderlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
          onchain.uint256(assetAddress, encodeBalanceOfCallData(contractAddress)),
          onchain.uint256(assetAddress, DECIMALS_SELECTOR),
        ]);
      }
      configuredCapacity = await observeConfiguredErc4626Capacity({
        coinId: coin.id,
        contractAddress,
        assetAddress,
        configured: sliceConfig.redemptionLiquidity,
        idleCapacityRaw: idleUnderlyingBalanceRaw,
        underlyingDecimalsRaw,
        supplyAssetsRaw,
        call,
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      });
      warnings.push(...(configuredCapacity?.warnings ?? []));

      // Route-openness evidence. The fraxtal hop manages its own route state, so
      // it is left untouched; every other path probes the vault's pause surfaces
      // once, after the capacity reads, so no extra round trip is serialized.
      let pauseProbe: Erc4626CapacityPauseProbe = { paused: null, shutdown: null };
      if (!usesSfrxusdCrosschainRoute) {
        const probesYearnShutdown =
          sliceConfig.redemptionLiquidity?.source === "yearn-v3-withdrawable";
        const [pausedResult, shutdownResult] = await Promise.all([
          call(PAUSED_SELECTOR),
          probesYearnShutdown ? call(YEARN_V3_IS_SHUTDOWN_SELECTOR) : Promise.resolve(null),
        ]);
        pauseProbe = {
          paused: decodeStrictBoolWord(pausedResult),
          shutdown: probesYearnShutdown ? decodeStrictBoolWord(shutdownResult) : null,
        };
      }
      redemptionCapacity = finalizeErc4626RedemptionCapacity({
        supplyAssetsRaw,
        idleCapacityRaw: idleUnderlyingBalanceRaw,
        configured: configuredCapacity,
        pause: pauseProbe,
      });
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
      ...(redemptionCapacity
        ? projectErc4626RedemptionMetadata(redemptionCapacity)
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
              capacityKind: redemptionCapacity.capacityKind ?? "live-direct" as const,
              ...(redemptionCapacity.settlementBoundUnproven
                ? { settlementBoundUnproven: true }
                : {}),
              ...(redemptionCapacity.settlementDelaySec != null
                ? { settlementDelaySec: redemptionCapacity.settlementDelaySec }
                : {}),
              ...(redemptionCapacity.blockNumber != null
                ? { blockNumber: redemptionCapacity.blockNumber }
                : {}),
              ...(redemptionCapacity.sourceTimestamp != null
                ? { sourceTimestamp: redemptionCapacity.sourceTimestamp }
                : {}),
              ...(redemptionCapacity.sourceUrls
                ? { sourceUrls: redemptionCapacity.sourceUrls }
                : {}),
              ...(redemptionCapacity.holderEligibility
                ? { holderEligibility: redemptionCapacity.holderEligibility }
                : {}),
              ...(redemptionCapacity.feeBps != null
                ? { feeBps: redemptionCapacity.feeBps }
                : {}),
              ...(redemptionCapacity.routeStatusReason
                ? { routeStatusReason: redemptionCapacity.routeStatusReason }
                : {}),
              ...(redemptionCapacity.observerDiagnostics
                ? { observerDiagnostics: redemptionCapacity.observerDiagnostics }
                : {}),
            }
          : {
              capacityKind: "documented-eventual" as const,
            }),
        freshnessKind: redemptionCapacity?.freshnessKind ?? "same-run-onchain" as const,
        routeStatus:
          warnings.length > 0
            ? "degraded" as const
            : redemptionCapacity?.routeStatus ?? "unknown" as const,
        routeStatusSource: redemptionCapacity?.routeStatusSource ?? "onchain" as const,
        ...(configuredCapacity?.v9RouteAttempt
          ? { v9RouteAttempt: configuredCapacity.v9RouteAttempt }
          : {}),
      },
    },
  };
}
