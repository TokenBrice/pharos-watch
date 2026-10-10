import { AcceptedReserveGenerationSchema, AcceptedReserveSnapshotSchema, RedemptionReserveRunMetadataSchema, type AcceptedReserveGeneration, type ConsumedReserveInput } from "@shared/types/accepted-reserve-generation";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "./hash";
import { executeAtomicBatch } from "./db";
import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves/store-shared";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "./live-reserves/store-shared";
import { assessReserveSnapshotFreshness, evaluateLiveReserveAdmission, hasScoringEligibleLiveReserveFreshness } from "./live-reserves/store-snapshot-state";
import { parseSnapshotMetadata, parseWarningsStrict } from "./live-reserves/store-row-decoding";
import { decodeLiveReserveRedemptionTelemetry, LiveReserveDiagnosticsSchema } from "@shared/types/live-reserves";
import type { ScheduledCheckpointIdentity } from "./scheduled-recovery-checkpoint";
import type { CronResult } from "./cron-logger";

export const ACCEPTED_RESERVE_GENERATION_KEY = "live-reserves:accepted-generation:v2";
export class AcceptedReserveViewError extends Error {
  constructor(readonly reason: "accepted-reserve-view-unavailable" | "accepted-reserve-view-invalid") { super(reason); }
}

async function contentDigest(value: Omit<AcceptedReserveGeneration, "contentSha256">): Promise<string> {
  return sha256Hex(stableJsonStringifyV1(value));
}

async function decodeAcceptedReserveGeneration(value: string): Promise<AcceptedReserveGeneration> {
  try {
    const envelope = AcceptedReserveGenerationSchema.parse(JSON.parse(value));
    const { contentSha256, ...content } = envelope;
    if (await contentDigest(content) !== contentSha256) throw new Error("digest mismatch");
    return envelope;
  } catch { throw new AcceptedReserveViewError("accepted-reserve-view-invalid"); }
}

export async function loadAcceptedReserveGeneration(db: D1Database): Promise<AcceptedReserveGeneration> {
  let row: { value: string } | null;
  try { row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(ACCEPTED_RESERVE_GENERATION_KEY).first<{ value: string }>(); }
  catch { throw new AcceptedReserveViewError("accepted-reserve-view-unavailable"); }
  if (!row) throw new AcceptedReserveViewError("accepted-reserve-view-unavailable");
  return decodeAcceptedReserveGeneration(row.value);
}

interface ProjectedMemberRow {
  stablecoin_id: string; fetched_at: number | null; source: string | null; attempt_id: string | null;
  metadata: string | null; warnings: string | null; warning_count: number | null;
  state_metadata: string | null; state_warnings: string | null;
  adapter_source_model: string | null; adapter_evidence_class: string | null; config_fingerprint: string | null;
  slice_count: number | null; last_success_at: number | null; last_success_attempt_id: string | null;
  last_attempt_id: string | null; last_attempted_at: number | null; last_status: "ok" | "degraded" | "error" | "skipped" | null;
}

/** Only the lease-owned producer may publish. The child and acceptance share one D1 transaction. */
export async function sealAcceptedReserveGeneration(db: D1Database, identity: ScheduledCheckpointIdentity, queueHash: string, memberIds: readonly string[], result: CronResult, completedAtSec = Math.floor(Date.now() / 1000)): Promise<AcceptedReserveGeneration | null> {
  if (identity.scheduleKey !== "fourHourlyReserveSync" || identity.job !== "sync-live-reserves" || (result.status !== "ok" && result.status !== "degraded")) return null;
  const rows = await db.prepare(`WITH cohort AS (SELECT value AS stablecoin_id FROM json_each(?))
    SELECT cohort.stablecoin_id, c.fetched_at, c.source, c.attempt_id, c.metadata, c.warnings, c.warning_count,
      c.adapter_source_model, c.adapter_evidence_class, c.config_fingerprint,
      CASE WHEN json_valid(c.slices) AND json_type(c.slices) = 'array' THEN json_array_length(c.slices) ELSE NULL END AS slice_count,
      s.last_success_at, s.last_success_attempt_id, s.last_attempt_id, s.last_attempted_at, s.last_status, s.metadata AS state_metadata, s.warnings AS state_warnings
    FROM cohort LEFT JOIN reserve_composition c USING (stablecoin_id) LEFT JOIN reserve_sync_state s USING (stablecoin_id)
    ORDER BY cohort.stablecoin_id`).bind(JSON.stringify(memberIds)).all<ProjectedMemberRow>();
  if (rows.results.length !== memberIds.length || new Set(rows.results.map((row) => row.stablecoin_id)).size !== memberIds.length || rows.results.some((row) => !memberIds.includes(row.stablecoin_id))) throw new Error("accepted reserve member census mismatch");
  const content: Omit<AcceptedReserveGeneration, "contentSha256"> = {
    schemaVersion: 2, generationId: `reserve:${identity.slotStartedAt}:${queueHash}`,
    root: { scheduleKey: "fourHourlyReserveSync", slotStartedAt: identity.slotStartedAt, queueHash },
    sealedBy: { attemptNo: identity.attemptNo, executionGeneration: identity.executionGeneration, invocationId: identity.invocationId },
    producerCompletedAtSec: completedAtSec,
    members: rows.results.map((row) => {
      const legacyFallback = !row.attempt_id && !row.last_success_attempt_id && row.last_success_at === row.fetched_at && row.last_attempted_at === row.fetched_at && row.last_status !== "error" && row.last_status !== "skipped";
      const metadata = parseSnapshotMetadata(row.metadata);
      const parsedWarnings = parseWarningsStrict(row.warnings);
      const warnings = parsedWarnings.warnings ?? [];
      const finalMetadata = legacyFallback && Object.keys(metadata).length === 0 ? parseSnapshotMetadata(row.state_metadata) : metadata;
      const selectedWarnings = legacyFallback && warnings.length === 0 && !parsedWarnings.issue
        ? parseWarningsStrict(row.state_warnings, row.warning_count)
        : parseWarningsStrict(row.warnings, row.warning_count);
      const finalWarnings = selectedWarnings.warnings ?? [];
      const adapterKey = WORKER_TRACKED_META_BY_ID.get(row.stablecoin_id)?.liveReservesConfig?.adapter;
      const adapter = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : undefined;
      let malformed = parsedWarnings.issue != null || selectedWarnings.issue != null ||
        decodeLiveReserveRedemptionTelemetry(finalMetadata).status === "invalid";
      const diag = finalMetadata.diag;
      if (diag && Object.prototype.hasOwnProperty.call(diag, "rawSumDeviation") &&
        !LiveReserveDiagnosticsSchema.shape.rawSumDeviation.unwrap().safeParse(diag.rawSumDeviation).success) malformed = true;
      try {
        const selectedMetadata = finalMetadata === metadata ? row.metadata : row.state_metadata;
        const rawMetadata: unknown = selectedMetadata ? JSON.parse(selectedMetadata) : {};
        if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) malformed = true;
      } catch { malformed = true; }
      const parsed = AcceptedReserveSnapshotSchema.safeParse({ stablecoinId: row.stablecoin_id, fetchedAt: row.fetched_at, attemptId: row.attempt_id ?? null,
        source: row.source, metadata: finalMetadata, warnings: finalWarnings, warningCount: row.warning_count ?? finalWarnings.length,
        adapterSourceModel: row.adapter_source_model ?? adapter?.sourceModel, adapterEvidenceClass: row.adapter_evidence_class ?? adapter?.evidenceClass, configFingerprint: row.config_fingerprint ?? null,
        sliceCount: row.slice_count, lastSuccessAt: row.last_success_at, lastSuccessAttemptId: row.last_success_attempt_id ?? null });
      return { stablecoinId: row.stablecoin_id, snapshot: parsed.success && !malformed ? parsed.data : null,
        latestAttempt: { attemptId: row.last_attempt_id ?? null, attemptedAt: row.last_attempted_at ?? null, status: row.last_status ?? null } };
    }),
  };
  const envelope = AcceptedReserveGenerationSchema.parse({ ...content, contentSha256: await contentDigest(content) });
  const fence = `schedule_key = ? AND slot_started_at = ? AND job = ? AND attempt_no = ? AND execution_generation = ? AND invocation_id = ?
    AND state IN ('running', 'recovering') AND queue_hash = ? AND items_total = ? AND items_done = items_total
    AND next_item_key IS NULL AND current_item_key IS NULL AND current_domain_attempt_id IS NULL`;
  const binds = [identity.scheduleKey, identity.slotStartedAt, identity.job, identity.attemptNo, identity.executionGeneration, identity.invocationId, queueHash, memberIds.length];
  // Validate the entire prior envelope, not just its root clock. Exact-value CAS
  // repairs invalid acceptance; a concurrent older root may still be superseded.
  const prior = await db.prepare("SELECT value FROM cache WHERE key = ?")
    .bind(ACCEPTED_RESERVE_GENERATION_KEY).first<{ value: string }>();
  let replacePrior = true;
  if (prior) {
    try {
      const accepted = await decodeAcceptedReserveGeneration(prior.value);
      replacePrior = accepted.root.slotStartedAt < envelope.root.slotStartedAt;
    } catch (error) {
      if (!(error instanceof AcceptedReserveViewError)) throw error;
    }
  }
  const results = await executeAtomicBatch(db, [
    db.prepare(`UPDATE worker_scheduled_checkpoints SET child_dispositions_json = json_set(child_dispositions_json, '$."sync-live-reserves"', 'completed'), updated_at = ? WHERE ${fence} AND json_extract(child_dispositions_json, '$."sync-live-reserves"') IN ('running', 'completed')`).bind(completedAtSec, ...binds),
    db.prepare(`INSERT INTO cache (key, value, updated_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM worker_scheduled_checkpoints WHERE ${fence} AND json_extract(child_dispositions_json, '$."sync-live-reserves"') = 'completed')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE (cache.value = ? AND ? = 1)
        OR CASE WHEN json_valid(cache.value) THEN json_extract(cache.value, '$.root.slotStartedAt') < json_extract(excluded.value, '$.root.slotStartedAt') ELSE 0 END`).bind(ACCEPTED_RESERVE_GENERATION_KEY, JSON.stringify(envelope), completedAtSec, ...binds, prior?.value ?? null, replacePrior ? 1 : 0),
  ], { returnResults: true });
  if (results[0].meta.changes !== 1) return null;
  // Single-root idempotency and delayed replays deliberately retain the newer seal.
  return loadAcceptedReserveGeneration(db);
}

export function acceptedReserveMetadataMap(envelope: AcceptedReserveGeneration, now: number): Map<string, ReserveSnapshotMetadataRecord> {
  const map = new Map<string, ReserveSnapshotMetadataRecord>();
  for (const member of envelope.members) {
    const snapshot = member.snapshot;
    if (!snapshot) continue;
    const admission = evaluateLiveReserveAdmission(snapshot, snapshot, WORKER_TRACKED_META_BY_ID.get(member.stablecoinId), now);
    if (admission.reasons.includes("config-mismatch")) continue;
    map.set(member.stablecoinId, { stablecoinId: member.stablecoinId, fetchedAt: snapshot.fetchedAt, source: snapshot.source, metadata: snapshot.metadata,
      warningCount: snapshot.warningCount, warnings: snapshot.warnings, sourceModel: snapshot.adapterSourceModel, evidenceClass: snapshot.adapterEvidenceClass,
      syncStatus: member.latestAttempt.status ?? "skipped", admission });
  }
  return map;
}

export function consumedReserveInput(envelope: AcceptedReserveGeneration, stablecoinId: string, record: ReserveSnapshotMetadataRecord): ConsumedReserveInput {
  const snapshot = envelope.members.find((member) => member.stablecoinId === stablecoinId)?.snapshot;
  if (!snapshot || !record.admission?.freshness) throw new Error("selected reserve input has no admission identity");
  return { generationId: envelope.generationId, contentSha256: envelope.contentSha256, stablecoinId, attemptId: snapshot.attemptId, configFingerprint: snapshot.configFingerprint, freshness: record.admission.freshness };
}

export type RedemptionReserveQuarantineReason = "config-mismatch" | "freshness-unverified" | "stale";

/**
 * `state` judges the run's binding integrity; an asset whose consumed reserve
 * evidence is no longer scoring-admissible is quarantined alone (R8) so one
 * coin cannot withhold every redemption row.
 */
export interface ConsumedRedemptionReserveAssessment {
  state: "fresh" | "unavailable";
  quarantined: Readonly<Record<string, RedemptionReserveQuarantineReason>>;
}

const UNAVAILABLE_CONSUMED_RESERVES: ConsumedRedemptionReserveAssessment = { state: "unavailable", quarantined: {} };

/** Immutable row census is mandatory; no inferred bindings for legacy manifests. */
export function assessConsumedRedemptionReserves(entries: readonly RedemptionBackstopEntry[], metadata: unknown, runClockSec: number, now: number): ConsumedRedemptionReserveAssessment {
  const parsed = RedemptionReserveRunMetadataSchema.safeParse(metadata);
  if (!parsed.success || parsed.data.runClockSec !== runClockSec) return UNAVAILABLE_CONSUMED_RESERVES;
  const census = parsed.data.consumedReserveInputs;
  const quarantined: Record<string, RedemptionReserveQuarantineReason> = {};
  let consumed = 0;
  for (const entry of entries) {
    const input = entry.reserveInput;
    if (!input) { if (census[entry.stablecoinId]) return UNAVAILABLE_CONSUMED_RESERVES; continue; }
    consumed++;
    if (!census[entry.stablecoinId]) return UNAVAILABLE_CONSUMED_RESERVES;
    if (input.stablecoinId !== entry.stablecoinId || input.generationId !== parsed.data.reserveGenerationId || input.contentSha256 !== parsed.data.reserveContentSha256 || stableJsonStringifyV1(census[entry.stablecoinId]) !== stableJsonStringifyV1(input) || input.attemptId !== input.freshness.attemptId) return UNAVAILABLE_CONSUMED_RESERVES;
    const f = input.freshness;
    if (f.fetchedAt === null || f.fetchedAt > runClockSec || f.assessedAt !== runClockSec || f.fetchAgeSec !== f.assessedAt - f.fetchedAt || f.fetchBudgetSec !== LIVE_RESERVE_FRESHNESS_SEC) return UNAVAILABLE_CONSUMED_RESERVES;
    const coin = WORKER_TRACKED_META_BY_ID.get(entry.stablecoinId);
    const config = coin?.liveReservesConfig;
    if (!coin || !config || config.suspended || computeLiveReserveConfigFingerprint(config) !== input.configFingerprint) {
      quarantined[entry.stablecoinId] = "config-mismatch";
      continue;
    }
    const snapshot = { fetchedAt: f.fetchedAt, attemptId: f.attemptId, metadata: {
      ...(f.freshnessMode !== null ? { freshnessMode: f.freshnessMode } : {}),
      ...(f.sourceTimestamp !== null ? { sourceTimestamp: f.sourceTimestamp } : {}),
      diag: { invalidFreshness: f.sourceFreshnessInvalid },
    } };
    if (!hasScoringEligibleLiveReserveFreshness(snapshot.metadata, now)) quarantined[entry.stablecoinId] = "freshness-unverified";
    else if (f.stale || assessReserveSnapshotFreshness(snapshot, coin, now, LIVE_RESERVE_FRESHNESS_SEC).stale) quarantined[entry.stablecoinId] = "stale";
  }
  if (consumed !== Object.keys(census).length) return UNAVAILABLE_CONSUMED_RESERVES;
  return { state: "fresh", quarantined };
}
