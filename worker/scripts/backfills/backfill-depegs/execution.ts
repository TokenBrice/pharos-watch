import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { getPegReference } from "@shared/lib/peg-rates";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { findBackfillReplaySuppression } from "@shared/data/depegs/backfill-replay-suppressions";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type FxTimeSeries,
  type HistoricalCommoditySources,
  buildHistoricalReferenceLookup,
  findHistoricalFxValuationRate,

} from "../../../src/lib/backfill-fx";
import { logWorkerEvent } from "../../../src/lib/structured-log";
import { backfillEpisodeCoveredByLiveEvent } from "../backfill-depegs-window";
import type { BackfillReplayWindow } from "../../../src/lib/backfill-day-window";
import {
  buildBackfillReplayPreview,
  loadExistingReplayRows,
  type BackfillReplayPreview,
  type ExistingDepegEventRow,
} from "../backfill-depegs-preview";
import { backfillCoin, HOURLY_REPLAY_MAX_GAP_SEC } from "../backfill-depegs-replay";
import { parseSupplyData, type BackfillEvent } from "../../../src/lib/historical-depeg-extraction";
import type { PreparedBackfillCoin } from "./planning";
import {
  type BackfillEventProvenanceInput,
  type BackfillRunInput,
  type PersistedBackfillEvent,
  buildBackfillEventsFingerprint,
  buildReplayRunId,
  inferBackfillConfidence,
} from "./persistence";

const BACKFILL_REPLAY_VERSION = "depeg-backfill-v6.2";

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
  reason?: string;
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
  retainedRows: ExistingDepegEventRow[],
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
    const coveringRow = retainedRows.find((row) => backfillEpisodeCoveredByLiveEvent(event, row));
    if (coveringRow) {
      logWorkerEvent({
        scope: "api",
        level: "info",
        event: "backfill-depegs-episode-skipped",
        message: `[backfill-depegs] ${meta.symbol}: recomputed ${event.direction} episode is already covered by retained event ${coveringRow.id}`,
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          skipReason: "retained-overlap",
          episodeStartedAt: event.startedAt,
          episodeEndedAt: event.endedAt,
          retainedEventId: coveringRow.id,
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
  fxSeries: Record<string, FxTimeSeries[]>;
  commodityPeers: HistoricalCommoditySources;
  replayWindow: BackfillReplayWindow | null;
  coingeckoApiKey: string | null;
  dryRun: boolean;
  applyBackfillEvents: ApplyBackfillEventsFn;
}): Promise<CoinExecutionOutcome> {
  const {
    db,
    prepared,
    fxSeries,
    commodityPeers,
    replayWindow,
    coingeckoApiKey,
    dryRun,
    applyBackfillEvents,
  } = opts;
  const { meta, geckoId } = prepared;

  if (!geckoId) {
    return { status: "skipped", eventCount: 0, reason: "coin-history-id-unavailable" };
  }

  const peg = meta.flags.pegCurrency;
  if (meta.id === "axcnh-anchorx") {
    return { status: "skipped", eventCount: 0, reason: "unclocked-cnh-reference" };
  }
  const pegType = `pegged${peg}`;
  const lookup = buildHistoricalReferenceLookup({ subjectId: meta.id, commodityPeers });
  const commodity = isCommodityPeg(peg);
  const getPegRef = (timestamp: number): number | null => {
    if (peg === "USD") return 1;
    const reference = lookup.referenceAt(peg, timestamp);
    return reference == null ? null : getPegReference(pegType, { [pegType]: reference.usdPerUnit }, meta.commodityOunces, {
      assetId: meta.id, quoteObservedAtSec: timestamp, commodityEntitlement: lookup.entitlementAt?.(meta.id, timestamp),
    });
  };
  const supplyByDate = parseSupplyData(prepared.supplyTokens, (atSec) =>
    peg === "USD" || commodity ? getPegRef(atSec) : findHistoricalFxValuationRate(fxSeries, peg, meta.id, atSec));

  const admitUsdReference = commodity ? (timestamp: number, rawBps: number): boolean => {
    const reference = lookup.referenceAt(peg, timestamp);
    if (reference?.kind !== "median") return false;
    return evaluateReferenceAdmission({
      kind: "median",
      pegKey: pegType,
      contributors: reference.contributorEvidence ?? [],
      quoteObservedAtSec: timestamp,
      decisionAtSec: timestamp,
      rawDeviationBps: asRawDeviationBps(rawBps),
      purpose: "detection",
    }).status === "admitted";
  } : undefined;

  try {
    const replay = await backfillCoin({
      meta,
      geckoId,
      getPegRef,
      supplyByDate,
      admitUsdReference,
      replayWindow,
      coingeckoApiKey: coingeckoApiKey ?? null,
    });
    const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
    const assessed = replay.assessed ?? [];
    const observationIndexes = new Map(assessed.map(({ timestamp }, index) => [timestamp, index]));
    const market = getReferenceMarket(peg);
    const sessions = assessed.map(({ timestamp }) => market ? getReferenceSessionState(market, timestamp) : null);
    const adjacent = (a: number, b: number, maxGapSec = HOURLY_REPLAY_MAX_GAP_SEC): boolean => {
      const left = assessed[a];
      const right = assessed[b];
      if (left?.state == null || right?.state == null || right.timestamp <= left.timestamp
        || right.timestamp - left.timestamp > maxGapSec) return false;
      const after = sessions[b];
      return after == null || after.open && left.timestamp >= after.sessionOpenedAtSec;
    };
    const hasEvidenceThrough = ({ started_at: start, ended_at: end }: ExistingDepegEventRow): boolean => {
      if (end == null) return false;
      const inside = assessed.findIndex(({ timestamp }) => timestamp >= start);
      if (inside < 1 || assessed[inside]!.timestamp >= end) return false;
      let left = inside - 1;
      let right = inside;
      while (left > 0 && assessed[left]?.state !== "in-band" && adjacent(left - 1, left)) left--;
      while (right < assessed.length - 1 && !(assessed[right]!.timestamp >= end && assessed[right]!.state === "in-band")
        && adjacent(right, right + 1)) right++;
      return assessed[left]?.state === "in-band" && adjacent(inside - 1, inside)
        && assessed[right]?.state === "in-band" && assessed[right]!.timestamp >= end;
    };
    const replaceIds = new Set(existingRows.existingBackfillRows.map(({ id }) => id));
    const retained = existingRows.allRows.filter(({ id }) => !replaceIds.has(id));
    const candidates = replay.events == null ? null : skipCoveredBackfillEpisodes(meta, replay.events, retained);
    // Inserting a closed episode may use its source cadence. Replacing history requires hourly proof.
    const onsetMaxGap = replaceIds.size === 0 ? replay.maxObservationGapSec : HOURLY_REPLAY_MAX_GAP_SEC;
    const unsafeReplacement = existingRows.existingBackfillRows.some((row) => !hasEvidenceThrough(row))
      || candidates?.some((event) => {
        const onset = observationIndexes.get(event.startedAt) ?? 0;
        return event.endedAt == null || !adjacent(onset - 1, onset, onsetMaxGap)
          || assessed[onset - 1]?.state === event.direction;
      });
    const degradedReason = replay.degradedReason ?? (unsafeReplacement ? "insufficient-boundary-evidence" : null);
    const events = unsafeReplacement ? null : candidates;

    if (dryRun) {
      const preview = buildBackfillReplayPreview({
        meta,
        sourceKind: events === null ? "preserve-existing" : replay.sourceKind,
        degradedReason,
        authoritativeSource: replay.authoritativeSource,
        marketDiagnostics: replay.marketDiagnostics,
        existingRows,
        events,
      });
      if (events === null) {
        return { status: "skipped", eventCount: 0, preview, reason: degradedReason ?? undefined };
      }
      return { status: "preview", eventCount: events.length, preview };
    }

    // null = no trusted historical source available -> preserve existing rows
    if (events === null) {
      return { status: "skipped", eventCount: 0, reason: degradedReason ?? undefined };
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
    const quoteMode = replay.marketDiagnostics?.quoteMode ?? "usd";
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
          : "historical-peer-median",
      supplySource: "defillama-history",
      confirmationPolicy: quoteMode === "native-peg" ? "two-point-intraday-or-extreme" : "threshold-crossing",
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
    const replayEvents = events.map((event) => {
      if (!commodity) return { ...event, provenance };
      const referenceEvidence = {
        start: lookup.referenceAt(peg, event.startedAt),
        peak: event.peakObservedAt == null ? null : lookup.referenceAt(peg, event.peakObservedAt),
        recovery: event.recoveryPrice == null || event.endedAt == null ? null : lookup.referenceAt(peg, event.endedAt),
      };
      return { ...event, provenance: {
        ...provenance,
        marketDiagnostics: { ...provenance.marketDiagnostics, referenceEvidence },
      } };
    });
    await applyBackfillEvents({ id: meta.id, symbol: meta.symbol }, replayEvents, replayWindow, {
      runId,
      sourceType: sourceKind,
      expectedEventCount: events.length,
      expectedFingerprint: buildBackfillEventsFingerprint(replayEvents),
      removedCount: preview.removedBackfillEventCount,
      addedCount: preview.addedBackfillEventCount,
      replayWindow,
      replacePreimages: existingRows.existingBackfillRows.map(({ id, replay_preimage }) => ({ id, preimage: replay_preimage! })),
    });
    return { status: "applied", eventCount: events.length, preview };
  } catch (err) {
    return { status: "error", eventCount: 0, errorMessage: `${meta.symbol}: ${err}` };
  }
}
