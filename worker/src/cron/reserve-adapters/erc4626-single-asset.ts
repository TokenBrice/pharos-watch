import { toFunctionSelector } from "viem/utils";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
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
import { decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import { hasDegradingWarnings } from "./validate";
import { reserveInfoWarning } from "./warnings";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626NavConsistencyFromResult,
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
  deployedExposure?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["deployedExposure"];
  redemptionLiquidity?: Erc4626RedemptionLiquidityConfig;
  redemptionLock?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["redemptionLock"];
  redemptionRoute?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["redemptionRoute"];
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
    ...(params.deployedExposure ? { deployedExposure: params.deployedExposure } : {}),
    ...(params.redemptionLiquidity ? { redemptionLiquidity: params.redemptionLiquidity } : {}),
    ...(params.redemptionLock ? { redemptionLock: params.redemptionLock } : {}),
    ...(params.redemptionRoute ? { redemptionRoute: params.redemptionRoute } : {}),
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
  const locks = sliceConfig.redemptionLock ?? [];
  let settlementDelaySec: number | undefined;
  let unstakeWindowSec: number | undefined;
  let lockPaused = false;

  if (usesGenericBatch || locks.length > 0) {
    const stateResults = await fetchOnchainMulticall3({
      calls: [
        { label: "asset", contract: contractAddress, data: ERC4626_ASSET_SELECTOR },
        { label: "total-assets", contract: contractAddress, data: ERC4626_TOTAL_ASSETS_SELECTOR },
        { label: "total-supply", contract: contractAddress, data: TOTAL_SUPPLY_SELECTOR },
        { label: "paused", contract: contractAddress, data: PAUSED_SELECTOR },
        ...locks.map((lock, index) => ({
          label: `redemption-lock-${index}`,
          contract: contractAddress,
          data: lock.selector.startsWith("0x") ? lock.selector : toFunctionSelector(lock.selector),
        })),
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
    for (const [index, lock] of locks.entries()) {
      const result = successfulMulticallResult(stateResults, `redemption-lock-${index}`);
      if (lock.kind === "paused-bool") {
        const paused = decodeStrictBoolWord(result);
        if (paused == null) throw new Error(`ERC-4626 redemption lock ${lock.selector} unreadable for ${coin.id}`);
        lockPaused ||= paused;
      } else {
        const seconds = decodeUint256Word(result);
        if (seconds == null || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`ERC-4626 redemption lock ${lock.selector} malformed or unreadable for ${coin.id}`);
        }
        if (lock.kind === "cooldown-seconds") {
          settlementDelaySec = Math.max(settlementDelaySec ?? 0, Number(seconds));
        } else {
          unstakeWindowSec = Math.max(unstakeWindowSec ?? 0, Number(seconds));
        }
      }
    }
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
  const navCheck = computeErc4626NavConsistencyFromResult({
    totalAssetsRaw,
    totalSupplyRaw,
    convertResult: successfulMulticallResult(dependentResults, "convert-to-assets"),
    warningCode: "erc4626-nav-divergence",
  });
  const idleBalanceResult = successfulMulticallResult(dependentResults, "idle-underlying-balance");
  const decimalsResult = successfulMulticallResult(dependentResults, "underlying-decimals");
  const idleUnderlyingBalanceRaw = idleBalanceResult ? decodeUint256Word(idleBalanceResult) : null;
  const underlyingDecimalsRaw = decimalsResult ? decodeUint256Word(decimalsResult) : null;
  const { navConsistencyRatio, convertToAssetsRaw } = navCheck;
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
  // A withdrawal window limits when a matured request can execute; it is not
  // additional waiting time. Keep its measured duration separate from cooldown.
  if (redemptionCapacity) {
    if (settlementDelaySec != null) {
      redemptionCapacity.settlementDelaySec = Math.max(redemptionCapacity.settlementDelaySec ?? 0, settlementDelaySec);
    }
    if ((redemptionCapacity.settlementDelaySec ?? 0) > 0 || (unstakeWindowSec ?? 0) > 0) {
      redemptionCapacity.capacityKind = "documented-bound";
    }
    if (sliceConfig.redemptionRoute === "async-request") {
      // Held backing does not prove when any particular withdrawal request
      // can settle. Preserve the balance as a bound, never executable capacity.
      redemptionCapacity.capacityKind = "documented-bound";
      redemptionCapacity.settlementBoundUnproven = true;
    }
    if (lockPaused) {
      redemptionCapacity.routeStatus = "paused";
      redemptionCapacity.routeStatusSource = "onchain";
      redemptionCapacity.routeStatusReason = "Configured redemption pause flag is active on-chain";
    }
  }
  if (lockPaused || redemptionCapacity?.routeStatus === "paused") {
    warnings.push(reserveDegradedWarning("erc4626-redemption-paused", "ERC-4626 redemption route is paused on-chain"));
  }

  // totalAssets includes strategy accounting, not just tokens held by the vault.
  // An unreadable holding is unattributed, never an assumed token dependency.
  if (idleUnderlyingBalanceRaw == null) {
    warnings.push(reserveDegradedWarning(
      "erc4626-idle-balance-unavailable",
      "Vault underlying holdings could not be measured; reserve exposure is unattributed",
    ));
  }
  const heldRaw = idleUnderlyingBalanceRaw == null
    ? 0n
    : idleUnderlyingBalanceRaw < totalAssetsRaw ? idleUnderlyingBalanceRaw : totalAssetsRaw;
  const idlePct = Number(heldRaw * 100_000_000_000_000n / totalAssetsRaw) / 1_000_000_000_000;
  // A reviewed `deployedExposure` attests that the configured slice descriptor
  // already covers the vault's non-idle positions, so one reviewed slice is
  // published instead of a vault-named high-risk remainder. It never applies
  // when the idle balance is unreadable: an unmeasured holding stays
  // unattributed.
  const reviewedDeployedExposure = idleUnderlyingBalanceRaw == null ? null : sliceConfig.deployedExposure ?? null;
  const deployedPct = Number((totalAssetsRaw - heldRaw) * 100_000_000_000_000n / totalAssetsRaw) / 1_000_000_000_000;
  const unknownExposurePct = reviewedDeployedExposure ? 0 : 100 - idlePct;
  const slices: ReserveSlice[] = [];
  if (reviewedDeployedExposure) {
    slices.push({
      sourceKey: `erc4626-single-asset:${primaryInput.chain}:${assetAddress}`,
      name: sliceConfig.name,
      pct: 100,
      risk: sliceConfig.risk,
      ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
      ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
    });
    warnings.push(reserveInfoWarning(
      "erc4626-deployed-exposure-reviewed",
      `Deployed share ${deployedPct.toFixed(2)}% of totalAssets() is attributed to the reviewed slice: ${reviewedDeployedExposure.basis}`,
    ));
  } else {
    if (idlePct > 0) {
      slices.push({
        sourceKey: `erc4626-single-asset:${primaryInput.chain}:${assetAddress}`,
        name: idlePct === 100 ? sliceConfig.name : `${coin.name} idle underlying`,
        pct: idlePct,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      });
    }
    if (unknownExposurePct > 0) {
      slices.push({
        sourceKey: `erc4626-single-asset:${primaryInput.chain}:${contractAddress.toLowerCase()}:deployed`,
        name: `${coin.name} ${idleUnderlyingBalanceRaw == null ? "unattributed reserve exposure" : "deployed strategy positions"}`,
        pct: unknownExposurePct,
        risk: "high",
      });
    }
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "erc4626-total-assets",
        ...(sliceConfig.redemptionRoute
          ? { redemptionMechanism: "async-request", settlementBoundReason: "Per-request withdrawal or receipt maturity; no global settlement bound observed" }
          : {}),
        ...(assetAddress
          ? { assetAddressMatchesExpected: sliceConfig.expectedAssetAddress == null || assetAddress === sliceConfig.expectedAssetAddress }
          : {}),
        ...(navConsistencyRatio != null && Number.isFinite(navConsistencyRatio)
          ? { navConsistencyRatio }
          : {}),
      }),
      chain: primaryInput.chain,
      contractAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      unknownExposurePct,
      ...(reviewedDeployedExposure
        ? { deployedPct, deployedExposureBasis: reviewedDeployedExposure.basis }
        : {}),
      ...(unstakeWindowSec != null ? { unstakeWindowSec } : {}),
      ...(assetAddress ? { assetAddress } : {}),
      ...(redemptionCapacity
        ? projectErc4626RedemptionMetadata(redemptionCapacity)
        : {}),
      ...(totalSupplyRaw != null ? { totalSupplyRaw: totalSupplyRaw.toString() } : {}),
      ...(convertToAssetsRaw != null ? { convertToAssetsRaw: convertToAssetsRaw.toString() } : {}),
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
          lockPaused || redemptionCapacity?.routeStatus === "paused"
            ? "paused" as const
            : hasDegradingWarnings(warnings)
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
