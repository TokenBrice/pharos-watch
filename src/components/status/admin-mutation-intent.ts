"use client";

import { useRef, useState } from "react";
import { AdminMutationError, adminMutation } from "@/lib/admin-access";
import { RequestFailure } from "@/lib/request";

export type AdminMutationIntentStatus = "running" | "succeeded" | "failed" | "unknown";

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

function isExecutionUnknownBody(data: unknown): boolean {
  return Boolean(
    data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error === "execution_unknown",
  );
}

function isActiveIdempotencyConflict(execution: AdminMutationIntentExecution, error: AdminMutationError): boolean {
  const { result } = error;
  if (result.status !== 409) return false;
  const errorMessage =
    result.data &&
    typeof result.data === "object" &&
    "error" in result.data &&
    typeof (result.data as { error?: unknown }).error === "string"
      ? (result.data as { error: string }).error.toLowerCase()
      : "";
  const reservationConflict =
    errorMessage.includes("idempotency key is currently reserved") ||
    errorMessage.includes("idempotency reservation ownership was lost");
  const sameExecution = result.idempotentReplay === true || result.idempotencyKey === execution.idempotencyKey;
  return reservationConflict && sameExecution;
}

function failedExecution(execution: AdminMutationIntentExecution, error: unknown): AdminMutationIntentExecution {
  if (error instanceof AdminMutationError) {
    const unknown =
      isExecutionUnknownBody(error.result.data) ||
      isActiveIdempotencyConflict(execution, error) ||
      error.result.executionCertainty?.trim().toLowerCase() === "unknown" ||
      error.result.status >= 500;
    return {
      ...execution,
      status: unknown ? "unknown" : "failed",
      requestInFlight: false,
      data: error.result.data,
      output: error.result.formattedBody || error.message,
      error: error.message,
      httpStatus: error.result.status,
      idempotentReplay: error.result.idempotentReplay,
      responseIdempotencyKey: error.result.idempotencyKey,
      executionCertainty: error.result.executionCertainty ?? (unknown ? "unknown" : "failed"),
      warning: error.result.warning,
      completedAt: Date.now(),
    };
  }

  const uncertain =
    error instanceof RequestFailure &&
    (error.kind === "network" || error.kind === "timeout" || error.kind === "aborted");
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    ...execution,
    status: uncertain ? "unknown" : "failed",
    requestInFlight: false,
    output: message,
    error: message,
    executionCertainty: uncertain ? "unknown" : "failed",
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

  return { executions, execute, retrySame, executeNew, clear };
}
