import { logWorkerEventArgs } from "../lib/structured-log";
import type { StablecoinMeta } from "@shared/types/core";
import { buildPriceReasonablenessOptions } from "../lib/price-validation";
import { fetchAuthoritativeHistoricalPriceSeries } from "../lib/authoritative-price-sources";
import { normalizeSupportedPegCurrency } from "../lib/native-peg-quotes";
import {
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPriceSeries,
  type HistoricalMarketSourceDiagnostics,
} from "./backfill-price-sources";
import {
  BACKFILL_MIN_CONFIRM_POINTS,
  extractDepegEvents,
  type BackfillEvent,
  type SupplySnapshot,
} from "./backfill-depegs-extraction";
import {
  eventOverlapsReplayWindow,
  timestampInReplayWindow,
  type BackfillReplayWindow,
} from "./backfill-depegs-window";

const BACKFILL_NATIVE_PEG_PENDING_MAX_GAP_SEC = 36 * 3600;
const BACKFILL_NATIVE_PEG_EXTREME_SINGLE_POINT_BPS = 5000;

export interface BackfillCoinReplayResult {
  events: BackfillEvent[] | null;
  sourceKind: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketDiagnostics: HistoricalMarketSourceDiagnostics | null;
}

export async function backfillCoin(opts: {
  meta: StablecoinMeta;
  geckoId: string;
  getPegRef: (timestamp: number) => number;
  supplyByDate: SupplySnapshot[];
  fxRates?: Record<string, number>;
  replayWindow?: BackfillReplayWindow | null;
  coingeckoApiKey?: string | null;
  missingSupplyUsd?: number | null;
}): Promise<BackfillCoinReplayResult> {
  const {
    meta,
    geckoId,
    getPegRef,
    supplyByDate,
    fxRates,
    replayWindow,
    coingeckoApiKey,
    missingSupplyUsd,
  } = opts;
  const pegType = `pegged${meta.flags.pegCurrency}`;
  const nativePegCurrency = normalizeSupportedPegCurrency(meta.flags.pegCurrency);
  const candidateSupplySnapshots = replayWindow
    ? supplyByDate.filter((snapshot) => timestampInReplayWindow(snapshot.ts, replayWindow))
    : supplyByDate;
  if (
    supplyByDate.length === 0 &&
    (typeof missingSupplyUsd !== "number" || !Number.isFinite(missingSupplyUsd))
  ) {
    logWorkerEventArgs("api", "warn",
      `[backfill-depegs] no historical or current supply floor available for ${meta.symbol}; preserving existing backfill rows`,
    );
    return {
      events: null,
      sourceKind: "preserve-existing",
      authoritativeSource: null,
      marketDiagnostics: null,
    };
  }

  let marketSeries:
    | Awaited<ReturnType<typeof fetchMarketBackfillPriceSeries>>
    | null = null;
  const loadMarketSeries = async (
    quoteMode: "native-peg" | "usd" = "usd",
  ): Promise<Awaited<ReturnType<typeof fetchMarketBackfillPriceSeries>>> => {
    if (marketSeries != null && marketSeries.diagnostics.quoteMode === quoteMode) return marketSeries;

    const series = await fetchMarketBackfillPriceSeries(meta, geckoId, {
      granularity: quoteMode === "native-peg" ? "daily" : "hourly",
      range: replayWindow
        ? {
            startSec: replayWindow.replayStartSec,
            endSec: replayWindow.replayEndSec,
          }
        : undefined,
      quote: {
        pegCurrency: meta.flags.pegCurrency,
        useNativePegQuote: quoteMode === "native-peg",
      },
      coingeckoApiKey: coingeckoApiKey ?? null,
    });
    if (
      series.diagnostics.mergeReasons.length > 0 ||
      series.diagnostics.policyAdjustments.length > 0 ||
      series.diagnostics.quoteMode === "native-peg"
    ) {
      logWorkerEventArgs("api", "info",
        `[backfill-depegs] ${meta.id} historical market replay used ${series.diagnostics.sourcesUsed.join("+") || "none"}`
          + ` quote=${series.diagnostics.quoteCurrency}`
          + ` mergeReasons=${series.diagnostics.mergeReasons.join(",") || "none"}`
          + ` adjustments=${series.diagnostics.policyAdjustments.length}`,
      );
    }
    marketSeries = series;
    return series;
  };

  let candidateTimestamps: number[];
  if (candidateSupplySnapshots.length > 0) {
    candidateTimestamps = candidateSupplySnapshots.map((snapshot) => snapshot.ts);
  } else {
    let candidateSeries = nativePegCurrency ? await loadMarketSeries("native-peg") : await loadMarketSeries("usd");
    if ((!candidateSeries.prices || candidateSeries.prices.length === 0) && nativePegCurrency) {
      candidateSeries = await loadMarketSeries("usd");
    }
    candidateTimestamps = collapsePricesToDailyTimestamps(candidateSeries.prices ?? []);
  }

  const authoritativeHistory = await fetchAuthoritativeHistoricalPriceSeries(meta, {
    candidateTimestamps,
    supplySnapshots: supplyByDate,
    coingeckoApiKey: coingeckoApiKey ?? null,
  });

  let prices = authoritativeHistory.prices;
  let sourceKind: BackfillCoinReplayResult["sourceKind"];
  let marketDiagnostics: HistoricalMarketSourceDiagnostics | null = null;
  if (authoritativeHistory.matched) {
    if (!prices || prices.length === 0) {
      logWorkerEventArgs("api", "warn",
        `[backfill-depegs] authoritative historical price source unavailable for ${meta.symbol}` +
          `${authoritativeHistory.source ? ` (${authoritativeHistory.source})` : ""}; preserving existing backfill rows`,
      );
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: authoritativeHistory.source,
        marketDiagnostics: null,
      };
    }
    sourceKind = "authoritative";
  } else {
    const nativeSeries = nativePegCurrency ? await loadMarketSeries("native-peg") : null;
    const series =
      nativeSeries && nativeSeries.prices && nativeSeries.prices.length > 0
        ? nativeSeries
        : await loadMarketSeries("usd");
    prices = series.prices;
    marketDiagnostics = series.diagnostics;
    if (!prices || prices.length === 0) {
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: null,
        marketDiagnostics,
      };
    }
    sourceKind = "market";
  }

  if (prices && replayWindow) {
    prices = prices.filter((point) => timestampInReplayWindow(point.timestamp, replayWindow));
  }

  const extractedEvents = extractDepegEvents(
    prices,
    marketDiagnostics?.quoteMode === "native-peg" ? (() => 1) : getPegRef,
    pegType,
    supplyByDate,
    fxRates,
    buildPriceReasonablenessOptions({
      navToken: meta.flags.navToken,
      commodityOunces: meta.commodityOunces,
    }),
    marketDiagnostics?.quoteMode === "native-peg"
      ? {
          forceConfirmation: true,
          confirmationMinPoints: BACKFILL_MIN_CONFIRM_POINTS,
          confirmationMaxGapSec: BACKFILL_NATIVE_PEG_PENDING_MAX_GAP_SEC,
          extremeSinglePointBps: BACKFILL_NATIVE_PEG_EXTREME_SINGLE_POINT_BPS,
          missingSupplyUsd,
        }
      : { missingSupplyUsd },
  );

  return {
    events: replayWindow
      ? extractedEvents.filter((event) => eventOverlapsReplayWindow(event, replayWindow))
      : extractedEvents,
    sourceKind,
    authoritativeSource: authoritativeHistory.matched ? authoritativeHistory.source : null,
    marketDiagnostics,
  };
}
