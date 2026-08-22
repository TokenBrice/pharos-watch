import { getPegReference } from "@shared/lib/peg-rates";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import type { D1Database } from "@cloudflare/workers-types";
import { RUB_FALLBACK } from "../../lib/constants";
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  buildFxLookup,
} from "../../lib/backfill-fx";
import type { BackfillReplayWindow } from "../backfill-depegs-window";
import {
  buildBackfillReplayPreview,
  loadExistingReplayRows,
  type BackfillReplayPreview,
} from "../backfill-depegs-preview";
import { backfillCoin } from "../backfill-depegs-replay";
import type { PreparedBackfillCoin } from "./planning";
import {
  type BackfillEventProvenanceInput,
  buildBackfillEventsFingerprint,
  buildReplayRunId,
  inferBackfillConfidence,
} from "./persistence";

const BACKFILL_REPLAY_VERSION = "depeg-backfill-v6.0";

/**
 * Apply-callback signature: implemented by the entrypoint so this module
 * stays free of the lower-level D1 mutation helpers in backfill-depegs.ts.
 */
export type ApplyBackfillEventsFn = (
  meta: { id: string; symbol: string },
  events: Array<{
    pegType: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
    startPrice: number;
    peakPrice: number;
    recoveryPrice: number | null;
    pegRef: number;
    provenance?: BackfillEventProvenanceInput;
  }>,
  replayWindow: BackfillReplayWindow | null,
  run: {
    runId: string;
    sourceType: "market" | "authoritative";
    expectedFingerprint: string;
    expectedEventCount: number;
    removedCount: number;
    addedCount: number;
    replayWindow: BackfillReplayWindow | null;
  },
) => Promise<void>;

export interface CoinExecutionOutcome {
  status: "applied" | "preview" | "skipped" | "error";
  eventCount: number;
  preview?: BackfillReplayPreview;
  errorMessage?: string;
}

export async function executeBackfillForCoin(opts: {
  db: D1Database;
  prepared: PreparedBackfillCoin;
  pegRates: Record<string, number>;
  fxRates: Record<string, number> | undefined;
  fxSeries: Record<string, FxTimeSeries[]>;
  commoditySeries: Record<string, FxTimeSeries[]>;
  replayWindow: BackfillReplayWindow | null;
  coingeckoApiKey: string | null;
  dryRun: boolean;
  applyBackfillEvents: ApplyBackfillEventsFn;
}): Promise<CoinExecutionOutcome> {
  const {
    db,
    prepared,
    pegRates,
    fxRates,
    fxSeries,
    commoditySeries,
    replayWindow,
    coingeckoApiKey,
    dryRun,
    applyBackfillEvents,
  } = opts;
  const { meta, geckoId, supplyByDate, currentSupplyUsd } = prepared;

  if (!geckoId) {
    return { status: "skipped", eventCount: 0 };
  }

  // Build time-varying peg reference function for this coin
  const peg = meta.flags.pegCurrency;
  const pegType = `pegged${peg}`;
  const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
  let getPegRef: (timestamp: number) => number;

  if (peg === "USD") {
    getPegRef = () => 1;
  } else if (isCommodityPeg(peg)) {
    // Commodity peg (gold/silver): use historical spot price series
    const series = commoditySeries[peg] ?? [];
    const fallback = currentPegRef != null && currentPegRef > 0 ? currentPegRef : 1;
    const spotLookup = buildFxLookup(series, fallback);
    if (meta.commodityOunces && meta.commodityOunces > 0) {
      const oz = meta.commodityOunces;
      getPegRef = (ts) => spotLookup(ts) * oz;
    } else {
      getPegRef = spotLookup;
    }
  } else {
    const fxCode = PEG_TO_FX[peg] ?? SECONDARY_PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
    const series = fxCode ? (fxSeries[fxCode] ?? []) : [];
    const fallbackRate = fxRates?.[pegType];
    const fallback =
      typeof fallbackRate === "number" && fallbackRate > 0
        ? fallbackRate
        : currentPegRef != null && currentPegRef > 0
          ? currentPegRef
          : peg === "RUB"
            ? RUB_FALLBACK
            : 1;
    const fxLookup = buildFxLookup(series, fallback);
    getPegRef = fxLookup;
  }

  try {
    const replay = await backfillCoin({
      meta,
      geckoId,
      getPegRef,
      supplyByDate,
      fxRates,
      replayWindow,
      coingeckoApiKey: coingeckoApiKey ?? null,
      missingSupplyUsd: currentSupplyUsd,
    });
    const events = replay.events;

    if (dryRun) {
      const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
      const preview = buildBackfillReplayPreview({
        meta,
        sourceKind: replay.sourceKind,
        authoritativeSource: replay.authoritativeSource,
        marketDiagnostics: replay.marketDiagnostics,
        existingRows,
        events,
      });
      if (events === null) {
        return { status: "skipped", eventCount: 0, preview };
      }
      return { status: "preview", eventCount: events.length, preview };
    }

    // null = no trusted historical source available -> preserve existing rows
    if (events === null) {
      return { status: "skipped", eventCount: 0 };
    }

    // Only replace backfill-sourced events; preserve live-cron-detected events
    // (live cron catches brief intraday depegs that daily backfill data misses).
    const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
    const preview = buildBackfillReplayPreview({
      meta,
      sourceKind: replay.sourceKind,
      authoritativeSource: replay.authoritativeSource,
      marketDiagnostics: replay.marketDiagnostics,
      existingRows,
      events,
    });
    const runId = buildReplayRunId(meta.id);
    const sourceKind = replay.sourceKind === "authoritative" ? "authoritative" : "market";
    const sourceProviders = sourceKind === "authoritative"
      ? [replay.authoritativeSource ?? "authoritative"]
      : replay.marketDiagnostics?.sourcesUsed ?? [];
    const quoteMode = replay.marketDiagnostics?.quoteMode ?? (meta.flags.pegCurrency === "USD" ? "usd" : null);
    const confidenceTier = inferBackfillConfidence({
      sourceKind,
      quoteMode,
      sourceCount: sourceProviders.length,
      policyAdjustmentCount: replay.marketDiagnostics?.policyAdjustments.length ?? 0,
    });
    const provenance: BackfillEventProvenanceInput = {
      replayRunId: runId,
      replayVersion: BACKFILL_REPLAY_VERSION,
      sourceKind,
      sourcePriceProviders: sourceProviders,
      quoteMode,
      pegReferenceSource: quoteMode === "native-peg"
        ? "native-peg-history"
        : meta.flags.pegCurrency === "USD"
          ? "fixed-usd"
          : "historical-fx-or-current-fallback",
      supplySource: supplyByDate.length > 0 ? "defillama-history" : "stablecoins-cache-current",
      confirmationPolicy: quoteMode === "native-peg" ? "two-point-36h-or-extreme" : "threshold-crossing",
      confirmationPointCount: quoteMode === "native-peg" ? 2 : 1,
      marketDiagnostics: replay.marketDiagnostics ? {
        sourcesUsed: replay.marketDiagnostics.sourcesUsed,
        mergeReasons: replay.marketDiagnostics.mergeReasons,
        quoteMode: replay.marketDiagnostics.quoteMode,
        quoteCurrency: replay.marketDiagnostics.quoteCurrency,
      } : null,
      policyAdjustments: replay.marketDiagnostics?.policyAdjustments ?? [],
      confidenceTier,
      auditVerdict: events.length > 0 ? "confirmed" : "no_data",
    };
    const replayEvents = events.map((e) => ({
      pegType: e.pegType,
      direction: e.direction,
      peakDeviationBps: e.peakDeviationBps,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      startPrice: e.startPrice,
      peakPrice: e.peakPrice,
      recoveryPrice: e.recoveryPrice,
      pegRef: e.pegRef,
      provenance,
    }));
    await applyBackfillEvents({ id: meta.id, symbol: meta.symbol }, replayEvents, replayWindow, {
      runId,
      sourceType: sourceKind,
      expectedEventCount: events.length,
      expectedFingerprint: buildBackfillEventsFingerprint(replayEvents),
      removedCount: preview.removedBackfillEventCount,
      addedCount: preview.addedBackfillEventCount,
      replayWindow,
    });
    return { status: "applied", eventCount: events.length, preview };
  } catch (err) {
    return { status: "error", eventCount: 0, errorMessage: `${meta.symbol}: ${err}` };
  }
}

