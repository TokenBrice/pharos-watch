import type { DexExitRouteObservation } from "@shared/types/exit-route";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { CURVE_NAV_SPOT_QUOTE_POLICY_ID } from "../../cron/dex-liquidity/types";
import { makeDexLiquidityRow } from "../../test-helpers/__shared/fixtures";

export function makeCoinbaseRouteObservation(): DexExitRouteObservation {
  return {
    routeId: "dex:usdc:cg-tickers:coinbase",
    routeFamily: "dex-orderbook",
    scope: { kind: "venue", venue: "coinbase", protocol: "coinbase" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 500_000,
    completionRatio: 0.5,
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "direct-orderbook-depth",
    confidence: "medium",
    scoreEligible: false,
    observedAt: 1_720_000_000,
    freshnessSeconds: 0,
    commonModeKeys: ["protocol:coinbase", "fiat:usd"],
    capacityCurve: [
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 500_000,
        completionRatio: 0.5,
      },
    ],
  };
}

export const NAV_CURVE_POOL_ID = "ethereum:0x2c7c98a3b1582d83c43987202aeff638312478ae";

export interface ClockedCurveNavPayloadInput {
  poolRatioObservedAt: number;
  quoteMarkObservedAt?: number;
  captureEvaluatedAtSec?: number;
  quotePublishedAtSec?: number;
  aggregateObservedAt?: number | null;
  displayAggregateObservedAt?: number | null;
  quoteMaxAgeSec?: number;
  price?: number;
  tvl?: number;
  poolId?: string;
  admissionMode?: "sole-venue" | "corroborated";
  quoteCaptures?: unknown[];
}

export function makeClockedCurveNavPayload(input: ClockedCurveNavPayloadInput) {
  const {
    poolRatioObservedAt,
    quoteMarkObservedAt = poolRatioObservedAt,
    captureEvaluatedAtSec = poolRatioObservedAt + 60,
    quotePublishedAtSec,
    displayAggregateObservedAt,
    quoteMaxAgeSec = DEX_FRESHNESS_SEC,
    price = 1.07,
    tvl = 2_500_000,
    poolId = NAV_CURVE_POOL_ID,
    admissionMode = "sole-venue",
    quoteCaptures,
  } = input;
  const minAt = Math.min(poolRatioObservedAt, quoteMarkObservedAt);
  const aggAt = input.aggregateObservedAt !== undefined ? input.aggregateObservedAt : minAt;
  const displayField = displayAggregateObservedAt !== undefined ? { displayAggregateObservedAt } : {};
  const source = {
    protocol: "curve",
    chain: "ethereum",
    price,
    tvl,
    observedAt: aggAt ?? minAt,
    aggregateObservedAt: aggAt,
    ...displayField,
  };
  return {
    aggregateObservedAt: aggAt,
    ...displayField,
    quotePolicy: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
    quoteMaxAgeSec,
    ...(quotePublishedAtSec !== undefined ? { quotePublishedAtSec } : {}),
    quoteCaptures: quoteCaptures ?? [{
      policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
      poolId,
      blockNumber: 26_500_642,
      blockHash: `0x${"11".repeat(32)}`,
      poolRatioObservedAt,
      quoteMarkObservedAt,
      captureEvaluatedAtSec,
      sourceGenerationId: "dex-stage:fixture",
      admissionMode,
    }],
    sources: aggAt != null ? [source] : [],
    ...(aggAt == null ? { displaySources: [source] } : {}),
  };
}

export function makeClockedCurveNavApiRows(
  input: ClockedCurveNavPayloadInput & {
    stablecoinId?: string;
    updatedAt: number;
    embedTopPoolQuote?: boolean;
  },
) {
  const { stablecoinId = "stusds-sky", poolId = NAV_CURVE_POOL_ID, price = 1.07, tvl = 2_500_000 } = input;
  const payload = makeClockedCurveNavPayload({ ...input, price, tvl, poolId });
  return {
    liquidityRow: makeDexLiquidityRow({
      stablecoin_id: stablecoinId,
      total_tvl_usd: tvl,
      total_volume_24h_usd: 800_000,
      updated_at: input.updatedAt,
      top_pools_json: JSON.stringify([{
        poolId,
        project: "curve",
        chain: "Ethereum",
        symbol: "USDS / stUSDS",
        poolType: "curve-stableswap",
        tvlUsd: tvl,
        volumeUsd1d: 800_000,
        price,
        source: "dl",
        ...(input.embedTopPoolQuote
          ? {
              curveNavSpotQuote: payload.quoteCaptures[0],
              ...(input.quotePublishedAtSec !== undefined ? { quotePublishedAtSec: input.quotePublishedAtSec } : {}),
            }
          : {}),
      }]),
    }),
    priceRow: {
      stablecoin_id: stablecoinId,
      dex_price_usd: price,
      deviation_from_primary_bps: -210,
      source_pool_count: 1,
      source_total_tvl: tvl,
      price_sources_json: JSON.stringify(payload),
      updated_at: input.updatedAt,
    },
    payload,
  };
}
