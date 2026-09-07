import type { D1Database } from "@cloudflare/workers-types";
import type { BackfillEvent } from "../backfill-depegs-extraction";
import type { BackfillReplayWindow } from "../backfill-depegs-window";
import { fnv1aHash } from "../../lib/hash";

export type BackfillConfidenceTier = "high" | "medium" | "low";

export interface BackfillEventProvenanceInput {
  replayRunId: string;
  replayVersion: string;
  sourceKind: "market" | "authoritative";
  sourcePriceProviders: string[];
  quoteMode: string | null;
  pegReferenceSource: string;
  supplySource: string;
  confirmationPolicy: string;
  confirmationPointCount: number;
  marketDiagnostics: Record<string, unknown> | null;
  policyAdjustments: unknown[];
  confidenceTier: BackfillConfidenceTier;
  auditVerdict: "confirmed" | "disputed" | "false_positive" | "no_data" | "repaired" | null;
}

export interface BackfillRunInput {
  runId: string;
  sourceType: "market" | "authoritative";
  expectedFingerprint: string;
  expectedEventCount: number;
  removedCount: number;
  addedCount: number;
  replayWindow: BackfillReplayWindow | null;
}

export type PersistedBackfillEvent = BackfillEvent & {
  provenance?: BackfillEventProvenanceInput;
};

export function buildBackfillEventsFingerprint(events: BackfillEvent[]): string {
  return fnv1aHash(JSON.stringify(events.map((event) => ({
    direction: event.direction,
    peakDeviationBps: event.peakDeviationBps,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    startPrice: event.startPrice,
    peakPrice: event.peakPrice,
    recoveryPrice: event.recoveryPrice,
    pegRef: event.pegRef,
  }))));
}

export function buildReplayRunId(stablecoinId: string): string {
  const now = Date.now();
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stablecoinId}:${now}:${suffix}`;
}

export function inferBackfillConfidence(input: {
  sourceKind: "market" | "authoritative";
  quoteMode: string | null;
  sourceCount: number;
  policyAdjustmentCount: number;
}): BackfillConfidenceTier {
  if (input.sourceKind === "authoritative") return "high";
  if (input.quoteMode === "native-peg" && input.sourceCount > 0 && input.policyAdjustmentCount === 0) return "high";
  if (input.sourceCount >= 2 && input.policyAdjustmentCount <= 1) return "medium";
  return "low";
}

function buildPublicProvenance(input: BackfillEventProvenanceInput, updatedAt: number): Record<string, unknown> {
  return {
    sourceKind: input.sourceKind,
    replayRunId: input.replayRunId,
    replayVersion: input.replayVersion,
    sourcePriceProviders: input.sourcePriceProviders,
    quoteMode: input.quoteMode,
    pegReferenceSource: input.pegReferenceSource,
    supplySource: input.supplySource,
    confirmationPolicy: input.confirmationPolicy,
    confirmationPointCount: input.confirmationPointCount,
    confidenceTier: input.confidenceTier,
    auditVerdict: input.auditVerdict,
    pegScoreEligible: input.auditVerdict !== "false_positive" && input.auditVerdict !== "disputed",
    updatedAt,
  };
}

export function buildUpsertBackfillRunStmt(
  db: D1Database,
  meta: { id: string },
  run: BackfillRunInput,
  status: "started" | "complete" | "incomplete",
  nowSec: number,
  insertedCount: number,
  error: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_backfill_runs (
         run_id, stablecoin_id, start_day, end_day, context_days, source_type,
         expected_event_count, expected_fingerprint, removed_count, added_count,
         inserted_count, status, error, started_at, finished_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         inserted_count = excluded.inserted_count,
         status = excluded.status,
         error = excluded.error,
         finished_at = excluded.finished_at`,
    )
    .bind(
      run.runId,
      meta.id,
      run.replayWindow?.startDay ?? null,
      run.replayWindow?.endDay ?? null,
      run.replayWindow?.contextDays ?? null,
      run.sourceType,
      run.expectedEventCount,
      run.expectedFingerprint,
      run.removedCount,
      run.addedCount,
      insertedCount,
      status,
      error,
      nowSec,
      status === "started" ? null : nowSec,
    );
}

export function buildInsertProvenanceStmt(
  db: D1Database,
  meta: { id: string },
  event: { startedAt: number },
  provenance: BackfillEventProvenanceInput,
  nowSec: number,
): D1PreparedStatement {
  const publicJson = JSON.stringify(buildPublicProvenance(provenance, nowSec));
  return db
    .prepare(
      `INSERT OR REPLACE INTO depeg_event_provenance (
         event_id, source_kind, replay_run_id, replay_version, source_price_providers,
         quote_mode, peg_reference_source, supply_source, confirmation_policy,
         confirmation_point_count, market_diagnostics_json, policy_adjustments_json,
         confidence_tier, audit_verdict, public_json, created_at, updated_at
       )
       SELECT
         id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM depeg_events
       WHERE stablecoin_id = ? AND source = 'backfill' AND started_at = ?`,
    )
    .bind(
      provenance.sourceKind,
      provenance.replayRunId,
      provenance.replayVersion,
      JSON.stringify(provenance.sourcePriceProviders),
      provenance.quoteMode,
      provenance.pegReferenceSource,
      provenance.supplySource,
      provenance.confirmationPolicy,
      provenance.confirmationPointCount,
      JSON.stringify(provenance.marketDiagnostics),
      JSON.stringify(provenance.policyAdjustments),
      provenance.confidenceTier,
      provenance.auditVerdict,
      publicJson,
      nowSec,
      nowSec,
      meta.id,
      event.startedAt,
    );
}
