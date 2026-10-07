import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { safetyScoreV9InputIdentitiesMatch } from "@shared/lib/safety-score-v9-input-identity";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SafetyScoreV9CaptureControlSchema, type SafetyScoreV9CaptureControl, type SafetyScoreV9CaptureTuple } from "@shared/types/safety-score-v9-capture-control";
import { getCache, prepareCacheUpsert, type CacheEntryWrite } from "../db-cache";
import { batchExecute } from "../d1-primitives";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { getV9ExecutionDeadlineMs, V9_EXECUTION_WINDOW_POLICY } from "../v9-slot-window";
import { SOURCE_FIXED_INPUT_MAX_AGE_SEC, type SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";

export const SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY = "report-cards:v9:capture-control:v1";
export type V9WorkerProvenance = { id: string; timestamp?: string };
type CaptureSource = Pick<SafetyScoreV9SupplyAttributionInput, "baseInputGenerationId" | "sourceGeneration" | "clockSec" | "registryFingerprint">;

export function v9WorkerProvenance(metadata?: V9WorkerProvenance): Pick<SafetyScoreV9CaptureTuple, "workerVersion" | "workerUploadedAtSec"> {
  const uploadedMs = metadata?.timestamp ? Date.parse(metadata.timestamp) : NaN;
  return {
    workerVersion: metadata?.id?.trim().slice(0, 160) || null,
    workerUploadedAtSec: Number.isFinite(uploadedMs) && uploadedMs >= 0 ? Math.floor(uploadedMs / 1_000) : null,
  };
}

export function parseSafetyScoreV9CaptureControl(value: unknown): SafetyScoreV9CaptureControl {
  return SafetyScoreV9CaptureControlSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

export function captureTupleMatchesSource(capture: SafetyScoreV9CaptureTuple, source: Readonly<CaptureSource>): boolean {
  return capture.baseInputGenerationId === source.baseInputGenerationId &&
    capture.sourceGeneration === source.sourceGeneration && capture.clockSec === source.clockSec &&
    capture.registryFingerprint === source.registryFingerprint;
}

export function captureTuplesMatch(left: SafetyScoreV9CaptureTuple, right: SafetyScoreV9CaptureTuple): boolean {
  return captureTupleMatchesSource(left, right) &&
    safetyScoreV9InputIdentitiesMatch(left.safetyScoreIdentity, right.safetyScoreIdentity) &&
    left.workerVersion === right.workerVersion && left.workerUploadedAtSec === right.workerUploadedAtSec;
}

export function buildSafetyScoreV9CaptureControl(capture: SafetyScoreV9CaptureTuple, committedAtSec: number): SafetyScoreV9CaptureControl {
  const dueSlotStartedAtSec = getCronSlotStartedAtForSchedule("v9SupplyAttributionOffset", committedAtSec * 1_000) +
    CRON_SCHEDULE_CADENCES.v9SupplyAttributionOffset.intervalSec;
  return SafetyScoreV9CaptureControlSchema.parse({
    schemaVersion: 1, capture, recaptureRequest: null,
    attribution: {
      status: "pending", dueSlotStartedAtSec,
      pendingUntilSec: Math.min(
        Math.floor(getV9ExecutionDeadlineMs(dueSlotStartedAtSec * 1_000, V9_EXECUTION_WINDOW_POLICY.supplyAttribution.deadlineOffsetMs) / 1_000),
        capture.clockSec + SOURCE_FIXED_INPUT_MAX_AGE_SEC,
      ),
      generationId: null, outcome: null,
    },
  });
}

/** All immutable capture rows and the sidecar share one D1 transaction. */
export async function commitCaptureControl(
  db: D1Database, entries: readonly CacheEntryWrite[], control: SafetyScoreV9CaptureControl,
  completeSeed: boolean, committedAtSec: number, signal?: AbortSignal,
): Promise<void> {
  const value = stableJsonStringifyV1(SafetyScoreV9CaptureControlSchema.parse(control));
  const statement = db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = json_set(excluded.value, '$.recaptureRequest', json(
      CASE WHEN ? = 1
        AND json_extract(cache.value, '$.recaptureRequest.targetWorkerVersion') = ?
        AND json_extract(cache.value, '$.recaptureRequest.targetWorkerUploadedAtSec') = ?
        AND json_extract(cache.value, '$.recaptureRequest.evaluationBuildDigest') = ?
        AND json_extract(cache.value, '$.recaptureRequest.registryFingerprint') = ?
      THEN 'null' ELSE COALESCE(json_extract(cache.value, '$.recaptureRequest'), 'null') END)),
      updated_at = excluded.updated_at`).bind(
    SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, value, committedAtSec, completeSeed ? 1 : 0,
    control.capture.workerVersion, control.capture.workerUploadedAtSec,
    control.capture.safetyScoreIdentity.evaluationBuildDigest, control.capture.registryFingerprint,
  );
  const statements = [...entries.map(entry => prepareCacheUpsert(db, { ...entry, updatedAt: committedAtSec })), statement];
  // Explicit chunk size prevents these atomic rows ever being split across batches.
  await batchExecute(db, statements, { chunkSize: statements.length, signal });
}

const CAPTURE_CAS_SQL = `json_extract(value, '$.capture.baseInputGenerationId') = ?
  AND json_extract(value, '$.capture.sourceGeneration') = ?
  AND json_extract(value, '$.capture.clockSec') = ?
  AND json_extract(value, '$.capture.registryFingerprint') = ?
  AND json_extract(value, '$.capture.safetyScoreIdentity.evaluationBuildDigest') = ?
  AND json_extract(value, '$.capture.workerVersion') IS ?
  AND json_extract(value, '$.capture.workerUploadedAtSec') IS ?`;
function captureBinds(capture: SafetyScoreV9CaptureTuple): (string | number | null)[] {
  return [capture.baseInputGenerationId, capture.sourceGeneration, capture.clockSec, capture.registryFingerprint,
    capture.safetyScoreIdentity.evaluationBuildDigest, capture.workerVersion, capture.workerUploadedAtSec];
}

export async function requestRecapture(
  db: D1Database, capture: SafetyScoreV9CaptureTuple,
  target: { workerVersion: string; workerUploadedAtSec: number; evaluationBuildDigest: string; registryFingerprint: string },
  signal?: AbortSignal,
): Promise<"requested" | "advanced"> {
  const request = SafetyScoreV9CaptureControlSchema.shape.recaptureRequest.unwrap().parse({
    targetWorkerVersion: target.workerVersion, targetWorkerUploadedAtSec: target.workerUploadedAtSec,
    evaluationBuildDigest: target.evaluationBuildDigest, registryFingerprint: target.registryFingerprint,
    sourceCaptureTuple: capture, requestedAtSec: Math.floor(Date.now() / 1_000),
  });
  const result = await runWithOverloadRetry(() => db.prepare(`UPDATE cache SET
    value = json_set(value, '$.recaptureRequest', json(?)), updated_at = ?
    WHERE key = ? AND ${CAPTURE_CAS_SQL}
    AND (json_extract(value, '$.recaptureRequest') IS NULL
      OR json_extract(value, '$.recaptureRequest.targetWorkerUploadedAtSec') <= ?)`).bind(
    stableJsonStringifyV1(request), request.requestedAtSec, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
    ...captureBinds(capture), target.workerUploadedAtSec,
  ).run(), 3, signal);
  if ((result.meta.changes ?? 0) > 0) return "requested";
  const currentRow = await getCache(db, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, signal);
  const current = currentRow ? parseSafetyScoreV9CaptureControl(currentRow.value) : null;
  if (current && !captureTuplesMatch(current.capture, capture) &&
    (current.capture.clockSec > capture.clockSec ||
      (current.capture.workerUploadedAtSec ?? -1) > (capture.workerUploadedAtSec ?? -1))) return "advanced";
  throw new Error("V9 recapture request was not persisted against the admitted capture");
}

export function hasPendingAttribution(control: SafetyScoreV9CaptureControl | null, source: Readonly<SafetyScoreV9SupplyAttributionInput>, nowSec: number): boolean {
  return control !== null && captureTupleMatchesSource(control.capture, source) &&
    control.attribution.status === "pending" && control.attribution.outcome === null &&
    nowSec < control.attribution.pendingUntilSec && source.clockSec <= nowSec &&
    nowSec - source.clockSec <= SOURCE_FIXED_INPUT_MAX_AGE_SEC;
}

/** CAS settlement cannot clear a request from a different source or admitted slot. */
export function prepareAttributionSettlement(
  db: D1Database, control: SafetyScoreV9CaptureControl, source: Readonly<CaptureSource>,
  slotStartedAtSec: number | undefined, outcome: "ok" | "degraded" | "error", generationId: string | null,
  publication?: { key: string; value: string; updatedAt: number },
): D1PreparedStatement | null {
  if (!captureTupleMatchesSource(control.capture, source) || slotStartedAtSec !== control.attribution.dueSlotStartedAtSec) return null;
  return db.prepare(`UPDATE cache SET value = json_set(value,
      '$.attribution.status', 'settled', '$.attribution.outcome', ?, '$.attribution.generationId', ?)
    WHERE key = ? AND ${CAPTURE_CAS_SQL}
      AND json_extract(value, '$.attribution.status') = 'pending'
      AND json_extract(value, '$.attribution.dueSlotStartedAtSec') = ?
      ${publication ? "AND EXISTS (SELECT 1 FROM cache published WHERE published.key = ? AND published.value = ? AND published.updated_at = ?)" : ""}`).bind(
    outcome, generationId, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, ...captureBinds(control.capture), slotStartedAtSec,
    ...(publication ? [publication.key, publication.value, publication.updatedAt] : []),
  );
}

export async function settleAttribution(
  db: D1Database, control: SafetyScoreV9CaptureControl | null, source: Readonly<CaptureSource>,
  slotStartedAtSec: number | undefined, outcome: "ok" | "degraded" | "error", generationId: string | null,
): Promise<void> {
  if (!control) return;
  const statement = prepareAttributionSettlement(db, control, source, slotStartedAtSec, outcome, generationId);
  if (statement) await runWithOverloadRetry(() => statement.run());
}
