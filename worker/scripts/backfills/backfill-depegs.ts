import { logWorkerEvent, logWorkerEventArgs } from "../../src/lib/structured-log";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { jsonResponse } from "../../src/lib/api-response";
import { serializeDepegPriceCoverage } from "../../src/lib/depeg-helpers";
import { selectBackfillCoins } from "../../src/lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse } from "../../src/lib/admin-job";
import type { D1Database } from "@cloudflare/workers-types";
import { toErrorMessage } from "@shared/lib/error-utils";
import { buildBackfillDeleteStmt, buildReplayPreimageGuard, loadDdrBackfillReplayConflicts, loadIncompleteBackfillReplayWindow } from "./backfill-depegs-window";
import { parseOptionalDayWindow } from "../../src/lib/backfill-day-window";
import type { BackfillReplayWindow } from "../../src/lib/backfill-day-window";
import type { BackfillReplayPreview } from "./backfill-depegs-preview";
import type {
  BackfillApplyResult,
  BackfillEventProvenanceInput,
  BackfillRunInput,
  PersistedBackfillEvent,
} from "./backfill-depegs/persistence";
import { buildBackfillPlan } from "./backfill-depegs/planning";
import { executeBackfillForCoin } from "./backfill-depegs/execution";
import {
  buildBackfillEventsFingerprint,
  buildInsertProvenanceStmt,
  buildUpsertBackfillRunStmt,
} from "./backfill-depegs/persistence";

const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;

export { buildBackfillEventsFingerprint };

export async function applyBackfillEvents(
  db: D1Database,
  meta: { id: string; symbol: string },
  events: PersistedBackfillEvent[],
  replayWindow: BackfillReplayWindow | null,
  run?: BackfillRunInput,
): Promise<BackfillApplyResult> {
  const ddrConflicts = await loadDdrBackfillReplayConflicts(db, meta.id, replayWindow);
  const sealedConflicts = ddrConflicts.filter((conflict) => conflict.publicPredictionId != null);
  const formatConflicts = (conflicts: typeof ddrConflicts) => conflicts
    .map((conflict) => `event ${conflict.eventId} / ${conflict.incidentKey}`)
    .join(", ");
  if (sealedConflicts.length > 0) {
    throw new Error(
      `DDRv2 sealed repair required: backfill replay for ${meta.symbol} would delete sealed depeg_events (${formatConflicts(sealedConflicts)}). ` +
        "This endpoint does not consume append-only repair authorizations, lineage, or errata; use a dedicated DDRv2 repair endpoint before replaying this window.",
    );
  }
  if (ddrConflicts.length > 0) {
    throw new Error(
      `DDR incident member replay refused: backfill replay for ${meta.symbol} would delete incident member depeg_events (${formatConflicts(ddrConflicts)}). ` +
        "Incident event links are append-only, so the delete would leave dangling incident references and fail /api/depeg-events closed; narrow the replay window to exclude them.",
    );
  }

  const preimages = run?.replacePreimages;
  const deleteStmt = buildBackfillDeleteStmt(db, meta.id, replayWindow, preimages?.map(({ id }) => id));
  const nowSec = Math.floor(Date.now() / 1000);
  if (run) {
    await buildUpsertBackfillRunStmt(db, meta, run, "started", nowSec, 0, null).run();
  }
  let insertedCount = 0;
  try {
    const insertStmts = events.map((e) => {
      const lastTrusted = e.endedAt ?? e.admittedCoverage?.[e.admittedCoverage.length - 1]?.toSec ?? e.startedAt;
      const priceCoverage = e.admittedCoverage == null ? null : serializeDepegPriceCoverage({
        intervals: e.admittedCoverage[0]?.fromSec === e.startedAt
          ? e.admittedCoverage.map(({ fromSec, toSec }) => [fromSec, toSec])
          : [[e.startedAt, e.startedAt], ...e.admittedCoverage.map(({ fromSec, toSec }): [number, number] => [fromSec, toSec])],
        atParIntervals: e.recoveryPrice != null && e.endedAt != null ? [[e.endedAt, e.endedAt]] : [],
        lastObservationKind: e.recoveryPrice != null ? "trusted-at-par" : "trusted-off-peg",
        lastTrustedObservationAt: lastTrusted,
        gapStartedAt: null,
      });
      return db
        .prepare(
          `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source,
         peak_peg_reference, peak_quote_domain, recovery_peg_reference, admitted_coverage_json,
         price_coverage_json, last_trusted_price_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          meta.id,
          meta.symbol,
          e.pegType,
          e.direction,
          e.peakDeviationBps,
          e.startedAt,
          e.endedAt,
          e.startPrice,
          e.peakPrice,
          e.recoveryPrice,
          e.pegRef,
          e.peakPegReference ?? null,
          e.peakQuoteDomain ?? null,
          e.recoveryPegReference ?? null,
          e.admittedCoverage == null ? null : JSON.stringify(e.admittedCoverage),
          priceCoverage,
          priceCoverage == null ? null : lastTrusted,
        );
    });
    const provenanceStmts = events
      .filter((event): event is typeof event & { provenance: BackfillEventProvenanceInput } => event.provenance != null)
      .map((event) => buildInsertProvenanceStmt(db, meta, event, event.provenance, Math.floor(Date.now() / 1000)));
    if (preimages != null) {
      const guards = [
        buildReplayPreimageGuard(db, meta.id, preimages, events),
        deleteStmt,
        db.prepare(`INSERT INTO depeg_events (stablecoin_id) SELECT NULL WHERE EXISTS (
          SELECT 1 FROM json_each(?) expected JOIN depeg_events e ON e.id = expected.value)`)
          .bind(JSON.stringify(preimages.map(({ id }) => id))),
      ];
      const provenanceGuard = db.prepare(`INSERT INTO depeg_events (stablecoin_id) SELECT NULL WHERE
        (SELECT COUNT(*) FROM depeg_event_provenance p JOIN depeg_events e ON e.id = p.event_id
          WHERE p.replay_run_id = ? AND e.stablecoin_id = ?) != ?`)
        .bind(run?.runId ?? null, meta.id, provenanceStmts.length);
      if (guards.length + insertStmts.length + provenanceStmts.length + 1 > BATCH_CHUNK_SIZE) {
        throw new Error("Replay exceeds the atomic statement limit. Narrow the replay window.");
      }
      await db.batch([...guards, ...insertStmts, ...provenanceStmts, provenanceGuard]);
      insertedCount = insertStmts.length;
      if (run) await buildUpsertBackfillRunStmt(db, meta, run, "complete",
        Math.floor(Date.now() / 1000), insertedCount, null).run();
      return { provenanceMismatchCount: 0 };
    }
    // Direct fixture callers retain the legacy chunking path. Operator replays carry pre-images.
    const firstChunkSize = Math.min(insertStmts.length, BATCH_CHUNK_SIZE - 1);
    await db.batch([deleteStmt, ...insertStmts.slice(0, firstChunkSize)]);
    insertedCount += firstChunkSize;
    for (let i = firstChunkSize; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
      const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
      await db.batch(chunk);
      insertedCount += chunk.length;
    }
    let provenanceChanges = 0;
    for (let i = 0; i < provenanceStmts.length; i += BATCH_CHUNK_SIZE) {
      const results = await db.batch(provenanceStmts.slice(i, i + BATCH_CHUNK_SIZE));
      provenanceChanges += results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
    }
    const provenanceMismatchCount = Math.abs(provenanceStmts.length - provenanceChanges);
    if (provenanceMismatchCount > 0) {
      const mismatchError =
        `provenance writes changed ${provenanceChanges} row(s) for ${provenanceStmts.length} event(s)`;
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "backfill_depegs_provenance_mismatch",
        runId: run?.runId,
        status: "incomplete",
        message: `[backfill-depegs] ${meta.symbol}: ${mismatchError}`,
        metadata: {
          stablecoinId: meta.id,
          expectedProvenanceCount: provenanceStmts.length,
          provenanceChanges,
          provenanceMismatchCount,
        },
      });
      if (run) {
        await buildUpsertBackfillRunStmt(
          db,
          meta,
          run,
          "incomplete",
          Math.floor(Date.now() / 1000),
          insertedCount,
          mismatchError,
        ).run();
      }
      return { provenanceMismatchCount };
    }
    if (run) {
      await buildUpsertBackfillRunStmt(
        db,
        meta,
        run,
        "complete",
        Math.floor(Date.now() / 1000),
        insertedCount,
        null,
      ).run();
    }
    return { provenanceMismatchCount: 0 };
  } catch (error) {
    if (run) {
      try {
        await buildUpsertBackfillRunStmt(
          db,
          meta,
          run,
          "incomplete",
          Math.floor(Date.now() / 1000),
          insertedCount,
          toErrorMessage(error),
        ).run();
      } catch (markError) {
        logWorkerEventArgs("api", "error", `[backfill-depegs] failed to mark incomplete run ${run.runId}:`, markError);
      }
    }
    throw error;
  }
}

export interface BackfillDepegsRouteContext {
  db: D1Database;
  url: URL;
  coingeckoApiKey?: string | null;
}

async function executeBackfillDepegs(
  db: D1Database,
  url: URL,
  dryRun: boolean,
  coingeckoApiKey?: string | null,
): Promise<Response> {
  const window = parseOptionalDayWindow(url, {
    includeContextDays: true,
    includeReplayWindow: true,
  });
  if (window instanceof Response) return window;
  const replayWindow = window.replayWindow;

  const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
    defaultBatchSize: BATCH_SIZE,
    allowBatchSizeOverride: false,
  });
  if ("response" in selection) {
    return selection.response;
  }
  const coins = selection.coins;

  if (coins.length === 0) {
    return noAdminTargetsResponse();
  }

  const plan = await buildBackfillPlan({
    db,
    dryRun,
    coins,
    replayWindow,
    coingeckoApiKey: coingeckoApiKey ?? null,
  });

  let totalEvents = 0;
  let provenanceMismatchCount = 0;
  const errors: string[] = [];
  const skipped: string[] = [];
  const skipReasons: Record<string, string> = {};
  const consumeIncompleteWindow =
    !dryRun && replayWindow == null && !url.searchParams.has("stablecoin");
  const previews: BackfillReplayPreview[] = [];

  // Process coins sequentially. Each still needs CG price history fetch, so
  // serializing avoids memory pressure from parsing multiple large JSON bodies.
  for (const prepared of plan.preparedCoins) {
    const coinReplayWindow = consumeIncompleteWindow
      ? await loadIncompleteBackfillReplayWindow(db, prepared.meta.id)
      : replayWindow;
    const outcome = await executeBackfillForCoin({
      db,
      prepared,
      fxSeries: plan.fxSeries,
      commodityPeers: plan.commodityPeers,
      replayWindow: coinReplayWindow,
      coingeckoApiKey: coingeckoApiKey ?? null,
      dryRun,
      applyBackfillEvents: async (meta, events, appliedWindow, run) => {
        const result = await applyBackfillEvents(db, meta, events, appliedWindow, run);
        provenanceMismatchCount += result.provenanceMismatchCount;
      },
    });
    if (outcome.status === "skipped") {
      skipped.push(prepared.meta.symbol);
      if (outcome.reason) skipReasons[prepared.meta.id] = outcome.reason;
    } else if (outcome.status === "error") {
      errors.push(outcome.errorMessage ?? `${prepared.meta.symbol}: unknown error`);
      continue;
    }
    if (dryRun && outcome.preview) {
      previews.push(outcome.preview);
    }
    totalEvents += outcome.eventCount;
  }

  if (dryRun) {
    return jsonResponse(
      buildAdminJobSummary({
        dryRun: true,
        coinsProcessed: coins.length,
        recomputedBackfillEvents: totalEvents,
        startDay: replayWindow?.startDay ?? null,
        endDay: replayWindow?.endDay ?? null,
        contextDays: replayWindow?.contextDays ?? null,
        previews,
        skipped,
        skipReasons,
        errors,
        commodities:
          plan.commodityPegs.length > 0
            ? {
                goldDataPoints: plan.commodityPeers.GOLD?.reduce((sum, peer) => sum + peer.prices.length, 0) ?? 0,
                silverDataPoints: plan.commodityPeers.SILVER?.reduce((sum, peer) => sum + peer.prices.length, 0) ?? 0,
              }
            : undefined,
      }),
    );
  }

  return jsonResponse(
    buildAdminJobSummary({
      coinsProcessed: coins.length,
      eventsCreated: totalEvents,
      provenanceMismatchCount,
      skipped,
      skipReasons,
      errors,
      commodities:
        plan.commodityPegs.length > 0
          ? {
              goldDataPoints: plan.commodityPeers.GOLD?.reduce((sum, peer) => sum + peer.prices.length, 0) ?? 0,
              silverDataPoints: plan.commodityPeers.SILVER?.reduce((sum, peer) => sum + peer.prices.length, 0) ?? 0,
            }
          : undefined,
    }),
  );
}

export function handleBackfillDepegsTrusted({
  db,
  url,
  coingeckoApiKey,
}: BackfillDepegsRouteContext): Promise<Response> {
  return executeBackfillDepegs(db, url, url.searchParams.get("dry-run") === "true", coingeckoApiKey);
}
