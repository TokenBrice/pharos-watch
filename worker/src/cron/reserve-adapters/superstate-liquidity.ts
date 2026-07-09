import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";
import { decimalNumberFromBigInt, fetchErc20Balance, fetchJsonWithRetry, requireOnchainInput } from "./helpers";

// Superstate's instant-redemption buffer: USDC held by the RedemptionIdle contract on Ethereum.
const USDC_ETHEREUM_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SUPERSTATE_REDEMPTION_IDLE_ADDRESS = "0x4c21b7577c8fe8b0b0669165ee7c8f67fa1454cf";
const USDC_DECIMALS = 6;

interface SuperstateLiquidityEntry {
  circle_usd_available_amount?: string | number;
  usdc_redemption_idle_balance?: string | number;
}

type SuperstateLiquidityResponse = Record<string, SuperstateLiquidityEntry | undefined>;

function parseAmount(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`superstate-liquidity invalid ${label}`);
  }
  return parsed;
}

export function adaptSuperstateLiquidity(
  navResult: AdapterResult,
  payload: SuperstateLiquidityResponse,
  ticker: string,
  onchainRedemptionIdleUsd: number,
): AdapterResult {
  const entry = payload[ticker];
  if (!entry) {
    throw new Error(`superstate-liquidity missing ${ticker} liquidity entry`);
  }

  const circleUsdAvailable = parseAmount(entry.circle_usd_available_amount, "circle_usd_available_amount");
  const usdcRedemptionIdle = parseAmount(entry.usdc_redemption_idle_balance, "usdc_redemption_idle_balance");
  // Kept as context/fallback; the on-chain RedemptionIdle balance above is now the capacity of record.
  const apiLiquidityUsd = circleUsdAvailable + usdcRedemptionIdle;
  const navDetails =
    typeof navResult.metadata?.details === "object" && navResult.metadata.details != null
      ? navResult.metadata.details
      : {};

  return {
    ...navResult,
    metadata: {
      ...(navResult.metadata ?? {}),
      superstateLiquidityTicker: ticker,
      circleUsdAvailable,
      usdcRedemptionIdle,
      apiLiquidityUsd,
      immediateRedeemableUsd: onchainRedemptionIdleUsd,
      liquidityFreshnessSource: "same-run-onchain" as const,
      redemption: {
        capacityUsd: onchainRedemptionIdleUsd,
        capacityKind: "live-direct-bounded" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: onchainRedemptionIdleUsd > 0 ? "open" as const : "paused" as const,
        routeStatusSource: "onchain" as const,
        sourceUrls: [`https://etherscan.io/address/${SUPERSTATE_REDEMPTION_IDLE_ADDRESS}`],
      },
      details: {
        ...navDetails,
        apiLiquidityUsd,
        liquidityFreshnessSource: "same-run-onchain",
      },
    },
  };
}

export async function fetchSuperstateLiquidityReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("superstate-liquidity", config.params);
  const { liquidityUrl, ticker, ...chainlinkParams } = params;
  const input = requireOnchainInput(config.inputs.primary, "superstate-liquidity");

  const [navResult, payload, redemptionIdleBalanceRaw] = await Promise.all([
    fetchChainlinkNavCore(
      coin,
      {
        ...config,
        params: chainlinkParams,
      },
      signal,
      ctx,
    ),
    fetchJsonWithRetry<SuperstateLiquidityResponse>(
      liquidityUrl,
      signal,
      12_000,
      ctx,
    ),
    fetchErc20Balance(
      input,
      USDC_ETHEREUM_ADDRESS,
      SUPERSTATE_REDEMPTION_IDLE_ADDRESS,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);

  if (redemptionIdleBalanceRaw == null) {
    throw new Error("superstate-liquidity: failed to read RedemptionIdle contract USDC balance");
  }

  return adaptSuperstateLiquidity(
    navResult,
    payload,
    ticker,
    decimalNumberFromBigInt(redemptionIdleBalanceRaw, USDC_DECIMALS),
  );
}
