import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData, encodeUint256, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  notApplicableFreshnessMetadata,
  parseBoundedDecimals,
  requireOnchainInput,
} from "./helpers";
import { decodeAbiWordAt, decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { fetchOnchainMulticall3 } from "./onchain";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "stoneyield-router-pool";

const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ROUTER_TOTAL_MANAGED_ASSETS_SELECTOR = "0x05b2bfb0";
const ROUTER_STRATEGIES_SELECTOR = "0xd574ea3d";
const ROUTER_STRATEGY_COUNT_SELECTOR = "0x22068b44";
const VENUS_EXCHANGE_RATE_STORED_SELECTOR = "0x182df0f5";
const USDC_DECIMALS = 18;
const BASIS_POINTS = 10_000n;
const ROUTER_NAV_DIVERGENCE_TOLERANCE_BPS = 100n;

type StoneyieldRouterPoolParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

type MulticallResult = EvmMulticall3Result[] | null;

function indexedCallData(selector: string, index: bigint): `0x${string}` {
  return `${selector}${encodeUint256(index)}` as `0x${string}`;
}

function requiredResult(results: MulticallResult, label: string): `0x${string}` {
  if (!results) {
    throw new Error(`${ADAPTER_KEY} multicall failed while reading ${label}`);
  }
  const result = results.find((candidate) => candidate.label === label);
  if (!result?.success || result.returnData === "0x") {
    throw new Error(`${ADAPTER_KEY} multicall leg ${label} failed`);
  }
  return result.returnData;
}

function requiredSingleWord(raw: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY} ${label} returned malformed ABI word`);
  }
  return raw as `0x${string}`;
}

function requiredUint256(raw: string, label: string): bigint {
  const value = decodeUint256Word(requiredSingleWord(raw, label));
  if (value == null) {
    throw new Error(`${ADAPTER_KEY} ${label} returned an undecodable uint256`);
  }
  return value;
}

function requiredDecimals(raw: string, label: string): number {
  const value = requiredUint256(raw, label);
  const decimals = parseBoundedDecimals(value);
  if (decimals == null) {
    throw new Error(`${ADAPTER_KEY} ${label} returned invalid decimals`);
  }
  return decimals;
}

function requiredAddress(raw: string, label: string): string {
  const address = decodeStrictAddressWord(requiredSingleWord(raw, label));
  if (!address) {
    throw new Error(`${ADAPTER_KEY} ${label} returned an invalid address`);
  }
  return address.toLowerCase();
}

function ratioFromRaw(numerator: bigint, denominator: bigint, label: string): number {
  if (denominator <= 0n) {
    throw new Error(`${ADAPTER_KEY} ${label} denominator is not positive`);
  }
  const numeratorDecimal = decimalNumberFromBigInt(numerator, USDC_DECIMALS);
  const denominatorDecimal = decimalNumberFromBigInt(denominator, USDC_DECIMALS);
  const ratio = numeratorDecimal / denominatorDecimal;
  if (!Number.isFinite(ratio)) {
    throw new Error(`${ADAPTER_KEY} ${label} ratio is not finite`);
  }
  return ratio;
}

function strategyResult(raw: string): {
  address: string;
  weightBps: bigint;
  active: boolean;
} {
  if (!/^0x[0-9a-fA-F]{192}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY} router.strategies(0) returned a malformed tuple`);
  }
  const address = decodeStrictAddressWord(decodeAbiWordAt(raw, 0));
  const weightBps = decodeUint256Word(decodeAbiWordAt(raw, 1));
  const active = decodeStrictBoolWord(decodeAbiWordAt(raw, 2));
  if (!address || weightBps == null || active == null) {
    throw new Error(`${ADAPTER_KEY} router.strategies(0) returned an undecodable tuple`);
  }
  return { address: address.toLowerCase(), weightBps, active };
}

function divergenceWarning(
  routerStrategyAssetsRaw: bigint,
  venusPositionRaw: bigint,
): LiveReserveWarning[] {
  const basis = routerStrategyAssetsRaw > venusPositionRaw ? routerStrategyAssetsRaw : venusPositionRaw;
  if (basis <= 0n) return [];
  const difference = routerStrategyAssetsRaw >= venusPositionRaw
    ? routerStrategyAssetsRaw - venusPositionRaw
    : venusPositionRaw - routerStrategyAssetsRaw;
  // A 1% (100 bps) tolerance permits ordinary previewRedeem/rate rounding;
  // larger disagreements indicate the router's look-through is not verified.
  if (difference * BASIS_POINTS <= basis * ROUTER_NAV_DIVERGENCE_TOLERANCE_BPS) return [];
  const divergencePct = (Number(difference) / Number(basis)) * 100;
  return [{
    code: "router-nav-divergence",
    message: `StoneYield Venus look-through diverges from router strategy accounting by ${divergencePct.toFixed(2)}%`,
    severity: "warning",
    effect: "degraded",
  }];
}

export async function fetchStoneyieldRouterPoolReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params) as StoneyieldRouterPoolParams;
  const usdcAddress = params.usdcAddress.toLowerCase();
  const susdcAddress = params.susdcAddress.toLowerCase();
  const routerAddress = params.routerAddress.toLowerCase();
  const venusVaultAddress = params.venusVaultAddress.toLowerCase();
  const venusVTokenAddress = params.venusVTokenAddress.toLowerCase();
  const stusdAddress = params.stusdAddress.toLowerCase();
  const configuredCoinAddress = coin.contracts?.find((entry) => entry.chain === input.chain)?.address.toLowerCase();

  if (configuredCoinAddress !== stusdAddress) {
    throw new Error(
      `${ADAPTER_KEY} STUSD contract mismatch for ${coin.id}: config ${stusdAddress}, coin ${configuredCoinAddress ?? "missing"}`,
    );
  }

  const calls = [
    { label: "stusd-total-supply", contract: stusdAddress, data: TOTAL_SUPPLY_SELECTOR },
    { label: "susdc-total-supply", contract: susdcAddress, data: TOTAL_SUPPLY_SELECTOR },
    { label: "susdc-idle-usdc", contract: usdcAddress, data: encodeBalanceOfCallData(susdcAddress) },
    { label: "usdc-decimals", contract: usdcAddress, data: DECIMALS_SELECTOR },
    { label: "router-idle-usdc", contract: usdcAddress, data: encodeBalanceOfCallData(routerAddress) },
    { label: "router-total-managed-assets", contract: routerAddress, data: ROUTER_TOTAL_MANAGED_ASSETS_SELECTOR },
    { label: "router-asset", contract: routerAddress, data: ERC4626_ASSET_SELECTOR },
    { label: "router-strategy-0", contract: routerAddress, data: indexedCallData(ROUTER_STRATEGIES_SELECTOR, 0n) },
    { label: "router-strategy-count", contract: routerAddress, data: ROUTER_STRATEGY_COUNT_SELECTOR },
    { label: "venus-vault-asset", contract: venusVaultAddress, data: ERC4626_ASSET_SELECTOR },
    { label: "venus-vtoken-balance", contract: venusVTokenAddress, data: encodeBalanceOfCallData(venusVaultAddress) },
    { label: "venus-exchange-rate", contract: venusVTokenAddress, data: VENUS_EXCHANGE_RATE_STORED_SELECTOR },
    { label: "venus-vtoken-decimals", contract: venusVTokenAddress, data: DECIMALS_SELECTOR },
  ] as const;

  const results = await fetchOnchainMulticall3({
    calls,
    signal,
    ctx,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: 12_000,
  });

  const stusdSupplyRaw = requiredUint256(requiredResult(results, "stusd-total-supply"), "STUSD totalSupply()");
  const susdcSupplyRaw = requiredUint256(requiredResult(results, "susdc-total-supply"), "sUSDC totalSupply()");
  const susdcIdleUsdcRaw = requiredUint256(requiredResult(results, "susdc-idle-usdc"), "USDC.balanceOf(sUSDC)");
  const usdcDecimals = requiredDecimals(requiredResult(results, "usdc-decimals"), "USDC decimals()");
  const routerIdleUsdcRaw = requiredUint256(requiredResult(results, "router-idle-usdc"), "USDC.balanceOf(router)");
  const routerTotalManagedAssetsRaw = requiredUint256(
    requiredResult(results, "router-total-managed-assets"),
    "router.totalManagedAssets()",
  );
  const routerAssetAddress = requiredAddress(requiredResult(results, "router-asset"), "router.asset()");
  const strategy = strategyResult(requiredResult(results, "router-strategy-0"));
  const strategyCountRaw = requiredUint256(requiredResult(results, "router-strategy-count"), "router.strategyCount()");
  const venusVaultAssetAddress = requiredAddress(requiredResult(results, "venus-vault-asset"), "VenusUSDCVault.asset()");
  const venusVTokenBalanceRaw = requiredUint256(
    requiredResult(results, "venus-vtoken-balance"),
    "vUSDC.balanceOf(VenusUSDCVault)",
  );
  const venusExchangeRateRaw = requiredUint256(
    requiredResult(results, "venus-exchange-rate"),
    "vUSDC.exchangeRateStored()",
  );
  const venusVTokenDecimals = requiredDecimals(
    requiredResult(results, "venus-vtoken-decimals"),
    "vUSDC decimals()",
  );

  if (usdcDecimals !== USDC_DECIMALS) {
    throw new Error(`${ADAPTER_KEY} USDC decimals() returned ${usdcDecimals}, expected ${USDC_DECIMALS}`);
  }
  if (stusdSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} STUSD totalSupply() is zero for ${coin.id}`);
  }
  if (routerTotalManagedAssetsRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} router.totalManagedAssets() is not positive for ${coin.id}`);
  }
  if (routerAssetAddress !== usdcAddress) {
    throw new Error(`${ADAPTER_KEY} router.asset() returned ${routerAssetAddress}, expected ${usdcAddress}`);
  }
  if (strategy.address !== venusVaultAddress) {
    throw new Error(`${ADAPTER_KEY} router.strategies(0) returned ${strategy.address}, expected ${venusVaultAddress}`);
  }
  if (!strategy.active) {
    throw new Error(`${ADAPTER_KEY} router.strategies(0) is inactive for ${coin.id}`);
  }
  if (strategyCountRaw !== 1n) {
    throw new Error(
      `${ADAPTER_KEY} router.strategyCount() returned ${strategyCountRaw}, but exactly one identity-pinned strategy is required for ${coin.id}`,
    );
  }
  if (venusVaultAssetAddress !== venusVTokenAddress) {
    throw new Error(
      `${ADAPTER_KEY} VenusUSDCVault.asset() returned ${venusVaultAssetAddress}, expected ${venusVTokenAddress}`,
    );
  }
  if (venusVTokenBalanceRaw > 0n && venusExchangeRateRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} vUSDC exchangeRateStored() is not positive for a funded Venus position`);
  }
  const exchangeRateExponent = 18 + usdcDecimals - venusVTokenDecimals;
  if (exchangeRateExponent < 0) {
    throw new Error(
      `${ADAPTER_KEY} Venus exchange-rate decimals are incompatible with USDC decimals for ${coin.id}`,
    );
  }
  // Compound/Venus exchangeRateStored() uses 10^(18 + underlying decimals -
  // receipt-token decimals); BSC USDC is 18dp and vUSDC is 8dp, so this is 1e28.
  const exchangeRateScale = 10n ** BigInt(exchangeRateExponent);
  if (routerTotalManagedAssetsRaw < routerIdleUsdcRaw) {
    throw new Error(`${ADAPTER_KEY} router managed assets are below router idle USDC for ${coin.id}`);
  }

  const numeratorRaw = susdcIdleUsdcRaw + routerTotalManagedAssetsRaw;
  if (numeratorRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} pool USDC backing is not positive for ${coin.id}`);
  }
  const routerStrategyAssetsRaw = routerTotalManagedAssetsRaw - routerIdleUsdcRaw;
  // Normalize the vToken balance to vToken units and exchangeRateStored() to
  // underlying units, using the Compound/Venus scale derived above. Convert
  // the result back to USDC's raw units for an exact accounting comparison.
  const venusPositionRaw = (
    venusVTokenBalanceRaw
    * venusExchangeRateRaw
    * (10n ** BigInt(usdcDecimals))
  ) / ((10n ** BigInt(venusVTokenDecimals)) * exchangeRateScale);
  const coverageRatio = ratioFromRaw(numeratorRaw, stusdSupplyRaw, "STUSD coverage");
  const susdcCoverageRatio = susdcSupplyRaw > 0n
    ? ratioFromRaw(numeratorRaw, susdcSupplyRaw, "sUSDC pool coverage")
    : undefined;

  const warnings: LiveReserveWarning[] = [
    ...buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `StoneYield pool USDC backing covers ${pct}% of STUSD supply`,
      coverageRatio,
    }),
    ...buildCoverageShortfallWarnings({
      code: "susdc-supply-shortfall",
      message: (pct) => `StoneYield pool USDC backing covers ${pct}% of sUSDC supply`,
      coverageRatio: susdcCoverageRatio,
    }),
    ...divergenceWarning(routerStrategyAssetsRaw, venusPositionRaw),
  ];
  if (susdcSupplyRaw <= 0n) {
    warnings.push({
      code: "susdc-supply-unavailable",
      message: "StoneYield sUSDC totalSupply() is zero; pool-to-sUSDC coverage could not be assessed",
      severity: "warning",
      effect: "degraded",
    });
  }

  const sliceConfig = params.slice;
  const slice: ReserveSlice = {
    name: sliceConfig.name,
    pct: 100,
    risk: sliceConfig.risk,
    ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
    ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
  };

  return {
    slices: [slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "stoneyield-router-pool-look-through",
        routerAssetAddress,
        venusVaultAssetAddress,
        strategyAddress: strategy.address,
        strategyActive: strategy.active,
        strategyWeightBps: strategy.weightBps.toString(),
        strategyCount: Number(strategyCountRaw),
        usdcDecimals,
        venusVTokenDecimals,
        venusExchangeRateScaleExponent: exchangeRateExponent,
        susdcSupplyRaw: susdcSupplyRaw.toString(),
        susdcIdleUsdcRaw: susdcIdleUsdcRaw.toString(),
        routerIdleUsdcRaw: routerIdleUsdcRaw.toString(),
        routerTotalManagedAssetsRaw: routerTotalManagedAssetsRaw.toString(),
        routerStrategyAssetsRaw: routerStrategyAssetsRaw.toString(),
        venusVTokenBalanceRaw: venusVTokenBalanceRaw.toString(),
        venusExchangeRateRaw: venusExchangeRateRaw.toString(),
        venusPositionRaw: venusPositionRaw.toString(),
        stusdSupplyRaw: stusdSupplyRaw.toString(),
        poolBackingRaw: numeratorRaw.toString(),
        coverageRatio,
        ...(susdcCoverageRatio != null ? { susdcCoverageRatio } : {}),
      }),
      chain: input.chain,
      contractAddress: stusdAddress,
      totalAssetsRaw: numeratorRaw.toString(),
      totalSupplyRaw: stusdSupplyRaw.toString(),
      collateralizationRatio: coverageRatio,
    },
  };
}
