import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { toErrorMessage } from "@shared/lib/error-utils";
import type {
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { getCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import type { Env } from "../lib/env";
import {
  NATIVE_V9_INPUT_CACHE_KEY,
  parseNativeV9InputCacheArtifact,
} from "../lib/safety-score-v9-native-input";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../lib/safety-score-v9-publication-store";

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
}

function emptyD1Result(): D1Result {
  return {
    success: true,
    meta: { changes: 0 },
    results: [],
  } as unknown as D1Result;
}

function isWriteQuery(query: string): boolean {
  return /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(query.trim());
}

function captureCacheWrite(
  statement: CapturedStatement,
  state: ShadowCaptureState,
): D1Result {
  if (!/\bcache\b/iu.test(statement.query)) {
    throw new Error(
      "Safety Score V9 shadow compiler attempted a non-cache D1 write",
    );
  }

  const [key, value, updatedAt] = statement.bindings;
  if (
    typeof key === "string" &&
    typeof value === "string" &&
    typeof updatedAt === "number"
  ) {
    state.cacheWrites.set(key, { value, updatedAt });
  }
  return emptyD1Result();
}

/**
 * The canonical runner is reused against a write-capturing D1 facade. Reads
 * reach the live fixed inputs and accepted baseline; every cache write is
 * retained in memory for the final shadow-only step, and any other write is
 * rejected. This keeps compiler bytes identical without exposing live keys to
 * the Workflow writer.
 */
export function createSafetyScoreV9ShadowCaptureDatabase(
  db: D1Database,
): { db: D1Database; state: ShadowCaptureState } {
  const state: ShadowCaptureState = { cacheWrites: new Map() };
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
        if (property === "run" && isWriteQuery(query)) {
          return async () =>
            captureCacheWrite(
              { query, bindings, delegate: target },
              state,
            );
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
            return target.batch(
              captured.map((statement) => statement!.delegate),
            );
          }
          return captured.map((statement) =>
            captureCacheWrite(statement!, state),
          );
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
  const row = await getCache(db, NATIVE_V9_INPUT_CACHE_KEY);
  if (row === null) {
    throw new Error("Safety Score V9 Workflow fixed input is missing");
  }
  const artifact = await parseNativeV9InputCacheArtifact(row.value);
  return {
    sourceGeneration: artifact.input.sourceGeneration,
    baseInputGenerationId: artifact.input.baseInputGenerationId,
    clockSec: artifact.input.clockSec,
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
  const result = await computeSafetyScoreV9(capture.db);
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
    capturedCacheKeys: [...capture.state.cacheWrites.keys()].sort(),
  };
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
      error: compiled.error,
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
    error: compiled.error,
    cronMetadata: stableJsonStringifyV1({
      workflow: "safety-score-v9-publication",
      instanceId,
      slotStartedAt,
      sourceGeneration: fixedInput.sourceGeneration,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      shadowKey,
      publicationStatus,
    }),
  };
}

function terminalIdempotencyKey(instanceId: string): string {
  return `workflow:${SAFETY_SCORE_V9_WORKFLOW_JOB}:${instanceId}`;
}

export async function writeSafetyScoreV9ShadowPublication(
  db: D1Database,
  instanceId: string,
  slotStartedAt: number,
  startedAtMs: number,
  gated: GatedShadowPublication,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
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
    ).bind(gated.shadowKey, gated.shadowValue, gated.updatedAt),
    db.prepare(
      `INSERT INTO cron_runs
         (job, started_at, duration_ms, status, item_count, metadata,
          slot_started_at, error, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
): Promise<void> {
  const message = toErrorMessage(error).slice(0, 500);
  await db.prepare(
    `INSERT INTO cron_runs
       (job, started_at, duration_ms, status, item_count, metadata,
        slot_started_at, error, idempotency_key)
     VALUES (?, ?, ?, 'error', NULL, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    SAFETY_SCORE_V9_WORKFLOW_JOB,
    Math.floor(startedAtMs / 1_000),
    Math.max(0, Date.now() - startedAtMs),
    stableJsonStringifyV1({
      workflow: "safety-score-v9-publication",
      instanceId,
      slotStartedAt,
      stage: "workflow",
    }),
    slotStartedAt,
    message,
    terminalIdempotencyKey(instanceId),
  ).run();
}

export function safetyScoreV9WorkflowInstanceId(
  slotStartedAt: number,
): string {
  if (!Number.isInteger(slotStartedAt) || slotStartedAt < 0) {
    throw new Error("Safety Score V9 Workflow slot must be epoch seconds");
  }
  return `v9-publication:${slotStartedAt}`;
}

export function safetyScoreV9WorkflowSlotStartedAt(
  instanceId: string,
): number {
  const match = /^v9-publication:(\d+)$/u.exec(instanceId);
  const slotStartedAt = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(slotStartedAt) || slotStartedAt < 0) {
    throw new Error("Safety Score V9 Workflow instance id is invalid");
  }
  return slotStartedAt;
}

export async function runSafetyScoreV9PublicationWorkflow(
  env: Pick<Env, "DB">,
  event: Readonly<WorkflowEvent<unknown>>,
  step: WorkflowStep,
): Promise<SafetyScoreV9WorkflowResult> {
  const instanceId = event.instanceId;
  const slotStartedAt = safetyScoreV9WorkflowSlotStartedAt(instanceId);
  const startedAtMs = event.timestamp.getTime();

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
