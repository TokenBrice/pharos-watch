"use client";

import { useRef, useState } from "react";
import { AdminMutationError, adminMutation } from "@/lib/admin-access";
import { classifyAdminMutationFailure } from "@/components/status/admin-mutation-failure";

export type AdminMutationIntentStatus = "running" | "succeeded" | "failed" | "unknown";

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

export interface AdminMutationIntentExecution {
  laneKey: string;
  intentId: string;
  idempotencyKey: string;
  request: AdminMutationIntentRequest;
  status: AdminMutationIntentStatus;
  requestInFlight: boolean;
  attempts: number;
  data: unknown;
  output: string;
  error: string | null;
  httpStatus: number | null;
  idempotentReplay: boolean | null;
  responseIdempotencyKey: string | null;
  executionCertainty: string | null;
  warning: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface AdminMutationIntentRunResult {
  execution: AdminMutationIntentExecution;
  didStart: boolean;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `admin-intent:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function failedExecution(execution: AdminMutationIntentExecution, error: unknown): AdminMutationIntentExecution {
  const certainty = classifyAdminMutationFailure(error, execution.idempotencyKey);
  if (error instanceof AdminMutationError) {
    return {
      ...execution,
      status: certainty,
      requestInFlight: false,
      data: error.result.data,
      output: error.result.formattedBody || error.message,
      error: error.message,
      httpStatus: error.result.status,
      idempotentReplay: error.result.idempotentReplay,
      responseIdempotencyKey: error.result.idempotencyKey,
      executionCertainty: error.result.executionCertainty ?? certainty,
      warning: error.result.warning,
      completedAt: Date.now(),
    };
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    ...execution,
    status: certainty,
    requestInFlight: false,
    output: message,
    error: message,
    executionCertainty: certainty,
    completedAt: Date.now(),
  };
}

export function useAdminMutationIntents() {
  const executionsRef = useRef<Record<string, AdminMutationIntentExecution>>({});
  const inFlightRef = useRef(new Map<string, Promise<AdminMutationIntentExecution>>());
  const [executions, setExecutions] = useState<Readonly<Record<string, AdminMutationIntentExecution>>>({});

  function publish(execution: AdminMutationIntentExecution) {
    executionsRef.current = { ...executionsRef.current, [execution.laneKey]: execution };
    setExecutions(executionsRef.current);
  }

  function createIntent(request: AdminMutationIntentRequest): AdminMutationIntentExecution {
    const generatedKey = createIdempotencyKey();
    const idempotencyKey = request.idempotencyKeyPrefix
      ? `${request.idempotencyKeyPrefix}:${generatedKey}`
      : generatedKey;
    return {
      laneKey: request.laneKey,
      intentId: idempotencyKey,
      idempotencyKey,
      request: { ...request },
      status: "running",
      requestInFlight: true,
      attempts: 0,
      data: null,
      output: "",
      error: null,
      httpStatus: null,
      idempotentReplay: null,
      responseIdempotencyKey: null,
      executionCertainty: null,
      warning: null,
      createdAt: Date.now(),
      completedAt: null,
    };
  }

  async function perform(execution: AdminMutationIntentExecution): Promise<AdminMutationIntentExecution> {
    const running: AdminMutationIntentExecution = {
      ...execution,
      status: "running",
      requestInFlight: true,
      attempts: execution.attempts + 1,
      completedAt: null,
      error: null,
    };
    publish(running);

    let finished: AdminMutationIntentExecution;
    try {
      const result = await adminMutation(running.request.path, {
        method: running.request.method ?? "POST",
        body: running.request.body,
        idempotencyKey: running.idempotencyKey,
      });
      finished = {
        ...running,
        status: "succeeded",
        requestInFlight: false,
        data: result.data,
        output: result.formattedBody,
        error: null,
        httpStatus: result.status,
        idempotentReplay: result.idempotentReplay,
        responseIdempotencyKey: result.idempotencyKey,
        executionCertainty: result.executionCertainty ?? "confirmed",
        warning: result.warning,
        completedAt: Date.now(),
      };
    } catch (error) {
      finished = failedExecution(running, error);
    }
    publish(finished);
    return finished;
  }

  function beginRun(execution: AdminMutationIntentExecution, didStart: boolean): Promise<AdminMutationIntentRunResult> {
    const promise = perform(execution);
    inFlightRef.current.set(execution.laneKey, promise);
    return promise
      .finally(() => {
        if (inFlightRef.current.get(execution.laneKey) === promise) {
          inFlightRef.current.delete(execution.laneKey);
        }
      })
      .then((finished) => ({ execution: finished, didStart }));
  }

  function execute(request: AdminMutationIntentRequest): Promise<AdminMutationIntentRunResult> {
    const inFlight = inFlightRef.current.get(request.laneKey);
    if (inFlight) return inFlight.then((execution) => ({ execution, didStart: false }));
    const current = executionsRef.current[request.laneKey];
    if (current?.status === "unknown") return Promise.resolve({ execution: current, didStart: false });
    return beginRun(createIntent(request), true);
  }

  function retrySame(laneKey: string): Promise<AdminMutationIntentRunResult> {
    const inFlight = inFlightRef.current.get(laneKey);
    if (inFlight) return inFlight.then((execution) => ({ execution, didStart: false }));
    const current = executionsRef.current[laneKey];
    if (!current || current.status !== "unknown") {
      if (!current) throw new Error(`No admin mutation intent exists for ${laneKey}`);
      return Promise.resolve({ execution: current, didStart: false });
    }
    return beginRun(current, true);
  }

  function executeNew(request: AdminMutationIntentRequest): Promise<AdminMutationIntentRunResult> {
    const inFlight = inFlightRef.current.get(request.laneKey);
    if (inFlight) return inFlight.then((execution) => ({ execution, didStart: false }));
    return beginRun(createIntent(request), true);
  }

  function clear(laneKey: string) {
    if (inFlightRef.current.has(laneKey)) return;
    const next = { ...executionsRef.current };
    delete next[laneKey];
    executionsRef.current = next;
    setExecutions(next);
  }

  /**
   * The one start|retry|new runner (WS8.5). Every admin panel repeated the same
   * five steps: build the request (or recover the stored one for a retry), mark
   * the lane busy, dispatch to `execute` / `retrySame` / `executeNew`, always
   * clear busy, and bail out when the run did not actually start.
   *
   * `"start"` always builds a fresh request. `"retry"`/`"new"` replay the
   * stored request so the re-run keeps the original body verbatim — that is
   * what makes "Start new intent" mean *the same write under a new key*, and
   * it is why the request is stored on the execution at all. Panels whose
   * primary action is `"new"` (a re-runnable preview, say) opt out with
   * `replayStoredRequest: false` and always send current form state.
   *
   * Throwing from `buildRequest` (payload validation) is reported through
   * `onError` instead of escaping, matching the hand-rolled try/catch blocks
   * this replaces.
   *
   * Returns `null` when nothing ran — a still-in-flight lane, a lane parked in
   * `unknown` (which must be retried explicitly, never silently re-sent), a
   * missing stored request, or a rejected payload.
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
    /** May throw to reject the payload; see `replayStoredRequest` for when it runs. */
    buildRequest: () => AdminMutationIntentRequest;
    replayStoredRequest?: boolean;
    /** Busy latch for the owning row/dialog; always released before returning. */
    setBusy?: (busy: boolean) => void;
    onError?: (message: string) => void;
  }): Promise<AdminMutationIntentExecution | null> {
    const stored = executionsRef.current[laneKey]?.request;
    if (mode === "retry" && !stored) {
      // `retrySame` replays the stored intent by design; without one there is
      // nothing to retry, whatever we could build here.
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
          ? await retrySame(laneKey)
          : mode === "new"
            ? await executeNew(request)
            : await execute(request);
      return result.didStart ? result.execution : null;
    } finally {
      setBusy?.(false);
    }
  }

  return { executions, execute, retrySame, executeNew, clear, runIntent };
}
