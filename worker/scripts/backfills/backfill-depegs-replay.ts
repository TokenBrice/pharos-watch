import { logWorkerEventArgs } from "../../src/lib/structured-log";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { getReferenceMarket, isReferenceMarketClosed } from "@shared/lib/reference-market-hours";
import { buildPriceReasonablenessOptions } from "../../src/lib/price-validation";
import { fetchAuthoritativeHistoricalPriceSeries } from "../../src/lib/authoritative-price-sources";
import { normalizeSupportedPegCurrency } from "../../src/lib/native-peg-quotes";
import {
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPriceSeries,
  isAdmittedHistoricalNativeQuote,
  type HistoricalMarketSourceDiagnostics,
} from "../../src/lib/historical-market-prices";
import {
  BACKFILL_MIN_CONFIRM_POINTS,
  extractDepegEvents,
  type BackfillEvent,
  type SupplySnapshot,
} from "../../src/lib/historical-depeg-extraction";
import { eventOverlapsReplayWindow, timestampInReplayWindow } from "./backfill-depegs-window";
import type { BackfillReplayWindow } from "../../src/lib/backfill-day-window";

const BACKFILL_NATIVE_PEG_EXTREME_SINGLE_POINT_BPS = 5000;
export const HOURLY_REPLAY_MAX_GAP_SEC = 2 * HOUR_SECONDS;

export interface BackfillCoinReplayResult {
  events: BackfillEvent[] | null;
  sourceKind: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketDiagnostics: HistoricalMarketSourceDiagnostics | null;
  maxObservationGapSec?: number;
  assessed?: { timestamp: number; state: string | null; severeClosure?: true }[];
  degradedReason?: "missing-historical-supply" | "no-admitted-observations" | "no-admitted-observations-in-comparison-window"
    | "unclocked-reference" | "unclocked-native-quote" | "no-historical-prices";
}

export async function backfillCoin(opts: {
  meta: StablecoinMeta;
  geckoId: string;
  getPegRef: (timestamp: number) => number | null;
  supplyByDate: SupplySnapshot[];
  admitUsdReference?: (timestamp: number, rawBps: number) => boolean;
  replayWindow?: BackfillReplayWindow | null;
  coingeckoApiKey?: string | null;
}): Promise<BackfillCoinReplayResult> {
  const {
    meta,
    geckoId,
    getPegRef,
    supplyByDate,
    admitUsdReference,
    replayWindow,
    coingeckoApiKey,
  } = opts;
  const pegType = `pegged${meta.flags.pegCurrency}`;
  const nativePegCurrency = normalizeSupportedPegCurrency(meta.flags.pegCurrency);
  const candidateSupplySnapshots = replayWindow
    ? supplyByDate.filter((snapshot) => timestampInReplayWindow(snapshot.ts, replayWindow))
    : supplyByDate;
  if (!supplyByDate.some(({ supply }) => supply != null)) {
    logWorkerEventArgs("api", "warn",
      `[backfill-depegs] no historical supply floor available for ${meta.symbol}; preserving existing backfill rows`,
    );
    return {
      events: null,
      sourceKind: "preserve-existing",
      authoritativeSource: null,
      marketDiagnostics: null,
      degradedReason: "missing-historical-supply",
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
      granularity: "hourly",
      requireIntraday: quoteMode === "native-peg",
      range: replayWindow
        ? {
            startSec: replayWindow.replayStartSec,
            endSec: Math.min(replayWindow.replayEndSec ?? Infinity, Math.floor(Date.now() / 1000)),
          }
        : undefined,
      quote: {
        pegCurrency: meta.flags.pegCurrency,
        useNativePegQuote: quoteMode === "native-peg",
        requireExactUnit: true,
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
    supplySnapshots: supplyByDate.filter((snapshot): snapshot is { ts: number; supply: number } => snapshot.supply != null),
    coingeckoApiKey: coingeckoApiKey ?? null,
  });

  let prices = authoritativeHistory.prices;
  let sourceKind: BackfillCoinReplayResult["sourceKind"];
  let marketDiagnostics: HistoricalMarketSourceDiagnostics | null = null;
  if (authoritativeHistory.matched) {
    if (!isObservedPrice({ priceSource: authoritativeHistory.source }) || !prices || prices.length === 0) {
      logWorkerEventArgs("api", "warn",
        `[backfill-depegs] authoritative historical price source unavailable for ${meta.symbol}` +
          `${authoritativeHistory.source ? ` (${authoritativeHistory.source})` : ""}; preserving existing backfill rows`,
      );
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: authoritativeHistory.source,
        marketDiagnostics: null,
        degradedReason: "no-historical-prices",
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
        degradedReason: "no-historical-prices",
      };
    }
    sourceKind = "market";
  }

  if (prices && replayWindow) {
    prices = prices.filter((point) => timestampInReplayWindow(point.timestamp, replayWindow));
  }

  const quoteMode = marketDiagnostics?.quoteMode ?? "usd";
  const referenceMarket = getReferenceMarket(meta.flags.pegCurrency);
  if (quoteMode === "usd" && meta.flags.pegCurrency !== "USD" && referenceMarket !== "metal") {
    return {
      events: null,
      sourceKind: "preserve-existing",
      authoritativeSource: authoritativeHistory.source,
      marketDiagnostics,
      degradedReason: "unclocked-reference",
    };
  }
  const admittedNativeClocks = quoteMode === "native-peg" ? new Set(prices
    .filter((point) => marketDiagnostics?.quoteCurrency.toUpperCase() === meta.flags.pegCurrency
      && isAdmittedHistoricalNativeQuote(point, meta.flags.pegCurrency))
    .map((point) => point.timestamp)) : null;
  if (admittedNativeClocks?.size === 0) {
    return { events: null, sourceKind: "preserve-existing", authoritativeSource: null,
      marketDiagnostics, degradedReason: "unclocked-native-quote" };
  }
  // DefiLlama's chart leg requests period=1d. A merged or unidentified series
  // cannot use the daily budget because it may contain sparse hourly quotes.
  const dailyOnly = marketDiagnostics?.granularity === "daily" ||
    (marketDiagnostics?.sourcesUsed.length === 1 && marketDiagnostics.sourcesUsed[0] === "defillama");
  const maxGapSec = quoteMode === "usd" && referenceMarket == null && dailyOnly
    ? DAY_SECONDS + HOURLY_REPLAY_MAX_GAP_SEC : HOURLY_REPLAY_MAX_GAP_SEC;
  const assessed: NonNullable<BackfillCoinReplayResult["assessed"]> = [];
  let admitted = false;
  let admittedInComparison = false;
  const extractedEvents = extractDepegEvents(
    prices,
    marketDiagnostics?.quoteMode === "native-peg" ? (() => 1) : getPegRef,
    pegType,
    supplyByDate,
    quoteMode === "usd" && referenceMarket != null ? {} : undefined,
    buildPriceReasonablenessOptions({
      navToken: meta.flags.navToken,
      commodityOunces: meta.commodityOunces,
    }),
    {
      ...(quoteMode === "native-peg" ? {
          forceConfirmation: true,
          confirmationMinPoints: BACKFILL_MIN_CONFIRM_POINTS,
          extremeSinglePointBps: BACKFILL_NATIVE_PEG_EXTREME_SINGLE_POINT_BPS,
          admitReference: (timestamp: number) => admittedNativeClocks?.has(timestamp) === true
            && !isReferenceMarketClosed(referenceMarket, timestamp),
        } : { admitReference: admitUsdReference }),
      quoteDomain: quoteMode,
      confirmationMaxGapSec: maxGapSec,
      maxObservationGapSec: maxGapSec,
      onEvaluated(timestamp, state, severeClosure) {
        assessed.push({ timestamp, state, ...(severeClosure ? { severeClosure: true } : {}) });
        if (state != null) {
          admitted = true;
          if ((replayWindow?.compareStartSec == null || timestamp >= replayWindow.compareStartSec)
            && (replayWindow?.compareEndSec == null || timestamp <= replayWindow.compareEndSec)) admittedInComparison = true;
        }
      },
    },
  );

  if (!admittedInComparison) {
    return {
      events: null,
      sourceKind: "preserve-existing",
      authoritativeSource: authoritativeHistory.source,
      marketDiagnostics,
      degradedReason: admitted ? "no-admitted-observations-in-comparison-window" : "no-admitted-observations",
    };
  }
  return {
    events: replayWindow
      ? extractedEvents.filter((event) => eventOverlapsReplayWindow(event, replayWindow))
      : extractedEvents,
    sourceKind,
    authoritativeSource: authoritativeHistory.matched ? authoritativeHistory.source : null,
    marketDiagnostics,
    assessed,
    maxObservationGapSec: maxGapSec,
  };
}
