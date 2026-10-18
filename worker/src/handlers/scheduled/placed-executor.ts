import {
  PLACED_EXECUTOR_MAX_BODY_BYTES, PLACED_EXECUTOR_URL,
  PlacedProjectTapeRequestSchema, PlacedProjectTapeResultSchema,
} from "@shared/types/placed-executor";
import type { PlacedProjectTapeRequest } from "@shared/types/placed-executor";
import { projectTape } from "../../cron/project-tape";
import { timingSafeCompare } from "../../lib/auth";
import { parseRequestJsonWithSchema } from "../../lib/api-json-body";
import { settleAfterAbort } from "../../lib/cron-abort-settlement";
import { CRON_TIMEOUT_MS, createSlotDeadline, assertSlotDeadline } from "../../lib/cron-timeouts";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type { HeavyEnv } from "../../lib/env";
import { parseJsonObject } from "../../lib/json-parse";
import { cancelResponseBodyQuietly, readResponseJsonWithinLimitWithSignal } from "../../lib/response-body";
import type { ScheduledRuntimeContext } from "./context";

function failure(reason: string): CronResult {
  return { status: "error", error: reason, metadata: JSON.stringify({ reason, executorMode: "placed-fetch" }) };
}

/** No retries: a lost response may follow committed work. Only a later slot may run again. */
export async function runProjectTapeCanary(
  runtime: ScheduledRuntimeContext, signal: AbortSignal, reportProgress: CronProgressReporter,
): Promise<CronResult> {
  if (runtime.env.PROJECT_TAPE_PLACED_EXECUTOR === "off") {
    return projectTape(runtime.db, signal, reportProgress);
  }
  const binding = runtime.env.HEAVY_EXECUTOR;
  const secret = runtime.env.HEAVY_EXECUTOR_SHARED_SECRET;
  const fence = runtime.executionFence;
  if (!binding || !secret) return failure("placed-executor-not-configured");
  if (!fence || fence.scheduleKey !== "dewsPsiOffset" || fence.slotStartedAt !== runtime.slotStartedAt) {
    return failure("placed-executor-missing-fence");
  }
  const workDeadlineMs = Math.min(runtime.deadline.platformDeadlineMs, Date.now() + CRON_TIMEOUT_MS["project-tape"]);
  const payload: PlacedProjectTapeRequest = {
    job: "project-tape", scheduleKey: "dewsPsiOffset", slotStartedAt: runtime.slotStartedAt,
    eventEntryMs: runtime.deadline.eventEntryMs, deadlineMs: runtime.deadline.platformDeadlineMs, workDeadlineMs,
    invocationId: fence.invocationId, owner: fence.owner, generation: fence.generation,
  };
  const transportSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, workDeadlineMs - Date.now()))]);
  const settled = await settleAfterAbort(async () => {
    let response: Response | undefined;
    try {
      response = await binding.fetch(new Request(PLACED_EXECUTOR_URL, {
        method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(payload), signal: transportSignal,
      }));
      if (!response.ok) return failure("placed-executor-http-error");
      const raw = await readResponseJsonWithinLimitWithSignal(response, PLACED_EXECUTOR_MAX_BODY_BYTES, transportSignal);
      const parsed = PlacedProjectTapeResultSchema.safeParse(raw);
      return parsed.success ? parsed.data : failure("placed-executor-invalid-result");
    } finally {
      await cancelResponseBodyQuietly(response);
    }
  }, transportSignal, { platformDeadlineMs: runtime.deadline.platformDeadlineMs });
  if (settled.status === "aborted") return failure("placed-executor-timeout");
  if (settled.status === "rejected") return failure("placed-executor-transport-failed");
  return settled.value;
}

// The driver alone acquires/renews the job lease and records the child terminal.
// Every remote write transaction checks that exact driver's live child + lease.
const ACTIVE_EXECUTION_SQL = `EXISTS (SELECT 1 FROM cron_slot_executions s
  JOIN scheduled_child_attempts a ON a.execution_schedule_key = s.slot_key
    AND a.execution_slot_started_at = s.slot_started_at AND a.execution_owner = s.execution_owner
    AND a.execution_generation = s.execution_generation AND a.execution_invocation_id = s.invocation_id
  JOIN cron_leases l ON l.job = a.job AND l.lease_owner = a.lease_owner
  WHERE s.slot_key = ? AND s.slot_started_at = ? AND s.state = 'running'
    AND s.execution_owner = ? AND s.execution_generation = ? AND s.invocation_id = ?
    AND a.schedule_key = s.slot_key AND a.slot_started_at = s.slot_started_at
    AND a.job = 'project-tape' AND a.started_at IS NOT NULL AND a.terminal_token IS NULL
    AND l.lease_until > unixepoch()
    AND unixepoch() * 1000 < MIN(?, a.started_at * 1000 + ?)
    AND json_extract(s.metadata, '$.slotDeadlineMs') = ?)`;

function executionBindings(payload: PlacedProjectTapeRequest): (string | number)[] {
  return [payload.scheduleKey, payload.slotStartedAt, payload.owner, payload.generation, payload.invocationId,
    payload.workDeadlineMs, CRON_TIMEOUT_MS["project-tape"], payload.deadlineMs];
}

/** Transactional guard: queued D1 writes cannot commit after deadline, takeover or driver terminal. */
function guardedProjectorDatabase(db: D1Database, payload: PlacedProjectTapeRequest, signal: AbortSignal): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const checkpoint = () => signal.throwIfAborted();
  const batch = async (statements: D1PreparedStatement[]) => {
    checkpoint();
    const guard = db.prepare(`SELECT CASE WHEN ${ACTIVE_EXECUTION_SQL}
      THEN 1 ELSE json('placed-executor-fence-lost') END AS admitted`).bind(...executionBindings(payload));
    const results = await db.batch([guard, ...statements.map((statement) => originals.get(statement) ?? statement)]);
    checkpoint();
    return results.slice(1);
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "all" || property === "run") return async () => (await batch([target]))[0];
        // Projector first/raw calls are reads; their following write still has an atomic guard.
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { checkpoint(); return Reflect.apply(value, target, args); };
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { checkpoint(); return wrap(target.prepare(sql)); };
      if (property === "batch") return batch;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function handlePlacedExecutorFetch(request: Request, env: HeavyEnv): Promise<Response> {
  const secret = env.HEAVY_EXECUTOR_SHARED_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!secret || !provided || !(await timingSafeCompare(provided, secret))) {
    await request.body?.cancel();
    return Response.json({ error: "placed-executor-unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST" || request.url !== PLACED_EXECUTOR_URL) {
    await request.body?.cancel();
    return Response.json({ error: "placed-executor-unknown-operation" }, { status: 404 });
  }
  const payload = await parseRequestJsonWithSchema(request, PlacedProjectTapeRequestSchema, {
    maxBytes: PLACED_EXECUTOR_MAX_BODY_BYTES, invalidJsonMessage: "placed-executor-invalid-request",
  });
  if (payload instanceof Response) return payload;
  const deadline = createSlotDeadline(payload.eventEntryMs, Math.min(payload.deadlineMs, payload.workDeadlineMs));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadline.remainingMs())]);
  const evidence = {
    executorMode: "placed-fetch", executorColo: typeof request.cf?.colo === "string" ? request.cf.colo : null,
    executorColoSource: "request.cf.colo", cfPlacement: request.headers.get("cf-placement"),
    executorWorkerVersion: env.CF_VERSION_METADATA?.id ?? null,
    slotStartedAt: payload.slotStartedAt, executionGeneration: payload.generation,
  };
  const respond = (result: CronResult) => Response.json({ ...result,
    metadata: JSON.stringify({ ...parseJsonObject(result.metadata), ...evidence }),
  });
  try {
    assertSlotDeadline(deadline, signal);
    // Durable one-shot marker lives with the existing slot record, so it survives
    // isolate changes and is pruned by slot retention. Never clear it on failure.
    const claim = await env.DB.prepare(`UPDATE cron_slot_executions SET metadata = json_set(
      COALESCE(metadata, '{}'), '$.placedProjectTape', json_object('generation', ?))
      WHERE slot_key = ? AND slot_started_at = ?
        AND COALESCE(json_extract(metadata, '$.placedProjectTape.generation'), 0) <> ?
        AND ${ACTIVE_EXECUTION_SQL}`).bind(payload.generation, payload.scheduleKey, payload.slotStartedAt,
      payload.generation, ...executionBindings(payload)).run();
    assertSlotDeadline(deadline, signal);
    if ((claim.meta.changes ?? 0) !== 1) return respond(failure("placed-executor-duplicate-or-stale"));
    const db = guardedProjectorDatabase(env.DB, payload, signal);
    const settled = await settleAfterAbort(() => projectTape(db, signal), signal, {
      platformDeadlineMs: deadline.platformDeadlineMs,
    });
    if (settled.status === "aborted") return respond(failure("placed-executor-timeout"));
    if (settled.status === "rejected") return respond(failure("placed-executor-execution-failed"));
    assertSlotDeadline(deadline, signal);
    // A projector can degrade after catching a guarded write error. A final
    // guard must succeed before returning any accepted result to the driver.
    await db.batch([]);
    return respond(settled.value);
  } catch {
    return respond(failure(signal.aborted ? "placed-executor-timeout" : "placed-executor-execution-failed"));
  }
}
