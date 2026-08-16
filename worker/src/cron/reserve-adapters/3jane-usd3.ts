import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import { encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import { resolveCoinContractAddress } from "./evm";
import {
  boolObservation,
  customObservation,
  executeEvmObservationPlan,
  uint256Observation,
  type AnyEvmObservationField,
} from "./evm-observation-plan";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";

const ADAPTER_KEY = "3jane-usd3";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WAUSDC_ADDRESS = "0xd4fa2d31b7968e448877f69a96de69f5de8cd23e";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const ETHEREUM_RPC_URL = getPublicRpcUrl("ethereum");
const ETHEREUM_FALLBACK_RPC_URL = getSecondaryFallbackRpcUrl("ethereum");

const NAV_SELECTOR = "0xc1590cd7";
const TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const BALANCE_OF_WAUSDC_SELECTOR = "0x4251c354";
const SUPPLIED_WAUSDC_SELECTOR = "0xa9b89c07";
const GET_MARKET_LIQUIDITY_SELECTOR = "0x59ddbab2";
const AVAILABLE_WITHDRAW_LIMIT_SELECTOR = "0x04bd4629";
const MIN_COMMITMENT_TIME_SELECTOR = "0x0517bbab";
const IS_SHUTDOWN_SELECTOR = "0xbf86d690";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

interface ThreeJaneUsd3Snapshot {
  contractAddress: string;
  navRaw: bigint;
  totalAssetsRaw: bigint;
  totalSupplyRaw: bigint;
  idleUsdcRaw: bigint;
  localWaUsdcRaw: bigint;
  suppliedWaUsdcRaw: bigint;
  marketTotalSupplyAssetsRaw: bigint;
  marketTotalSharesRaw: bigint;
  marketTotalBorrowAssetsRaw: bigint;
  marketLiquidityRaw: bigint;
  marketLiquidPositionRaw: bigint;
  creditPositionRaw: bigint;
  liquidPositionAssetsRaw: bigint;
  creditPositionAssetsRaw: bigint;
  availableWithdrawRaw: bigint;
  minCommitmentTimeRaw: bigint;
  isShutdown: boolean;
}

function safeIntegerFromBigInt(value: bigint, label: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`${ADAPTER_KEY} ${label} is outside the safe integer range`);
  }
  return converted;
}

function decodeMarketLiquidity(raw: `0x${string}`): readonly [bigint, bigint, bigint, bigint] {
  try {
    return decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      raw,
    ) as readonly [bigint, bigint, bigint, bigint];
  } catch {
    throw new Error(`${ADAPTER_KEY} getMarketLiquidity returned invalid data`);
  }
}

async function executeObservationPlan<const Fields extends readonly AnyEvmObservationField[]>(
  fields: Fields,
  chain: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Awaited<ReturnType<typeof executeEvmObservationPlan<Fields>>>> {
  return executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields,
    read: (calls) => fetchOnchainMulticall3({
      calls,
      chain,
      signal,
      ctx,
      rpcUrl: ETHEREUM_RPC_URL,
      fallbackRpcUrl: ETHEREUM_FALLBACK_RPC_URL,
      timeoutMs: 12_000,
    }),
  });
}

export function adaptThreeJaneUsd3Snapshot(snapshot: ThreeJaneUsd3Snapshot): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const liquidAssetsRaw = snapshot.liquidPositionAssetsRaw + snapshot.idleUsdcRaw;
  const totalReserveRaw = liquidAssetsRaw + snapshot.creditPositionAssetsRaw;
  if (totalReserveRaw <= 0n) throw new Error(`${ADAPTER_KEY} observed zero reserve assets`);
  if (snapshot.totalAssetsRaw <= 0n) throw new Error(`${ADAPTER_KEY} observed zero total assets`);
  if (snapshot.totalSupplyRaw <= 0n) throw new Error(`${ADAPTER_KEY} observed zero total supply`);

  const totalReserveUsd = decimalNumberFromBigInt(totalReserveRaw, USDC_DECIMALS);
  const totalAssetsUsd = decimalNumberFromBigInt(snapshot.totalAssetsRaw, USDC_DECIMALS);
  const navUsd = decimalNumberFromBigInt(snapshot.navRaw, USDC_DECIMALS);
  const immediateRedeemableUsd = decimalNumberFromBigInt(snapshot.availableWithdrawRaw, USDC_DECIMALS);
  const commitmentTimeSec = safeIntegerFromBigInt(snapshot.minCommitmentTimeRaw, "minimum commitment time");

  const navMismatchRatio = navUsd > 0 ? Math.abs(totalReserveUsd - navUsd) / navUsd : 1;
  if (navMismatchRatio > 0.001) {
    warnings.push(reserveDegradedWarning(
      "3jane-usd3-nav-mismatch",
      `Converted USD3 reserve components differ from nav() by ${(navMismatchRatio * 100).toFixed(3)}%`,
    ));
  }
  const reportedAssetsMismatchRatio = navUsd > 0 ? Math.abs(totalAssetsUsd - navUsd) / navUsd : 1;
  if (reportedAssetsMismatchRatio > 0.001) {
    warnings.push(reserveInfoWarning(
      "3jane-usd3-reported-assets-mismatch",
      `USD3 totalAssets() differs from current nav() by ${(reportedAssetsMismatchRatio * 100).toFixed(3)}%`,
    ));
  }
  if (snapshot.isShutdown) {
    warnings.push(reserveDegradedWarning(
      "3jane-usd3-shutdown",
      "The USD3 strategy reports isShutdown=true; withdrawals remain bounded by currently recoverable liquidity",
    ));
  }

  const capacityRatio = Math.min(1, immediateRedeemableUsd / totalAssetsUsd);
  const routeStatus = immediateRedeemableUsd <= 0
    ? "paused"
    : snapshot.isShutdown
      ? "degraded"
      : commitmentTimeSec > 0
        ? "cohort-limited"
        : "open";
  const routeStatusReason = immediateRedeemableUsd <= 0
    ? "USD3 availableWithdrawLimit(address(0)) currently reports no withdrawable USDC"
    : snapshot.isShutdown
      ? "USD3 is shut down, but the strategy still reports bounded recoverable USDC liquidity"
      : commitmentTimeSec > 0
        ? `USD3 withdrawals are liquidity-bounded and deposits must satisfy a ${commitmentTimeSec}-second commitment period`
        : "USD3 withdrawals are permissionless and bounded by current idle USDC plus redeemable waUSDC liquidity";

  return {
    slices: slicesFromValues([
      {
        name: "Aave USDC liquidity buffer",
        value: decimalNumberFromBigInt(liquidAssetsRaw, USDC_DECIMALS),
        risk: "medium",
        coinId: "usdc-circle",
        depType: "collateral",
        blacklistable: true,
      },
      {
        name: "Fintech and crypto credit receivables",
        value: decimalNumberFromBigInt(snapshot.creditPositionAssetsRaw, USDC_DECIMALS),
        risk: "high",
      },
    ]),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "3jane-usd3-onchain-accounting",
        contractAddress: snapshot.contractAddress,
        waUsdcAddress: WAUSDC_ADDRESS,
        usdcAddress: USDC_ADDRESS,
        navRaw: snapshot.navRaw.toString(),
        totalAssetsRaw: snapshot.totalAssetsRaw.toString(),
        totalSupplyRaw: snapshot.totalSupplyRaw.toString(),
        idleUsdcRaw: snapshot.idleUsdcRaw.toString(),
        localWaUsdcRaw: snapshot.localWaUsdcRaw.toString(),
        suppliedWaUsdcRaw: snapshot.suppliedWaUsdcRaw.toString(),
        marketTotalSupplyAssetsRaw: snapshot.marketTotalSupplyAssetsRaw.toString(),
        marketTotalSharesRaw: snapshot.marketTotalSharesRaw.toString(),
        marketTotalBorrowAssetsRaw: snapshot.marketTotalBorrowAssetsRaw.toString(),
        marketLiquidityRaw: snapshot.marketLiquidityRaw.toString(),
        marketLiquidPositionRaw: snapshot.marketLiquidPositionRaw.toString(),
        creditPositionRaw: snapshot.creditPositionRaw.toString(),
        isShutdown: snapshot.isShutdown,
      }),
      supplyUsd: totalAssetsUsd,
      totalReserveUsd,
      totalAssetsUsd,
      navUsd,
      collateralizationRatio: totalReserveUsd / totalAssetsUsd,
      immediateRedeemableUsd,
      immediateRedeemableRatio: capacityRatio,
      sharePriceUsd: navUsd / decimalNumberFromBigInt(snapshot.totalSupplyRaw, USDC_DECIMALS),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: immediateRedeemableUsd,
        capacityRatioOfSupply: capacityRatio,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        routeStatusReason,
        routeStatusReviewedAt: "2026-07-13",
        holderEligibility: "any-holder",
        settlementDelaySec: commitmentTimeSec,
        feeBps: 0,
        sourceUrls: [
          "https://docs.3jane.xyz/architecture/core-money-market/suppliers",
          "https://github.com/3jane-protocol/moneymarket-contracts/blob/main/src/usd3/USD3.sol",
        ],
      }),
    },
  };
}

export async function fetchThreeJaneUsd3Reserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain !== "ethereum") {
    throw new Error(`${ADAPTER_KEY} only supports ethereum, got "${input.chain}"`);
  }
  const contractAddress = resolveCoinContractAddress(coin, input.chain);
  if (!contractAddress) throw new Error(`${ADAPTER_KEY} missing Ethereum USD3 contract metadata`);

  const core = await executeObservationPlan([
    uint256Observation({ label: "nav", contract: contractAddress, data: NAV_SELECTOR }),
    uint256Observation({ label: "totalAssets", contract: contractAddress, data: TOTAL_ASSETS_SELECTOR }),
    uint256Observation({ label: "totalSupply", contract: contractAddress, data: TOTAL_SUPPLY_SELECTOR }),
    uint256Observation({ label: "localWaUsdc", contract: contractAddress, data: BALANCE_OF_WAUSDC_SELECTOR }),
    uint256Observation({ label: "suppliedWaUsdc", contract: contractAddress, data: SUPPLIED_WAUSDC_SELECTOR }),
    customObservation({
      label: "marketLiquidity",
      contract: contractAddress,
      data: GET_MARKET_LIQUIDITY_SELECTOR,
      decode: decodeMarketLiquidity,
    }),
    uint256Observation({
      label: "availableWithdraw",
      contract: contractAddress,
      data: `${AVAILABLE_WITHDRAW_LIMIT_SELECTOR}${ZERO_ADDRESS.slice(2).padStart(64, "0")}`,
    }),
    uint256Observation({ label: "minCommitmentTime", contract: contractAddress, data: MIN_COMMITMENT_TIME_SELECTOR }),
    boolObservation({ label: "isShutdown", contract: contractAddress, data: IS_SHUTDOWN_SELECTOR }),
    uint256Observation({ label: "idleUsdc", contract: USDC_ADDRESS, data: encodeBalanceOfCallData(contractAddress) }),
  ] as const, input.chain, signal, ctx);

  const suppliedWaUsdcRaw = core.values.suppliedWaUsdc;
  const localWaUsdcRaw = core.values.localWaUsdc;
  const [marketTotalSupplyAssetsRaw, marketTotalSharesRaw, marketTotalBorrowAssetsRaw, marketLiquidityRaw] =
    core.values.marketLiquidity;
  if (marketTotalSupplyAssetsRaw === 0n && suppliedWaUsdcRaw > 0n) {
    throw new Error(`${ADAPTER_KEY} strategy has a supplied position in an empty market`);
  }
  if (marketLiquidityRaw > marketTotalSupplyAssetsRaw) {
    throw new Error(`${ADAPTER_KEY} market accounting is internally inconsistent`);
  }

  const marketLiquidPositionRaw = marketTotalSupplyAssetsRaw > 0n
    ? suppliedWaUsdcRaw * marketLiquidityRaw / marketTotalSupplyAssetsRaw
    : 0n;
  const boundedMarketLiquidPositionRaw = marketLiquidPositionRaw > suppliedWaUsdcRaw
    ? suppliedWaUsdcRaw
    : marketLiquidPositionRaw;
  const creditPositionRaw = suppliedWaUsdcRaw - boundedMarketLiquidPositionRaw;
  const totalLiquidWaUsdcRaw = localWaUsdcRaw + boundedMarketLiquidPositionRaw;

  const conversion = await executeObservationPlan([
    uint256Observation({
      label: "liquidPositionAssets",
      contract: WAUSDC_ADDRESS,
      data: `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(totalLiquidWaUsdcRaw)}`,
    }),
    uint256Observation({
      label: "creditPositionAssets",
      contract: WAUSDC_ADDRESS,
      data: `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(creditPositionRaw)}`,
    }),
  ] as const, input.chain, signal, ctx);

  return adaptThreeJaneUsd3Snapshot({
    contractAddress,
    navRaw: core.values.nav,
    totalAssetsRaw: core.values.totalAssets,
    totalSupplyRaw: core.values.totalSupply,
    idleUsdcRaw: core.values.idleUsdc,
    localWaUsdcRaw,
    suppliedWaUsdcRaw,
    marketTotalSupplyAssetsRaw,
    marketTotalSharesRaw,
    marketTotalBorrowAssetsRaw,
    marketLiquidityRaw,
    marketLiquidPositionRaw: boundedMarketLiquidPositionRaw,
    creditPositionRaw,
    liquidPositionAssetsRaw: conversion.values.liquidPositionAssets,
    creditPositionAssetsRaw: conversion.values.creditPositionAssets,
    availableWithdrawRaw: core.values.availableWithdraw,
    minCommitmentTimeRaw: core.values.minCommitmentTime,
    isShutdown: core.values.isShutdown,
  });
}
