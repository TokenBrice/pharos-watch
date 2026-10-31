import { toFunctionSelector } from "viem/utils";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
  encodeUint256,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { resolveCoinContractAddress } from "./evm";
import {
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import {
  SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
  compositionPctFromRaw,
} from "./slice-math";
import { hasDegradingWarnings } from "./validate";
import { reserveInfoWarning } from "./warnings";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626NavConsistencyFromResult,
  makeContractRawCaller,
  multicallResultOrNull,
} from "./erc4626";
import {
  buildExecutableRedemptionCapacityTelemetry,
  finalizeErc4626RedemptionCapacity,
  observeConfiguredErc4626Capacity,
  projectErc4626RedemptionMetadata,
  projectErc4626RedemptionTelemetry,
  type Erc4626CapacityObservation,
  type Erc4626CapacityPauseProbe,
  type Erc4626RedemptionLiquidityConfig,
  type RedemptionCapacityTelemetry,
} from "./erc4626-redemption-capacity";
import {
  hasExecutableRedemptionObserver,
  observeExecutableRedemptionRoute,
} from "./executable-redemption-observers";
import type { ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { observeMorphoLenderBook } from "./morpho-lender-book";
import { supportsLenderBookObservation } from "@shared/lib/safety-score-v9/lender-book-registry";

const YEARN_V3_IS_SHUTDOWN_SELECTOR = "0xbf86d690";

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  deployedExposure?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["deployedExposure"];
  pooledClaim?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["pooledClaim"];
  walletCashAccounting?: LiveReserveAdapterParamsByKey["erc4626-single-asset"]["walletCashAccounting"];
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
    ...(params.pooledClaim ? { pooledClaim: params.pooledClaim } : {}),
    ...(params.walletCashAccounting ? { walletCashAccounting: params.walletCashAccounting } : {}),
    ...(params.redemptionLiquidity ? { redemptionLiquidity: params.redemptionLiquidity } : {}),
    ...(params.redemptionLock ? { redemptionLock: params.redemptionLock } : {}),
    ...(params.redemptionRoute ? { redemptionRoute: params.redemptionRoute } : {}),
    ...(params.rpcUrl ? { rpcUrl: params.rpcUrl } : {}),
    ...(params.fallbackRpcUrl ? { fallbackRpcUrl: params.fallbackRpcUrl } : {}),
  };
}

// Underlying units count as USD only for a tracked, non-NAV USD stablecoin.
function isTrackedParUsdContract(chain: string, address: string): boolean {
  for (const meta of WORKER_TRACKED_META_BY_ID.values()) {
    if (meta.flags.pegCurrency !== "USD" || meta.flags.navToken) continue;
    if (meta.contracts?.some((c) => c.chain === chain && c.address.toLowerCase() === address)) return true;
  }
  return false;
}

export async function fetchErc4626SingleAssetReserves(
  coin: ReserveAdapterCoin,
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
  const usesExecutableRedemptionRoute = hasExecutableRedemptionObserver(coin.id);
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
        // Asset-targeted locks read the reviewed expected asset; the asset()
        // identity check below rejects the snapshot if that address drifted.
        ...locks.map((lock, index) => ({
          label: `redemption-lock-${index}`,
          contract: lock.target === "asset" ? sliceConfig.expectedAssetAddress! : contractAddress,
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
    assetResult = multicallResultOrNull(stateResults, "asset");
    totalAssetsResult = multicallResultOrNull(stateResults, "total-assets");
    totalSupplyResult = multicallResultOrNull(stateResults, "total-supply");
    pauseProbe = {
      paused: decodeStrictBoolWord(multicallResultOrNull(stateResults, "paused")),
      shutdown: probesYearnShutdown
        ? decodeStrictBoolWord(multicallResultOrNull(stateResults, "yearn-shutdown"))
        : null,
    };
    for (const [index, lock] of locks.entries()) {
      const result = multicallResultOrNull(stateResults, `redemption-lock-${index}`);
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
  const assetAddress = assetResult ? decodeStrictAddressWord(assetResult as `0x${string}`) : null;
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
    convertResult: multicallResultOrNull(dependentResults, "convert-to-assets"),
    warningCode: "erc4626-nav-divergence",
  });
  const idleBalanceResult = multicallResultOrNull(dependentResults, "idle-underlying-balance");
  const decimalsResult = multicallResultOrNull(dependentResults, "underlying-decimals");
  const idleUnderlyingBalanceRaw = idleBalanceResult ? decodeUint256Word(idleBalanceResult) : null;
  const underlyingDecimalsRaw = decimalsResult ? decodeUint256Word(decimalsResult) : null;
  const { navConsistencyRatio, convertToAssetsRaw } = navCheck;
  warnings.push(...navCheck.warnings);

  let redemptionCapacity: RedemptionCapacityTelemetry | null = null;
  let executableObservation: ExecutableRedemptionObservation | null = null;
  let configuredCapacity: Erc4626CapacityObservation | null = null;
  if (assetAddress) {
    const supplyAssetsRaw = convertToAssetsRaw ?? totalAssetsRaw;
    executableObservation = usesExecutableRedemptionRoute ? await observeExecutableRedemptionRoute(
      coin.id,
      contractAddress,
      signal,
      _ctx,
      {
        extraRpcUrls: [sliceConfig.rpcUrl, sliceConfig.fallbackRpcUrl].filter(
          (url): url is string => Boolean(url),
        ),
      },
    ) : null;
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
        idleCapacityRaw: sliceConfig.walletCashAccounting ? null : idleUnderlyingBalanceRaw,
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
      const underlyingPeg = (sliceConfig.coinId
        ? WORKER_TRACKED_META_BY_ID.get(sliceConfig.coinId)?.flags.pegCurrency
        : undefined) ?? coin.flags.pegCurrency;
      if (redemptionCapacity && underlyingPeg !== "USD") {
        redemptionCapacity = null;
        warnings.push(reserveInfoWarning(
          "erc4626-capacity-non-usd-unvalued",
          `Underlying denomination ${underlyingPeg} has no same-path USD valuation; nominal asset units are not USD redemption capacity`,
        ));
      } else if (
        redemptionCapacity
        && !sliceConfig.coinId
        && !isTrackedParUsdContract(primaryInput.chain, assetAddress)
      ) {
        // An untracked underlying (e.g. fxSP pool shares) is not proven par:
        // its units are not USD. Publish the unit-free share of backing and let
        // the consumer value it against supply; without a ratio, withhold.
        const { capacityUsd: _unvaluedUnits, ...ratioOnly } = redemptionCapacity;
        redemptionCapacity = ratioOnly.capacityRatioOfSupply != null ? ratioOnly : null;
      }
    }
  }
  // A withdrawal window limits when a matured request can execute; it is not
  // additional waiting time. Keep its measured duration separate from cooldown.
  if (redemptionCapacity) {
    if (settlementDelaySec != null) {
      redemptionCapacity.settlementDelaySec = Math.max(redemptionCapacity.settlementDelaySec ?? 0, settlementDelaySec);
    }
    if (
      executableObservation == null
      && ((redemptionCapacity.settlementDelaySec ?? 0) > 0 || (unstakeWindowSec ?? 0) > 0)
    ) {
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

  // totalAssets includes strategy accounting, not just tokens held by the vault.
  // An unreadable holding is unattributed, never an assumed token dependency.
  if (idleUnderlyingBalanceRaw == null) {
    warnings.push(reserveDegradedWarning(
      "erc4626-idle-balance-unavailable",
      "Vault underlying holdings could not be measured; reserve exposure is unattributed",
    ));
  }
  // MetaMorpho V1 excludes skimmable donations; an explicit reviewed exclusion
  // also covers vaults whose accounting and burn path omit wallet balances.
  const excludesWalletCash = sliceConfig.walletCashAccounting?.mode === "excluded"
    || sliceConfig.redemptionLiquidity?.source === "morpho-vault-v1";
  // A reviewed idle/deployed split cannot be published from a clamped share:
  // when the wallet holds more than `totalAssets()` (donation, skim or stale
  // NAV accounting) the split is unknown, and clamping would report the
  // reviewed deployed leg as idle cash. Vaults without a reviewed split keep
  // publishing the single reviewed category at `totalAssets()`.
  const idleExcessRaw = idleUnderlyingBalanceRaw != null && !excludesWalletCash
    && idleUnderlyingBalanceRaw > totalAssetsRaw
    ? idleUnderlyingBalanceRaw - totalAssetsRaw
    : 0n;
  // The shared tolerance is a percentage; compare in basis points to stay exact.
  const idleExcessToleranceBps = BigInt(SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT * 100);
  if (sliceConfig.deployedExposure && idleExcessRaw * 10_000n > totalAssetsRaw * idleExcessToleranceBps) {
    throw new Error(
      `erc4626-single-asset ${coin.id} underlying balance ${idleUnderlyingBalanceRaw} exceeds totalAssets ${totalAssetsRaw}`,
    );
  }
  const heldRaw = idleUnderlyingBalanceRaw == null || excludesWalletCash
    ? 0n
    : idleUnderlyingBalanceRaw < totalAssetsRaw ? idleUnderlyingBalanceRaw : totalAssetsRaw;
  const idlePct = compositionPctFromRaw(heldRaw, totalAssetsRaw, "erc4626-single-asset idle share");
  // A reviewed `deployedExposure` covers the non-idle positions, not idle
  // holdings. Publish measured shares under distinct keys; classification
  // enrichment remains subject to the consumer's unique-match and age gates.
  // An unreadable holding stays unattributed.
  const reviewedDeployedExposure = idleUnderlyingBalanceRaw == null ? null : sliceConfig.deployedExposure ?? null;
  const deployedPct = compositionPctFromRaw(totalAssetsRaw - heldRaw, totalAssetsRaw, "erc4626-single-asset deployed share");
  const unknownExposurePct = sliceConfig.pooledClaim ? 100 : reviewedDeployedExposure ? 0 : 100 - idlePct;
  const slices: ReserveSlice[] = [];
  if (sliceConfig.pooledClaim) {
    slices.push({
      sourceKey: `erc4626-single-asset:${primaryInput.chain}:${contractAddress.toLowerCase()}:pooled-claim`,
      name: sliceConfig.name,
      pct: 100,
      risk: sliceConfig.risk,
      assetClass: "protocol-position",
    });
    warnings.push(reserveInfoWarning(
      "erc4626-opaque-pooled-claim",
      "Whole-token pooled claim has unknown look-through; accounting asset and observed idle cash do not establish reserve allocation or token dependencies.",
    ));
  } else if (reviewedDeployedExposure) {
    if (idlePct > 0) {
      slices.push({
        sourceKey: `erc4626-single-asset:${primaryInput.chain}:${assetAddress}`,
        name: `${coin.name} idle underlying`,
        pct: idlePct,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      });
    }
    if (deployedPct > 0) {
      slices.push({
        sourceKey: `erc4626-single-asset:${primaryInput.chain}:${contractAddress.toLowerCase()}:deployed`,
        name: sliceConfig.name,
        pct: deployedPct,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      });
    }
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

  const onchainPaused = lockPaused || pauseProbe.paused === true || pauseProbe.shutdown === true;
  const observedRoute = redemptionCapacity ?? configuredCapacity?.route;
  const routeStatus = onchainPaused ? "paused" as const : observedRoute?.routeStatus ?? "unknown" as const;
  const routeStatusSource = onchainPaused ? "onchain" as const : observedRoute?.routeStatusSource;
  const routeStatusReason = redemptionCapacity?.routeStatusReason
    ?? (onchainPaused
      ? "Vault pause or shutdown flag is active on-chain"
      : configuredCapacity?.route.routeStatusReason);
  const unboundedCrosschainRoute = !redemptionCapacity && configuredCapacity?.route.settlementBoundUnproven
    ? configuredCapacity.route
    : null;
  if (routeStatus === "paused") {
    const warning = unknownExposurePct === 0 && !hasDegradingWarnings(warnings)
      ? reserveInfoWarning
      : reserveDegradedWarning;
    warnings.push(warning("erc4626-redemption-paused", "ERC-4626 redemption route is paused on-chain"));
  }

  // Run only after ordinary reserve and redemption I/O has settled. The census
  // uses ctx.attemptDeadlineMs with a return margin, preserving these results.
  const lenderBookObservation = supportsLenderBookObservation(config)
    ? await observeMorphoLenderBook(coin, config, signal, _ctx)
    : undefined;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "erc4626-total-assets",
        ...(sliceConfig.redemptionRoute
          ? { redemptionMechanism: "async-request", settlementBoundReason: "Per-request withdrawal or receipt maturity; no global settlement bound observed" }
          : {}),
        ...(sliceConfig.pooledClaim
          ? { compositionBasis: "opaque-pooled-claim", pooledClaimBasis: sliceConfig.pooledClaim.basis, contextualObservationsOnly: true }
          : {}),
        ...(sliceConfig.walletCashAccounting
          ? { walletCashAccounting: sliceConfig.walletCashAccounting }
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
      ...(lenderBookObservation ? { lenderBookObservation } : {}),
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
          ? projectErc4626RedemptionTelemetry(redemptionCapacity)
          : { capacityKind: unboundedCrosschainRoute ? "documented-bound" as const : "documented-eventual" as const }),
        ...(unboundedCrosschainRoute ? {
          settlementBoundUnproven: true,
          freshnessKind: unboundedCrosschainRoute.freshnessKind,
          sourceTimestamp: unboundedCrosschainRoute.sourceTimestamp,
          sourceUrls: unboundedCrosschainRoute.sourceUrls,
          holderEligibility: unboundedCrosschainRoute.holderEligibility,
        } : {}),
        routeStatus,
        ...(routeStatusSource != null ? { routeStatusSource } : {}),
        ...(routeStatusReason != null ? { routeStatusReason } : {}),
        ...(!redemptionCapacity && configuredCapacity?.diagnostics.morphoWarnings != null
          ? { observerDiagnostics: { morphoWarnings: configuredCapacity.diagnostics.morphoWarnings } }
          : {}),
        ...(configuredCapacity?.v9RouteAttempt
          ? { v9RouteAttempt: configuredCapacity.v9RouteAttempt }
          : {}),
      },
    },
  };
}
