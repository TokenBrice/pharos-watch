"use client";

import { useCallback, useRef, useState } from "react";
import type {
  AdminMutationExecution,
  AdminMutationExecutionStatus,
  AdminMutationRunResult,
} from "@/components/status/admin-action-execution-types";
import { classifyAdminMutationFailure } from "@/components/status/admin-mutation-failure";
import { AdminMutationError, adminMutation, type AdminMutationResult } from "@/lib/admin-access";

/**
 * `start` opens a fresh intent, `retry` replays the *same* idempotency key (the
 * only safe move after an `unknown`), `new` mints a new key for a deliberate
 * re-run.
 */
export type AdminMutationIntentMode = "start" | "retry" | "new";

export interface AdminMutationIntentRequest {
  laneKey: string;
  path: string;
  body?: unknown;
  method?: string;
  idempotencyKeyPrefix?: string;
}

export type AdminMutationIntentExecution = AdminMutationExecution<AdminMutationIntentRequest>;
export type AdminMutationIntentRunResult = AdminMutationRunResult<AdminMutationIntentExecution>;

interface MutationRequest {
  path: string;
  method?: string;
  body?: unknown;
}

interface MutationControllerOptions<Request, Execution extends AdminMutationExecution<Request>> {
  getLaneKey: (request: Request) => string;
  getMutationRequest: (request: Request) => MutationRequest;
  decorateExecution?: (execution: AdminMutationExecution<Request>, request: Request) => Execution;
  getIdempotencyKeyPrefix?: (request: Request) => string | undefined;
  createIdempotencyKey?: () => string;
}

interface MutationControllerSnapshot<Execution> {
  current: Readonly<Record<string, Execution>>;
  executions: readonly Execution[];
}

let fallbackId = 0;

export function createAdminMutationIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `admin-intent:${Date.now()}:${fallbackId}`;
}

function projectAdminMutationStatus(result: AdminMutationResult<unknown>): AdminMutationExecutionStatus {
  if (result.executionCertainty?.trim().toLowerCase() === "unknown") return "unknown";

  if (result.data && typeof result.data === "object") {
    const body = result.data as Record<string, unknown>;
    const bodyStatus =
      typeof body.executionStatus === "string"
        ? body.executionStatus.toLowerCase()
        : typeof body.status === "string"
          ? body.status.toLowerCase()
          : null;
    if (
      bodyStatus === "accepted" ||
      bodyStatus === "queued" ||
      bodyStatus === "running" ||
      bodyStatus === "succeeded" ||
      bodyStatus === "failed" ||
      bodyStatus === "unknown"
    ) {
      return bodyStatus;
    }
    if (body.accepted === true) return "accepted";
    if (body.queued === true) return "queued";
  }

  return result.status === 202 ? "accepted" : "succeeded";
}

function buildSnapshot<Request, Execution extends AdminMutationExecution<Request>>(
  currentIntentByLane: Map<string, string>,
  records: Map<string, Execution>,
): MutationControllerSnapshot<Execution> {
  const current: Record<string, Execution> = {};
  for (const [laneKey, intentId] of currentIntentByLane) {
    const execution = records.get(intentId);
    if (execution) current[laneKey] = execution;
  }
  return {
    current,
    executions: [...records.values()].sort(
      (a, b) => (b.completedAt ?? b.startedAt ?? b.createdAt) - (a.completedAt ?? a.startedAt ?? a.createdAt),
    ),
  };
}

/**
 * The single write-safety state machine for every admin mutation lane. It owns
 * intent identity, same-key retries, new-key starts, in-flight fencing,
 * attempts, and response-certainty projection. Callers only adapt their
 * request metadata and presentation model.
 */
export function useAdminMutationController<Request, Execution extends AdminMutationExecution<Request>>({
  getLaneKey,
  getMutationRequest,
  decorateExecution,
  getIdempotencyKeyPrefix,
  createIdempotencyKey = createAdminMutationIdempotencyKey,
}: MutationControllerOptions<Request, Execution>) {
  const currentIntentByLaneRef = useRef(new Map<string, string>());
  const recordsRef = useRef(new Map<string, Execution>());
  const inFlightRef = useRef(new Map<string, Promise<Execution>>());
  const [snapshot, setSnapshot] = useState<MutationControllerSnapshot<Execution>>({
    current: {},
    executions: [],
  });

  const publish = useCallback(() => {
    setSnapshot(buildSnapshot(currentIntentByLaneRef.current, recordsRef.current));
  }, []);

  const createIntent = useCallback(
    (request: Request, shouldPublish: boolean): Execution => {
      const laneKey = getLaneKey(request);
      const generatedKey = createIdempotencyKey();
      const prefix = getIdempotencyKeyPrefix?.(request);
      const idempotencyKey = prefix ? `${prefix}:${generatedKey}` : generatedKey;
      const createdAt = Date.now();
      const base: AdminMutationExecution<Request> = {
        laneKey,
        intentId: idempotencyKey,
        idempotencyKey,
        request,
        status: "ready",
        requestInFlight: false,
        ok: false,
        attempts: 0,
        data: null,
        output: "",
        error: null,
        httpStatus: null,
        idempotentReplay: null,
        responseIdempotencyKey: null,
        executionCertainty: null,
        warning: null,
        createdAt,
        startedAt: null,
        completedAt: null,
        executedAt: null,
      };
      const execution = decorateExecution ? decorateExecution(base, request) : (base as unknown as Execution);
      recordsRef.current.set(execution.intentId, execution);
      currentIntentByLaneRef.current.set(laneKey, execution.intentId);
      if (shouldPublish) publish();
      return execution;
    },
    [createIdempotencyKey, decorateExecution, getIdempotencyKeyPrefix, getLaneKey, publish],
  );

  const perform = useCallback(
    async (execution: Execution): Promise<Execution> => {
      const startedAt = Date.now();
      const running = {
        ...execution,
        status: "running",
        requestInFlight: true,
        ok: false,
        attempts: execution.attempts + 1,
        startedAt: execution.startedAt ?? startedAt,
        executedAt: execution.executedAt ?? Math.floor(startedAt / 1000),
        completedAt: null,
        error: null,
      } as Execution;
      recordsRef.current.set(running.intentId, running);
      publish();

      let finished: Execution;
      try {
        const request = getMutationRequest(running.request);
        const result = await adminMutation(request.path, {
          method: request.method ?? "POST",
          body: request.body,
          idempotencyKey: running.idempotencyKey,
        });
        const status = projectAdminMutationStatus(result);
        finished = {
          ...running,
          status,
          requestInFlight: false,
          ok: status !== "failed" && status !== "unknown",
          data: result.data,
          output: result.formattedBody,
          error: status === "failed" || status === "unknown" ? result.formattedBody : null,
          httpStatus: result.status,
          idempotentReplay: result.idempotentReplay,
          responseIdempotencyKey: result.idempotencyKey,
          executionCertainty: result.executionCertainty ?? (status === "unknown" ? "unknown" : "confirmed"),
          warning: result.warning,
          completedAt: Date.now(),
        } as Execution;
      } catch (error) {
        const status = classifyAdminMutationFailure(error, running.idempotencyKey);
        if (error instanceof AdminMutationError) {
          finished = {
            ...running,
            status,
            requestInFlight: false,
            ok: false,
            data: error.result.data,
            output: error.result.formattedBody || error.message,
            error: error.message,
            httpStatus: error.result.status,
            idempotentReplay: error.result.idempotentReplay,
            responseIdempotencyKey: error.result.idempotencyKey,
            executionCertainty: error.result.executionCertainty ?? status,
            warning: error.result.warning,
            completedAt: Date.now(),
          } as Execution;
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          finished = {
            ...running,
            status,
            requestInFlight: false,
            ok: false,
            data: null,
            output: message,
            error: message,
            executionCertainty: status,
            completedAt: Date.now(),
          } as Execution;
        }
      }
      recordsRef.current.set(finished.intentId, finished);
      publish();
      return finished;
    },
    [getMutationRequest, publish],
  );

  const runPrepared = useCallback(
    (execution: Execution): Promise<AdminMutationRunResult<Execution>> => {
      const laneKey = execution.laneKey;
      const inFlight = inFlightRef.current.get(laneKey);
      if (inFlight) return inFlight.then((current) => ({ execution: current, didStart: false }));

      const currentIntentId = currentIntentByLaneRef.current.get(laneKey);
      const current = currentIntentId ? recordsRef.current.get(currentIntentId) : undefined;
      if (!current || current.intentId !== execution.intentId || current.status !== "ready") {
        return Promise.resolve({ execution: current ?? execution, didStart: false });
      }

      const promise = perform(current);
      inFlightRef.current.set(laneKey, promise);
      return promise
        .finally(() => {
          if (inFlightRef.current.get(laneKey) === promise) inFlightRef.current.delete(laneKey);
        })
        .then((finished) => ({ execution: finished, didStart: true }));
    },
    [perform],
  );

  const runCurrentOrCreate = useCallback(
    (request: Request): Promise<AdminMutationRunResult<Execution>> => {
      const laneKey = getLaneKey(request);
      const currentIntentId = currentIntentByLaneRef.current.get(laneKey);
      const current = currentIntentId ? recordsRef.current.get(currentIntentId) : undefined;
      return runPrepared(current ?? createIntent(request, false));
    },
    [createIntent, getLaneKey, runPrepared],
  );

  const retrySame = useCallback(
    (laneKey: string): Promise<AdminMutationRunResult<Execution>> => {
      const inFlight = inFlightRef.current.get(laneKey);
      if (inFlight) return inFlight.then((execution) => ({ execution, didStart: false }));
      const currentIntentId = currentIntentByLaneRef.current.get(laneKey);
      const current = currentIntentId ? recordsRef.current.get(currentIntentId) : undefined;
      if (!current || (current.status !== "failed" && current.status !== "unknown")) {
        if (!current) throw new Error(`No admin mutation intent exists for ${laneKey}`);
        return Promise.resolve({ execution: current, didStart: false });
      }
      const ready = {
        ...current,
        status: "ready",
        requestInFlight: false,
        ok: false,
        completedAt: null,
      } as Execution;
      recordsRef.current.set(ready.intentId, ready);
      return runPrepared(ready);
    },
    [runPrepared],
  );

  const startNew = useCallback(
    (request: Request): Execution => {
      const laneKey = getLaneKey(request);
      const currentIntentId = currentIntentByLaneRef.current.get(laneKey);
      const current = currentIntentId ? recordsRef.current.get(currentIntentId) : undefined;
      if (current?.requestInFlight) return current;
      return createIntent(request, true);
    },
    [createIntent, getLaneKey],
  );

  const executeNew = useCallback(
    (request: Request): Promise<AdminMutationRunResult<Execution>> => {
      const laneKey = getLaneKey(request);
      const inFlight = inFlightRef.current.get(laneKey);
      if (inFlight) return inFlight.then((execution) => ({ execution, didStart: false }));
      return runPrepared(createIntent(request, false));
    },
    [createIntent, getLaneKey, runPrepared],
  );

  const clear = useCallback(
    (laneKey: string) => {
      if (inFlightRef.current.has(laneKey)) return;
      const intentId = currentIntentByLaneRef.current.get(laneKey);
      currentIntentByLaneRef.current.delete(laneKey);
      if (intentId) recordsRef.current.delete(intentId);
      publish();
    },
    [publish],
  );

  return { ...snapshot, runCurrentOrCreate, retrySame, startNew, executeNew, clear };
}

const getIntentLaneKey = (request: AdminMutationIntentRequest) => request.laneKey;
const getIntentMutationRequest = (request: AdminMutationIntentRequest): MutationRequest => ({
  path: request.path,
  method: request.method,
  body: request.body,
});
const getIntentIdempotencyKeyPrefix = (request: AdminMutationIntentRequest) => request.idempotencyKeyPrefix;

export function useAdminMutationIntents() {
  const controller = useAdminMutationController<
    AdminMutationIntentRequest,
    AdminMutationIntentExecution
  >({
    getLaneKey: getIntentLaneKey,
    getMutationRequest: getIntentMutationRequest,
    getIdempotencyKeyPrefix: getIntentIdempotencyKeyPrefix,
  });
  const executions = controller.current;

  const execute = (request: AdminMutationIntentRequest): Promise<AdminMutationIntentRunResult> => {
    const current = controller.current[request.laneKey];
    if (current?.status === "unknown") return Promise.resolve({ execution: current, didStart: false });
    return controller.executeNew(request);
  };

  /**
   * The one start|retry|new runner used by bespoke body mutations. Retry and
   * new modes replay the stored request body unless the caller explicitly
   * opts into rebuilding it (used by the guarded broadcast preview lane).
   */
  async function runIntent({
    laneKey,
    mode,
    buildRequest,
    replayStoredRequest = true,
    setBusy,
    onError,
  }: {
    laneKey: string;
    mode: AdminMutationIntentMode;
    buildRequest: () => AdminMutationIntentRequest;
    replayStoredRequest?: boolean;
    setBusy?: (busy: boolean) => void;
    onError?: (message: string) => void;
  }): Promise<AdminMutationIntentExecution | null> {
    const stored = controller.current[laneKey]?.request;
    if (mode === "retry" && !stored) {
      onError?.(`No admin mutation intent is available to retry for ${laneKey}`);
      return null;
    }
    let request = mode === "start" || (mode === "new" && !replayStoredRequest) ? undefined : stored;
    if (!request) {
      try {
        request = buildRequest();
      } catch (error) {
        onError?.(error instanceof Error ? error.message : "Could not prepare the admin mutation");
        return null;
      }
    }

    setBusy?.(true);
    try {
      const result =
        mode === "retry"
          ? await controller.retrySame(laneKey)
          : mode === "new"
            ? await controller.executeNew(request)
            : await execute(request);
      return result.didStart ? result.execution : null;
    } finally {
      setBusy?.(false);
    }
  }

  return {
    executions,
    execute,
    retrySame: controller.retrySame,
    executeNew: controller.executeNew,
    clear: controller.clear,
    runIntent,
  };
}
