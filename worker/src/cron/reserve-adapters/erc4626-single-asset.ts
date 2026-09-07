import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
  encodeUint256,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictBoolWord } from "./abi-decode";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainMulticall3,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626CollateralizationRatio,
  computeErc4626CollateralizationRatioFromResult,
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
import { multicallResultByLabel } from "./onchain-identity";

const YEARN_V3_IS_SHUTDOWN_SELECTOR = "0xbf86d690";
const EXECUTABLE_REDEMPTION_COIN_IDS = new Set(["eearn-ember", "sdusd-dtrinity"]);

function successfulMulticallResult(
  results: EvmMulticall3Result[] | null,
  label: string,
): string | null {
  return results ? multicallResultByLabel(results, label) : null;
}

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
  const usesSfrxusdCrosschainRoute =
    sliceConfig.redemptionLiquidity?.source === "fraxtal-hop-withdrawable";
  const usesExecutableRedemptionRoute = EXECUTABLE_REDEMPTION_COIN_IDS.has(coin.id);
  const usesGenericBatch = !usesExecutableRedemptionRoute && !usesSfrxusdCrosschainRoute;
  const probesYearnShutdown =
    sliceConfig.redemptionLiquidity?.source === "yearn-v3-withdrawable";

  let pauseProbe: Erc4626CapacityPauseProbe = { paused: null, shutdown: null };
  let assetResult: string | null;
  let totalAssetsResult: string | null;
  let totalSupplyResult: string | null;

  if (usesGenericBatch) {
    const stateResults = await fetchOnchainMulticall3({
      calls: [
        { label: "asset", contract: contractAddress, data: ERC4626_ASSET_SELECTOR },
        { label: "total-assets", contract: contractAddress, data: ERC4626_TOTAL_ASSETS_SELECTOR },
        { label: "total-supply", contract: contractAddress, data: TOTAL_SUPPLY_SELECTOR },
        { label: "paused", contract: contractAddress, data: PAUSED_SELECTOR },
        ...(probesYearnShutdown
          ? [{ label: "yearn-shutdown", contract: contractAddress, data: YEARN_V3_IS_SHUTDOWN_SELECTOR }]
          : []),
      ],
      signal,
      ctx: _ctx,
      chain: primaryInput.chain,
      rpcUrl: sliceConfig.rpcUrl,
      fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
      timeoutMs: timeout,
    });
    assetResult = successfulMulticallResult(stateResults, "asset");
    totalAssetsResult = successfulMulticallResult(stateResults, "total-assets");
    totalSupplyResult = successfulMulticallResult(stateResults, "total-supply");
    pauseProbe = {
      paused: decodeStrictBoolWord(successfulMulticallResult(stateResults, "paused")),
      shutdown: probesYearnShutdown
        ? decodeStrictBoolWord(successfulMulticallResult(stateResults, "yearn-shutdown"))
        : null,
    };
  } else {
    [assetResult, totalAssetsResult] = await Promise.all([
      call(ERC4626_ASSET_SELECTOR),
      call(ERC4626_TOTAL_ASSETS_SELECTOR),
    ]);
    totalSupplyResult = await call(TOTAL_SUPPLY_SELECTOR);
  }

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
  let totalSupplyRaw: bigint | undefined;
  if (totalSupplyResult) {
    totalSupplyRaw = BigInt(totalSupplyResult);
  }
  let idleUnderlyingBalanceRaw: bigint | null = null;
  let underlyingDecimalsRaw: bigint | null = usesSfrxusdCrosschainRoute ? 18n : null;
  let navCheck: Awaited<ReturnType<typeof computeErc4626CollateralizationRatio>>;
  if (usesGenericBatch) {
    const dependentResults = await fetchOnchainMulticall3({
      calls: [
        ...(totalSupplyRaw != null && totalSupplyRaw > 0n
          ? [{
              label: "convert-to-assets",
              contract: contractAddress,
              data: `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(totalSupplyRaw)}`,
            }]
          : []),
        ...(assetAddress
          ? [
              {
                label: "idle-underlying-balance",
                contract: assetAddress,
                data: encodeBalanceOfCallData(contractAddress),
              },
              { label: "underlying-decimals", contract: assetAddress, data: DECIMALS_SELECTOR },
            ]
          : []),
      ],
      signal,
      ctx: _ctx,
      chain: primaryInput.chain,
      rpcUrl: sliceConfig.rpcUrl,
      fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
      timeoutMs: timeout,
    });
    navCheck = computeErc4626CollateralizationRatioFromResult({
      totalAssetsRaw,
      totalSupplyRaw,
      convertResult: successfulMulticallResult(dependentResults, "convert-to-assets"),
      warningCode: "erc4626-nav-divergence",
    });
    const idleBalanceResult = successfulMulticallResult(dependentResults, "idle-underlying-balance");
    const decimalsResult = successfulMulticallResult(dependentResults, "underlying-decimals");
    idleUnderlyingBalanceRaw = idleBalanceResult ? BigInt(idleBalanceResult) : null;
    underlyingDecimalsRaw = decimalsResult ? BigInt(decimalsResult) : null;
  } else {
    navCheck = await computeErc4626CollateralizationRatio({
      call,
      totalAssetsRaw,
      totalSupplyRaw,
      warningCode: "erc4626-nav-divergence",
    });
  }
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
      if (!usesGenericBatch && !usesSfrxusdCrosschainRoute) {
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

      // Route-openness evidence. The generic path already included these probes
      // in its state batch. Executable observers own their route state, while the
      // fraxtal hop manages its special cross-chain route independently.
      if (!usesGenericBatch && !usesSfrxusdCrosschainRoute) {
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
