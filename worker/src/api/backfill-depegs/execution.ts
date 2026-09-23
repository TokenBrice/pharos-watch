import { getPegReference } from "@shared/lib/peg-rates";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { findBackfillReplaySuppression } from "@shared/data/depegs/backfill-replay-suppressions";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  buildFxLookup,
} from "../../lib/backfill-fx";
import { logWorkerEvent } from "../../lib/structured-log";
import { backfillEpisodeCoveredByLiveEvent, type BackfillReplayWindow } from "../backfill-depegs-window";
import {
  buildBackfillReplayPreview,
  loadExistingReplayRows,
  type BackfillReplayPreview,
  type ExistingDepegEventRow,
} from "../backfill-depegs-preview";
import { backfillCoin } from "../backfill-depegs-replay";
import type { BackfillEvent } from "../backfill-depegs-extraction";
import type { PreparedBackfillCoin } from "./planning";
import {
  type BackfillEventProvenanceInput,
  type BackfillRunInput,
  type PersistedBackfillEvent,
  buildBackfillEventsFingerprint,
  buildReplayRunId,
  inferBackfillConfidence,
} from "./persistence";

const BACKFILL_REPLAY_VERSION = "depeg-backfill-v6.1";

/**
 * Apply-callback signature: implemented by the entrypoint so this module
 * stays free of the lower-level D1 mutation helpers in backfill-depegs.ts.
 */
export type ApplyBackfillEventsFn = (
  meta: { id: string; symbol: string },
  events: PersistedBackfillEvent[],
  replayWindow: BackfillReplayWindow | null,
  run: BackfillRunInput,
) => Promise<void>;

export interface CoinExecutionOutcome {
  status: "applied" | "preview" | "skipped" | "error";
  eventCount: number;
  reason?: "missing-fx-reference";
  preview?: BackfillReplayPreview;
  errorMessage?: string;
}

/**
 * Drops recomputed episodes that reviewed data or an existing live row already
 * covers, so a replay can never re-persist them:
 * - a reviewed replay-suppression window (price-feed artifact verdict), and
 * - a `source='live'` row for the same coin and direction whose interval
 *   overlaps the episode (the same market episode detected by both lanes).
 */
function skipCoveredBackfillEpisodes(
  meta: { id: string; symbol: string },
  events: BackfillEvent[],
  liveRows: ExistingDepegEventRow[],
): BackfillEvent[] {
  const kept: BackfillEvent[] = [];
  for (const event of events) {
    const suppression = findBackfillReplaySuppression(meta.id, event.direction, event);
    if (suppression) {
      logWorkerEvent({
        scope: "api",
        level: "info",
        event: "backfill-depegs-episode-skipped",
        message: `[backfill-depegs] ${meta.symbol}: recomputed ${event.direction} episode falls in a reviewed suppression window (${suppression.reason})`,
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          skipReason: "reviewed-suppression",
          episodeStartedAt: event.startedAt,
          episodeEndedAt: event.endedAt,
          suppressionWindowStart: suppression.windowStart,
          suppressionWindowEnd: suppression.windowEnd,
          reviewedAt: suppression.reviewedAt,
        },
      });
      continue;
    }
    const coveringLiveRow = liveRows.find((row) => backfillEpisodeCoveredByLiveEvent(event, row));
    if (coveringLiveRow) {
      logWorkerEvent({
        scope: "api",
        level: "info",
        event: "backfill-depegs-episode-skipped",
        message: `[backfill-depegs] ${meta.symbol}: recomputed ${event.direction} episode is already covered by live event ${coveringLiveRow.id}`,
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          skipReason: "live-overlap",
          episodeStartedAt: event.startedAt,
          episodeEndedAt: event.endedAt,
          liveEventId: coveringLiveRow.id,
        },
      });
      continue;
    }
    kept.push(event);
  }
  return kept;
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
    const currentReference =
      currentPegRef != null && Number.isFinite(currentPegRef) && currentPegRef > 0
        ? currentPegRef
        : null;
    const seriesAnchor = series.length > 0 ? series[0]?.rate : undefined;
    const fallback =
      currentReference ??
      (typeof seriesAnchor === "number" && Number.isFinite(seriesAnchor) && seriesAnchor > 0
        ? seriesAnchor
        : null);
    if (fallback == null) {
      logWorkerEvent({
        scope: "api",
        level: "warn",
        event: "backfill-depegs-coin-skipped",
        status: "skipped",
        message: `[backfill-depegs] Skipping ${meta.symbol}: no commodity reference is available`,
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          pegCurrency: peg,
          reason: "missing-fx-reference",
        },
      });
      return { status: "skipped", eventCount: 0, reason: "missing-fx-reference" };
    }
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
          : null;
    // When a historical series exists, out-of-range timestamps fall back to its
    // earliest observed rate — a real measurement for this currency rather than an
    // invented one.
    const seriesAnchor = series.length > 0 ? series[0]?.rate : undefined;
    const resolvedFallback =
      fallback ?? (typeof seriesAnchor === "number" && seriesAnchor > 0 ? seriesAnchor : null);
    if (resolvedFallback == null) {
      logWorkerEvent({
        scope: "api",
        level: "warn",
        event: "backfill-depegs-coin-skipped",
        status: "skipped",
        message: `[backfill-depegs] Skipping ${meta.symbol}: no FX reference is available`,
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          pegCurrency: peg,
          reason: "missing-fx-reference",
        },
      });
      return { status: "skipped", eventCount: 0, reason: "missing-fx-reference" };
    }
    getPegRef = buildFxLookup(series, resolvedFallback);
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
    const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
    // Reviewed skip decisions run before the preview and the apply call so the
    // dry-run diff, the run fingerprint, and the inserted rows all agree.
    const events = replay.events === null
      ? null
      : skipCoveredBackfillEpisodes(meta, replay.events, existingRows.existingLiveRows);

    if (dryRun) {
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
