import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { AdapterContext, AdapterResult } from "./types";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";
import {
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchJsonWithRetry,
  parseFiniteNumber,
  requireOnchainInput,
  reserveInfoWarning,
} from "./helpers";

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
  try {
    return parseFiniteNumber(value, { label, min: 0 });
  } catch {
    throw new Error(`superstate-liquidity invalid ${label}`);
  }
}

export function adaptSuperstateLiquidity(
  navResult: AdapterResult,
  payload: SuperstateLiquidityResponse | null,
  ticker: string,
  onchainRedemptionIdleUsd: number,
  warnings: LiveReserveWarning[] = [],
): AdapterResult {
  // The issuer liquidity body is context only: its failure must not discard an
  // otherwise valid NAV composition or the on-chain RedemptionIdle capacity.
  let liquidityContext: {
    circleUsdAvailable: number;
    usdcRedemptionIdle: number;
    apiLiquidityUsd: number;
  } | null = null;
  if (payload != null) {
    try {
      const entry = payload[ticker];
      if (!entry) {
        throw new Error(`superstate-liquidity missing ${ticker} liquidity entry`);
      }
      const circleUsdAvailable = parseAmount(entry.circle_usd_available_amount, "circle_usd_available_amount");
      const usdcRedemptionIdle = parseAmount(entry.usdc_redemption_idle_balance, "usdc_redemption_idle_balance");
      liquidityContext = {
        circleUsdAvailable,
        usdcRedemptionIdle,
        // Kept as context/fallback; the on-chain RedemptionIdle balance above is the capacity of record.
        apiLiquidityUsd: circleUsdAvailable + usdcRedemptionIdle,
      };
    } catch (error) {
      warnings.push(reserveInfoWarning(
        "superstate-liquidity-unavailable",
        `Superstate liquidity feed was unreadable; NAV slices and on-chain capacity still publish: ${toErrorMessage(error)}`,
      ));
    }
  }
  const navDetails =
    typeof navResult.metadata?.details === "object" && navResult.metadata.details != null
      ? navResult.metadata.details
      : {};

  return {
    ...navResult,
    ...(warnings.length > 0
      ? { warnings: [...(navResult.warnings ?? []), ...warnings] }
      : {}),
    metadata: {
      ...(navResult.metadata ?? {}),
      superstateLiquidityTicker: ticker,
      ...(liquidityContext != null
        ? {
            circleUsdAvailable: liquidityContext.circleUsdAvailable,
            usdcRedemptionIdle: liquidityContext.usdcRedemptionIdle,
            apiLiquidityUsd: liquidityContext.apiLiquidityUsd,
          }
        : {}),
      liquidityFreshnessSource: "same-run-onchain" as const,
      redemption: {
        capacityUsd: onchainRedemptionIdleUsd,
        capacityKind: "live-direct-bounded" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: "unknown" as const,
        routeStatusSource: "static-config" as const,
        sourceUrls: [`https://etherscan.io/address/${SUPERSTATE_REDEMPTION_IDLE_ADDRESS}`],
      },
      details: {
        ...navDetails,
        ...(liquidityContext != null ? { apiLiquidityUsd: liquidityContext.apiLiquidityUsd } : {}),
        liquidityFreshnessSource: "same-run-onchain",
      },
    },
  };
}

export async function fetchSuperstateLiquidityReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("superstate-liquidity", config.params);
  const { liquidityUrl, ticker, ...chainlinkParams } = params;
  const input = requireOnchainInput(config.inputs.primary, "superstate-liquidity");
  const warnings: LiveReserveWarning[] = [];

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
    ).catch((error) => {
      if (signal.aborted) throw error;
      warnings.push(reserveInfoWarning(
        "superstate-liquidity-unavailable",
        redactProviderUrls(`Superstate liquidity feed failed: ${liquidityUrl}: ${toErrorMessage(error)}`),
      ));
      return null;
    }),
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
    warnings,
  );
}
