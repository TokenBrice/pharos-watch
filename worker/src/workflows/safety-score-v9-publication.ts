import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describeError } from "@shared/lib/error-utils";
import { z } from "zod";
import { SafetyScoreV9InputIdentitySchema } from "@shared/types/safety-score-publication";
import { safetyScoreV9InputIdentitiesMatch } from "@shared/lib/safety-score-v9-input-identity";
import { FixedInputCacheEnvelopeFields } from "../lib/report-cards-fixed-input-cache-codec";
import { SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, parseSafetyScoreV9CaptureControl } from "../lib/safety-score-v9/capture-control";
import type {
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { getCache } from "../lib/db-cache";
import { resolveCronDegradedReason, type CronResult } from "../lib/cron-logger";
import { stripSensitive } from "../lib/safe-error-message";
import { parseJsonObject } from "../lib/json-parse";
import type { ScheduledEnv } from "../lib/env";
import { NATIVE_V9_INPUT_CACHE_KEY } from "../lib/safety-score-v9/native-input";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../lib/safety-score-v9/publication-store";

export const SAFETY_SCORE_V9_WORKFLOW_JOB =
  "compute-safety-score-v9-workflow";
export const SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX =
  "safety-score-v9:shadow";

const WORKFLOW_STEP_CONFIG = {
  retries: {
    limit: 3,
    delay: "10 seconds",
    backoff: "exponential",
  },
  timeout: "14 minutes",
} as const;

const FixedInputReferenceEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  kind: FixedInputCacheEnvelopeFields.kind,
  encoding: FixedInputCacheEnvelopeFields.encoding,
  sourceGeneration: FixedInputCacheEnvelopeFields.sourceGeneration,
  safetyScoreIdentity: SafetyScoreV9InputIdentitySchema,
});

interface FixedInputReference {
  sourceGeneration: string;
  baseInputGenerationId: string;
  clockSec: number;
}

interface CapturedPublicationRun {
  status: NonNullable<CronResult["status"]>;
  itemCount: number | null;
  metadata: string | null;
  error: string | null;
  publicationEnvelope: string | null;
  publicationHealth: string | null;
  publicationAttempt: string | null;
  failedPublicationAttempt: string | null;
  capturedCacheKeys: string[];
}

interface GatedShadowPublication {
  shadowKey: string;
  shadowValue: string;
  updatedAt: number;
  cronStatus: NonNullable<CronResult["status"]>;
  itemCount: number | null;
  error: string | null;
  cronMetadata: string;
}

export interface SafetyScoreV9WorkflowResult {
  instanceId: string;
  shadowKey: string | null;
  sourceGeneration: string | null;
  status: "complete" | "error";
}

interface CapturedStatement {
  query: string;
  bindings: readonly unknown[];
  delegate: D1PreparedStatement;
}

interface ShadowCaptureState {
  cacheWrites: Map<string, { value: string; updatedAt: number }>;
  cacheKeys: Set<string>;
}

const SHADOW_RETAINED_CACHE_KEYS = new Set<string>([
  SAFETY_SCORE_V9_CACHE_KEYS.publication,
  SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
  SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
  SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
]);

function emptyD1Result(): D1Result {
  return {
    success: true,
    meta: { changes: 0 },
    results: [],
  } as unknown as D1Result;
}

function isWriteQuery(query: string): boolean {
  return /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|PRAGMA)\b/iu.test(
    query.trim(),
  );
}

async function captureCacheWrite(
  statement: CapturedStatement,
  state: ShadowCaptureState,
  db: D1Database,
): Promise<D1Result> {
  if (!/\bcache\b/iu.test(statement.query)) {
    throw new Error(
      "Safety Score V9 shadow compiler attempted a non-cache D1 write",
    );
  }

  const query = statement.query.trim().replace(/\s+/gu, " ");
  const retainedPublicationGuard = /^UPDATE cache SET value = value WHERE key = \? AND updated_at = \?$/iu.test(query);
  const heldHealthGuard = /^INSERT INTO cache \(key, value, updated_at\) VALUES \( \?, CASE WHEN EXISTS \( SELECT 1 FROM cache WHERE key = \? AND updated_at = \? \) THEN \? ELSE NULL END, \? \) ON CONFLICT\(key\) DO UPDATE SET /iu.test(query);
  const key = statement.bindings[0];
  let value = statement.bindings[1];
  let updatedAt = statement.bindings[2];
  if (retainedPublicationGuard || heldHealthGuard) {
    const publicationKey = retainedPublicationGuard ? key : statement.bindings[1];
    const acceptedAtSec = retainedPublicationGuard ? value : statement.bindings[2];
    if (statement.bindings.length !== (retainedPublicationGuard ? 2 : 5)
      || publicationKey !== SAFETY_SCORE_V9_CACHE_KEYS.publication
      || typeof acceptedAtSec !== "number"
      || (heldHealthGuard && key !== SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth)) {
      throw new Error("Safety Score V9 shadow compiler attempted a cache write with unsupported bindings");
    }
    const retained = await db.prepare("SELECT updated_at FROM cache WHERE key = ? AND updated_at = ?")
      .bind(publicationKey, acceptedAtSec).first<{ updated_at: number }>();
    if (!retained) throw new Error("Safety Score V9 shadow retained publication clock changed");
    if (retainedPublicationGuard) return emptyD1Result();
    value = statement.bindings[3];
    updatedAt = statement.bindings[4];
  }
  if (
    (!heldHealthGuard && statement.bindings.length !== 3) ||
    typeof key !== "string" ||
    typeof value !== "string" ||
    typeof updatedAt !== "number"
  ) {
    throw new Error(
      "Safety Score V9 shadow compiler attempted a cache write with unsupported bindings",
    );
  }
  state.cacheKeys.add(key);
  if (SHADOW_RETAINED_CACHE_KEYS.has(key)) {
    state.cacheWrites.set(key, { value, updatedAt });
  }
  return emptyD1Result();
}

/**
 * The canonical runner is reused against a write-capturing D1 facade. Reads
 * reach the live fixed inputs and accepted baseline; every cache write is
 * suppressed; only the four shadow result values are retained, and any other write is
 * rejected. This keeps compiler bytes identical without exposing live keys to
 * the Workflow writer.
 */
export function createSafetyScoreV9ShadowCaptureDatabase(
  db: D1Database,
): { db: D1Database; state: ShadowCaptureState } {
  const state: ShadowCaptureState = { cacheWrites: new Map(), cacheKeys: new Set() };
  const statementMetadata = new WeakMap<object, CapturedStatement>();

  const wrapStatement = (
    delegate: D1PreparedStatement,
    query: string,
    bindings: readonly unknown[] = [],
  ): D1PreparedStatement => {
    const proxy = new Proxy(delegate, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), query, values);
        }
        if (
          isWriteQuery(query) &&
          (
            property === "run" ||
            property === "all" ||
            property === "first" ||
            property === "raw"
          )
        ) {
          return async () => {
            const result = await captureCacheWrite(
              { query, bindings, delegate: target },
              state,
              db,
            );
            if (property === "first") return null;
            if (property === "raw") return [];
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statementMetadata.set(proxy, { query, bindings, delegate });
    return proxy;
  };

  const shadowDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const captured = statements.map((statement) =>
            statementMetadata.get(statement),
          );
          if (captured.some((statement) => statement === undefined)) {
            throw new Error(
              "Safety Score V9 shadow compiler received an untracked D1 statement",
            );
          }
          if (captured.some((statement) => !isWriteQuery(statement!.query))) {
            if (captured.some((statement) => isWriteQuery(statement!.query))) {
              throw new Error(
                "Safety Score V9 shadow compiler attempted a mixed read/write D1 batch",
              );
            }
            return target.batch(
              captured.map((statement) => statement!.delegate),
            );
          }
          const pending: ShadowCaptureState = { cacheWrites: new Map(state.cacheWrites), cacheKeys: new Set(state.cacheKeys) };
          const results = [];
          for (const statement of captured) results.push(await captureCacheWrite(statement!, pending, db));
          state.cacheWrites = pending.cacheWrites;
          state.cacheKeys = pending.cacheKeys;
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { db: shadowDb, state };
}

async function loadFixedInputReference(
  db: D1Database,
): Promise<FixedInputReference> {
  // Project only the envelope identity and small capture-control sidecar in one
  // SQL snapshot. The compile step alone decompresses and admits the payload.
  const row = await db.prepare(`
    SELECT json_object(
      'schemaVersion', json_extract(input.value, '$.schemaVersion'),
      'kind', json_extract(input.value, '$.kind'),
      'encoding', json_extract(input.value, '$.encoding'),
      'sourceGeneration', json_extract(input.value, '$.sourceGeneration'),
      'safetyScoreIdentity', json_extract(input.value, '$.safetyScoreIdentity')
    ) AS reference, control.value AS capture_control
    FROM cache input LEFT JOIN cache control ON control.key = ?
    WHERE input.key = ?
  `).bind(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, NATIVE_V9_INPUT_CACHE_KEY)
    .first<{ reference: string; capture_control: string | null }>();
  if (row === null) {
    throw new Error("Safety Score V9 Workflow fixed input is missing");
  }
  if (row.capture_control === null) {
    throw new Error("Safety Score V9 Workflow capture control is missing");
  }
  const reference = FixedInputReferenceEnvelopeSchema.parse(parseJsonObject(row.reference));
  const { capture } = parseSafetyScoreV9CaptureControl(row.capture_control);
  if (!safetyScoreV9InputIdentitiesMatch(reference.safetyScoreIdentity, capture.safetyScoreIdentity) ||
    reference.sourceGeneration !== capture.sourceGeneration ||
    reference.safetyScoreIdentity.baseInputGenerationId !== capture.baseInputGenerationId ||
    reference.safetyScoreIdentity.publicationGenerationId !== capture.sourceGeneration) {
    throw new Error("Safety Score V9 Workflow fixed input reference does not match capture control");
  }
  return {
    sourceGeneration: capture.sourceGeneration,
    baseInputGenerationId: capture.baseInputGenerationId,
    clockSec: capture.clockSec,
  };
}

async function compilePublication(
  db: D1Database,
  fixedInput: FixedInputReference,
): Promise<CapturedPublicationRun> {
  const capture = createSafetyScoreV9ShadowCaptureDatabase(db);
  const { computeSafetyScoreV9 } = await import(
    "../cron/compute-safety-score-v9"
  );
  // Accepted replay retention belongs to the authoritative cron publication.
  // Building its delta here duplicates a large serialization while the candidate
  // graph is live, even though the shadow result never returns that artifact.
  const result = await computeSafetyScoreV9(capture.db, undefined, undefined, {
    retainAcceptedReplay: false,
  });
  const parsedMetadata = result.metadata === undefined
    ? null
    : JSON.parse(result.metadata) as { sourceGenerationId?: unknown };
  if (
    parsedMetadata?.sourceGenerationId !== undefined &&
    parsedMetadata.sourceGenerationId !== fixedInput.sourceGeneration
  ) {
    throw new Error(
      "Safety Score V9 Workflow fixed input advanced after the load step",
    );
  }

  const getCapturedValue = (key: string) =>
    capture.state.cacheWrites.get(key)?.value ?? null;
  return {
    status: result.status ?? "ok",
    itemCount: result.itemCount ?? null,
    metadata: result.metadata ?? null,
    error: result.error ?? null,
    publicationEnvelope: getCapturedValue(
      SAFETY_SCORE_V9_CACHE_KEYS.publication,
    ),
    publicationHealth: getCapturedValue(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
    ),
    publicationAttempt: getCapturedValue(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
    ),
    failedPublicationAttempt: getCapturedValue(
      SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
    ),
    capturedCacheKeys: [...capture.state.cacheKeys].sort(),
  };
}

function resolveCompiledWorkflowReason(compiled: CapturedPublicationRun): string | null {
  const metadata = parseJsonObject(compiled.metadata);
  const attempt = parseJsonObject(compiled.failedPublicationAttempt);
  const failure = attempt?.failure;
  const code = failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
  return resolveCronDegradedReason(SAFETY_SCORE_V9_WORKFLOW_JOB, compiled.status,
    { error: compiled.error ?? undefined },
    { ...metadata, ...(typeof metadata?.reason !== "string" && typeof code === "string" ? { reason: code } : {}) });
}

export async function gateSafetyScoreV9ShadowPublication(
  instanceId: string,
  slotStartedAt: number,
  fixedInput: FixedInputReference,
  compiled: CapturedPublicationRun,
): Promise<GatedShadowPublication> {
  const metadata = compiled.metadata === null
    ? null
    : JSON.parse(compiled.metadata) as {
        sourceGenerationId?: unknown;
        baseInputGenerationId?: unknown;
        publication?: { status?: unknown };
      };
  if (
    metadata?.sourceGenerationId !== fixedInput.sourceGeneration ||
    metadata.baseInputGenerationId !== fixedInput.baseInputGenerationId
  ) {
    throw new Error(
      "Safety Score V9 Workflow result does not match its fixed input",
    );
  }
  const publicationStatus = metadata.publication?.status;
  if (
    publicationStatus === "published" &&
    compiled.publicationEnvelope === null
  ) {
    throw new Error(
      "Safety Score V9 Workflow published result has no captured publication",
    );
  }
  if (
    publicationStatus !== "published" &&
    compiled.publicationEnvelope !== null
  ) {
    throw new Error(
      "Safety Score V9 Workflow non-published result captured a publication",
    );
  }

  const reason = resolveCompiledWorkflowReason(compiled);
  const error = compiled.status === "error" || compiled.status === "degraded"
    ? `${reason}${compiled.error ? `: ${stripSensitive(compiled.error)}` : ""}`.slice(0, 500) : null;
  const shadowKey = `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:${fixedInput.sourceGeneration}`;
  const shadowValue = stableJsonStringifyV1({
    schemaVersion: 1,
    instanceId,
    slotStartedAt,
    sourceGeneration: fixedInput.sourceGeneration,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    clockSec: fixedInput.clockSec,
    publicationStatus,
    cronResult: {
      status: compiled.status,
      itemCount: compiled.itemCount,
      metadata: compiled.metadata,
      error,
    },
    captured: {
      publicationEnvelope: compiled.publicationEnvelope,
      publicationHealth: compiled.publicationHealth,
      publicationAttempt: compiled.publicationAttempt,
      failedPublicationAttempt: compiled.failedPublicationAttempt,
      cacheKeys: compiled.capturedCacheKeys,
    },
  });
  return {
    shadowKey,
    shadowValue,
    updatedAt: fixedInput.clockSec,
    cronStatus: compiled.status,
    itemCount: compiled.itemCount,
    error,
    cronMetadata: stableJsonStringifyV1({
      workflow: "safety-score-v9-publication",
      instanceId,
      slotStartedAt,
      sourceGeneration: fixedInput.sourceGeneration,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      shadowKey,
      publicationStatus,
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
    }),
  };
}

function terminalIdempotencyKey(instanceId: string): string {
  return `workflow:${SAFETY_SCORE_V9_WORKFLOW_JOB}:${instanceId}`;
}

/**
 * Commits the admitted shadow generation and its terminal `cron_runs` row in
 * one batch. The terminal row is derived from the same admission result as the
 * cache write: a generation the monotonic guard rejects commits neither, so the
 * postcondition throw below can still record the conflict as an error row.
 * Committing a non-error row for a rejected generation would make the durable
 * terminal history contradict the instance's own returned status.
 */
export async function writeSafetyScoreV9ShadowPublication(
  db: D1Database,
  instanceId: string,
  slotStartedAt: number,
  startedAtMs: number,
  gated: GatedShadowPublication,
  workerVersion: string | null,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO cache (key, value, updated_at)
       SELECT ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1
            FROM cache
           WHERE key LIKE ?
             AND updated_at > ?
        )
       ON CONFLICT(key) DO UPDATE SET
         value = CASE
           WHEN cache.value = excluded.value
             AND cache.updated_at = excluded.updated_at
           THEN cache.value
           ELSE NULL
         END,
         updated_at = CASE
           WHEN cache.value = excluded.value
             AND cache.updated_at = excluded.updated_at
           THEN cache.updated_at
           ELSE -1
         END`,
    ).bind(
      gated.shadowKey,
      gated.shadowValue,
      gated.updatedAt,
      `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:%`,
      gated.updatedAt,
    ),
    db.prepare(
      `DELETE FROM cache
        WHERE key LIKE ?
          AND key <> ?
          AND updated_at <= ?`,
    ).bind(
      `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:%`,
      gated.shadowKey,
      gated.updatedAt,
    ),
    db.prepare(
      `INSERT INTO cron_runs
         (job, started_at, duration_ms, status, item_count, metadata,
          slot_started_at, error, idempotency_key, degraded_reason, worker_version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
            FROM cache
           WHERE key = ?
             AND value = ?
             AND updated_at = ?
        )
       ON CONFLICT DO NOTHING`,
    ).bind(
      SAFETY_SCORE_V9_WORKFLOW_JOB,
      Math.floor(startedAtMs / 1_000),
      Math.max(0, Date.now() - startedAtMs),
      gated.cronStatus,
      gated.itemCount,
      gated.cronMetadata,
      slotStartedAt,
      gated.error,
      terminalIdempotencyKey(instanceId),
      resolveCronDegradedReason(SAFETY_SCORE_V9_WORKFLOW_JOB, gated.cronStatus, undefined, parseJsonObject(gated.cronMetadata)),
      workerVersion,
      gated.shadowKey,
      gated.shadowValue,
      gated.updatedAt,
    ),
  ]);

  const stored = await getCache(db, gated.shadowKey);
  if (
    stored?.value !== gated.shadowValue ||
    stored.updatedAt !== gated.updatedAt
  ) {
    throw new Error(
      "Safety Score V9 Workflow shadow generation conflicts with an existing value",
    );
  }
}

async function writeTerminalFailure(
  db: D1Database,
  instanceId: string,
  slotStartedAt: number,
  startedAtMs: number,
  error: unknown,
  capturedReason: string | null,
  workerVersion: string | null,
): Promise<void> {
  const descriptor = describeError(error, stripSensitive);
  const reason = capturedReason || descriptor.code || "workflow-execution-failed";
  const metadata = {
    workflow: "safety-score-v9-publication",
    instanceId,
    slotStartedAt,
    workerVersion,
    stage: "workflow",
    reason,
    errorDescriptor: descriptor,
  };
  const message = `${reason}: ${descriptor.message}`.slice(0, 500);
  await db.prepare(
    `INSERT INTO cron_runs
       (job, started_at, duration_ms, status, item_count, metadata,
        slot_started_at, error, idempotency_key, degraded_reason, worker_version)
     VALUES (?, ?, ?, 'error', NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    SAFETY_SCORE_V9_WORKFLOW_JOB,
    Math.floor(startedAtMs / 1_000),
    Math.max(0, Date.now() - startedAtMs),
    stableJsonStringifyV1(metadata),
    slotStartedAt,
    message,
    terminalIdempotencyKey(instanceId),
    resolveCronDegradedReason(SAFETY_SCORE_V9_WORKFLOW_JOB, "error", undefined, metadata),
    workerVersion,
  ).run();
}

/**
 * Records the neutral `cron_runs` row for a shadow Workflow slot whose
 * upstream compiler returned a terminal result with no publication to
 * shadow. Without this row the job shows as bare `unavailable` whenever
 * compute skips or fails closed; with it, the status surface names the real
 * machine-readable upstream reason. The row uses an `:upstream-absent`
 * idempotency-key suffix so a later duplicate delivery of the same slot that
 * does publish can still write its real terminal row — the two must never
 * share a key, or the neutral row would permanently mask an admitted shadow.
 */
export async function recordSkippedSafetyScoreV9WorkflowRun(
  db: D1Database,
  instanceId: string,
  slotStartedAt: number,
  upstream: {
    status: NonNullable<CronResult["status"]>;
    reason: string | null;
    stage: string | null;
  },
  workerVersion: string | null,
): Promise<void> {
  await db.prepare(
    `INSERT INTO cron_runs
       (job, started_at, duration_ms, status, item_count, metadata,
        slot_started_at, error, idempotency_key, degraded_reason, worker_version)
     VALUES (?, ?, ?, 'skipped_neutral', 0, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    SAFETY_SCORE_V9_WORKFLOW_JOB,
    Math.floor(Date.now() / 1_000),
    0,
    stableJsonStringifyV1({
      workflow: "safety-score-v9-publication",
      instanceId,
      slotStartedAt,
      workerVersion,
      reason: "upstream-compute-publication-absent",
      upstreamJob: "compute-safety-score-v9",
      upstreamStatus: upstream.status,
      upstreamReason: upstream.reason,
      upstreamStage: upstream.stage,
    }),
    slotStartedAt,
    `${terminalIdempotencyKey(instanceId)}:upstream-absent`,
    resolveCronDegradedReason(SAFETY_SCORE_V9_WORKFLOW_JOB, "skipped_neutral", undefined,
      { reason: "upstream-compute-publication-absent" }),
    workerVersion,
  ).run();
}

export function safetyScoreV9WorkflowInstanceId(
  slotStartedAt: number,
): string {
  if (!Number.isInteger(slotStartedAt) || slotStartedAt < 0) {
    throw new Error("Safety Score V9 Workflow slot must be epoch seconds");
  }
  return `v9-publication-${slotStartedAt}`;
}

export function safetyScoreV9WorkflowSlotStartedAt(
  instanceId: string,
): number {
  const match = /^v9-publication-(\d+)$/u.exec(instanceId);
  const slotStartedAt = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(slotStartedAt) || slotStartedAt < 0) {
    throw new Error(
      `Safety Score V9 Workflow instance id is invalid: ${JSON.stringify(instanceId)}`,
    );
  }
  return slotStartedAt;
}

/**
 * The trigger sends the slot in `params`; that is the authoritative input.
 * Older instances created before that change carry it only in their id, so the
 * id remains a fallback rather than the primary source.
 */
export function resolveSafetyScoreV9WorkflowSlot(
  event: Readonly<WorkflowEvent<unknown>>,
): number {
  const payload = event.payload as { slotStartedAt?: unknown } | null | undefined;
  const fromPayload = payload?.slotStartedAt;
  if (Number.isSafeInteger(fromPayload) && (fromPayload as number) >= 0) {
    return fromPayload as number;
  }
  return safetyScoreV9WorkflowSlotStartedAt(String(event.instanceId));
}

export async function runSafetyScoreV9PublicationWorkflow(
  env: Pick<ScheduledEnv, "DB" | "CF_VERSION_METADATA">,
  event: Readonly<WorkflowEvent<unknown>>,
  step: WorkflowStep,
): Promise<SafetyScoreV9WorkflowResult> {
  const slotStartedAt = resolveSafetyScoreV9WorkflowSlot(event);
  // Derived, never read back from the runtime event: this id keys the terminal
  // idempotency row, so an absent event field must not collapse slots onto a
  // literal "undefined".
  const instanceId = safetyScoreV9WorkflowInstanceId(slotStartedAt);
  const startedAtMs = event.timestamp.getTime();
  let capturedReason: string | null = null;
  const workerVersion = env.CF_VERSION_METADATA?.id || null;

  try {
    const fixedInput = await step.do(
      "load fixed input",
      WORKFLOW_STEP_CONFIG,
      () => loadFixedInputReference(env.DB),
    );
    if (fixedInput.clockSec > slotStartedAt) {
      throw new Error(
        "Safety Score V9 Workflow fixed input is newer than its trigger slot",
      );
    }
    const compiled = await step.do(
      "compile publication",
      WORKFLOW_STEP_CONFIG,
      () => compilePublication(env.DB, fixedInput),
    );
    capturedReason = resolveCompiledWorkflowReason(compiled);
    if (capturedReason?.startsWith("unspecified-")) capturedReason = null;
    const gated = await step.do(
      "gate publication",
      WORKFLOW_STEP_CONFIG,
      () =>
        gateSafetyScoreV9ShadowPublication(
          instanceId,
          slotStartedAt,
          fixedInput,
          compiled,
        ),
    );
    await step.do(
      "write shadow publication",
      WORKFLOW_STEP_CONFIG,
      async () => {
        await writeSafetyScoreV9ShadowPublication(
          env.DB,
          instanceId,
          slotStartedAt,
          startedAtMs,
          gated,
          workerVersion,
        );
        return { shadowKey: gated.shadowKey };
      },
    );
    return {
      instanceId,
      shadowKey: gated.shadowKey,
      sourceGeneration: fixedInput.sourceGeneration,
      status: "complete",
    };
  } catch (error) {
    await step.do(
      "write terminal failure",
      WORKFLOW_STEP_CONFIG,
      async () => {
        await writeTerminalFailure(
          env.DB,
          instanceId,
          slotStartedAt,
          startedAtMs,
          error,
          capturedReason,
          workerVersion,
        );
        return { recorded: true };
      },
    );
    return {
      instanceId,
      shadowKey: null,
      sourceGeneration: null,
      status: "error",
    };
  }
}
