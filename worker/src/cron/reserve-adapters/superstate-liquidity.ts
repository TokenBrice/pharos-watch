import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchChainlinkNavReserves } from "./chainlink-nav";
import { fetchJsonWithRetry } from "./helpers";

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
): AdapterResult {
  const entry = payload[ticker];
  if (!entry) {
    throw new Error(`superstate-liquidity missing ${ticker} liquidity entry`);
  }

  const circleUsdAvailable = parseAmount(entry.circle_usd_available_amount, "circle_usd_available_amount");
  const usdcRedemptionIdle = parseAmount(entry.usdc_redemption_idle_balance, "usdc_redemption_idle_balance");
  const capacityUsd = circleUsdAvailable + usdcRedemptionIdle;

  const navSourceTimestamp =
    navResult.metadata?.sourceTimestamp ?? navResult.metadata?.redemption?.sourceTimestamp;

  return {
    ...navResult,
    metadata: {
      ...(navResult.metadata ?? {}),
      superstateLiquidityTicker: ticker,
      circleUsdAvailable,
      usdcRedemptionIdle,
      immediateRedeemableUsd: capacityUsd,
      redemption: {
        capacityUsd,
        capacityKind: "live-proxy-validated" as const,
        freshnessKind: "same-run-api" as const,
        ...(navSourceTimestamp !== undefined ? { sourceTimestamp: navSourceTimestamp } : {}),
        routeStatus: capacityUsd > 0 ? "open" as const : "paused" as const,
        routeStatusSource: "protocol-api" as const,
        sourceUrls: ["https://api.superstate.com/v1/funds/liquidity"],
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
  const navResult = await fetchChainlinkNavReserves(
    coin,
    {
      ...config,
      params: chainlinkParams,
    },
    signal,
    ctx,
  );
  const payload = await fetchJsonWithRetry<SuperstateLiquidityResponse>(
    liquidityUrl,
    signal,
    12_000,
    ctx,
  );
  return adaptSuperstateLiquidity(navResult, payload, ticker);
}
