import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { jsonResponse } from "../lib/api-utils";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse } from "../lib/admin-job";
import type { D1Database } from "@cloudflare/workers-types";
import { toErrorMessage } from "../lib/error-utils";
import {
  buildBackfillDeleteStmt,
  loadSealedBackfillReplayConflicts,
  parseOptionalDayWindow,
  type BackfillReplayWindow,
} from "./backfill-depegs-window";
import type { BackfillReplayPreview } from "./backfill-depegs-preview";
import { buildBackfillPlan } from "./backfill-depegs/planning";
import { executeBackfillForCoin } from "./backfill-depegs/execution";
import {
  type BackfillEventProvenanceInput,
  type BackfillRunInput,
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
  run?: BackfillRunInput,
): Promise<void> {
  const sealedConflicts = await loadSealedBackfillReplayConflicts(db, meta.id, replayWindow);
  if (sealedConflicts.length > 0) {
    const conflictList = sealedConflicts
      .map((conflict) => `event ${conflict.eventId} / ${conflict.incidentKey}`)
      .join(", ");
    throw new Error(
      `DDRv2 sealed repair required: backfill replay for ${meta.symbol} would delete sealed depeg_events (${conflictList}). ` +
        "This endpoint does not consume append-only repair authorizations, lineage, or errata; use a dedicated DDRv2 repair endpoint before replaying this window.",
    );
  }

  const deleteStmt = buildBackfillDeleteStmt(db, meta.id, replayWindow);
  const nowSec = Math.floor(Date.now() / 1000);
  if (run) {
    await buildUpsertBackfillRunStmt(db, meta, run, "started", nowSec, 0, null).run();
  }
  let insertedCount = 0;
  try {
    if (events.length === 0) {
      await db.batch([deleteStmt]);
      if (run) {
        await buildUpsertBackfillRunStmt(db, meta, run, "complete", Math.floor(Date.now() / 1000), 0, null).run();
      }
      return;
    }
    const insertStmts = events.map((e) =>
      db
        .prepare(
          `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`,
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
        ),
    );
    // First batch: delete + first chunk of inserts so partial crashes cannot leave the coin event-less.
    // D1 limits each batch to 100 statements. Reserve one slot for the delete so the first batch
    // never exceeds the limit; remaining inserts ship in full BATCH_CHUNK_SIZE (100) batches.
    const firstChunkSize = Math.min(insertStmts.length, BATCH_CHUNK_SIZE - 1);
    await db.batch([deleteStmt, ...insertStmts.slice(0, firstChunkSize)]);
    insertedCount += firstChunkSize;
    for (let i = firstChunkSize; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
      const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
      await db.batch(chunk);
      insertedCount += chunk.length;
    }
    const provenanceStmts = events
      .filter((event): event is typeof event & { provenance: BackfillEventProvenanceInput } => event.provenance != null)
      .map((event) => buildInsertProvenanceStmt(db, meta, event, event.provenance, Math.floor(Date.now() / 1000)));
    for (let i = 0; i < provenanceStmts.length; i += BATCH_CHUNK_SIZE) {
      await db.batch(provenanceStmts.slice(i, i + BATCH_CHUNK_SIZE));
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
        console.error(`[backfill-depegs] failed to mark incomplete run ${run.runId}:`, markError);
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
    coins,
    replayWindow,
    coingeckoApiKey: coingeckoApiKey ?? null,
  });

  let totalEvents = 0;
  const errors: string[] = [];
  const skipped: string[] = [];
  const previews: BackfillReplayPreview[] = [];

  // Process coins sequentially. Each still needs CG price history fetch, so
  // serializing avoids memory pressure from parsing multiple large JSON bodies.
  for (const prepared of plan.preparedCoins) {
    const outcome = await executeBackfillForCoin({
      db,
      prepared,
      pegRates: plan.pegRates,
      fxRates: plan.fxRates,
      fxSeries: plan.fxSeries,
      commoditySeries: plan.commoditySeries,
      replayWindow,
      coingeckoApiKey: coingeckoApiKey ?? null,
      dryRun,
      applyBackfillEvents: (meta, events, window, run) => applyBackfillEvents(db, meta, events, window, run),
    });
    if (outcome.status === "skipped") {
      skipped.push(prepared.meta.symbol);
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
        errors,
        commodities:
          plan.commodityPegs.length > 0
            ? {
                goldDataPoints: plan.commoditySeries["GOLD"]?.length ?? 0,
                silverDataPoints: plan.commoditySeries["SILVER"]?.length ?? 0,
              }
            : undefined,
      }),
    );
  }

  return jsonResponse(
    buildAdminJobSummary({
      coinsProcessed: coins.length,
      eventsCreated: totalEvents,
      skipped,
      errors,
      commodities:
        plan.commodityPegs.length > 0
          ? {
              goldDataPoints: plan.commoditySeries["GOLD"]?.length ?? 0,
              silverDataPoints: plan.commoditySeries["SILVER"]?.length ?? 0,
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
