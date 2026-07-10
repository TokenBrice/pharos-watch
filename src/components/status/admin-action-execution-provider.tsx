"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { EndpointMethod, StatusPageAction } from "@shared/lib/api-endpoints";
import { AdminMutationError, adminMutation, type AdminMutationResult } from "@/lib/admin-access";
import { RequestFailure } from "@/lib/request";

export type AdminActionExecutionStatus =
  "ready" | "running" | "accepted" | "queued" | "succeeded" | "failed" | "unknown";

export interface AdminActionExecutionRequest {
  action: StatusPageAction;
  requestPath: string;
  requestMethod: EndpointMethod;
  scopeKey: string;
  scopeLabel: string;
}

export interface AdminActionExecution {
  action: StatusPageAction;
  executionKey: string;
  intentId: string;
  idempotencyKey: string;
  requestPath: string;
  requestMethod: EndpointMethod;
  scopeKey: string;
  scopeLabel: string;
  status: AdminActionExecutionStatus;
  requestInFlight: boolean;
  ok: boolean;
  output: string;
  error: string | null;
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  executedAt: number | null;
  httpStatus: number | null;
  idempotentReplay: boolean | null;
  responseIdempotencyKey: string | null;
  executionCertainty: string | null;
  warning: string | null;
}

interface AdminActionRunResult {
  execution: AdminActionExecution;
  didStart: boolean;
}

interface AdminActionExecutionContextValue {
  current: Readonly<Record<string, AdminActionExecution>>;
  executions: readonly AdminActionExecution[];
  execute: (request: AdminActionExecutionRequest) => Promise<AdminActionRunResult>;
  retry: (executionKey: string) => Promise<AdminActionRunResult>;
  startNew: (request: AdminActionExecutionRequest) => AdminActionExecution;
}

interface ExecutionStore {
  currentIntentByKey: Map<string, string>;
  records: Map<string, AdminActionExecution>;
}

interface ExecutionSnapshot {
  current: Record<string, AdminActionExecution>;
  executions: AdminActionExecution[];
}

const AdminActionExecutionContext = createContext<AdminActionExecutionContextValue | null>(null);

let fallbackId = 0;

function createDefaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `admin-action:${Date.now()}:${fallbackId}`;
}

export function getAdminActionExecutionKey(actionPath: string, scopeKey: string): string {
  return `${actionPath}\u0000${scopeKey}`;
}

function statusFromSuccessfulResponse(result: AdminMutationResult<unknown>): AdminActionExecutionStatus {
  const headerStatus = result.executionCertainty?.trim().toLowerCase();
  if (headerStatus === "unknown") return "unknown";

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

function isExecutionUnknownBody(data: unknown): boolean {
  return Boolean(
    data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error === "execution_unknown",
  );
}

function isActiveIdempotencyConflict(execution: AdminActionExecution, result: AdminMutationResult<unknown>): boolean {
  if (result.status !== 409) return false;
  const errorMessage =
    result.data &&
    typeof result.data === "object" &&
    "error" in result.data &&
    typeof (result.data as { error?: unknown }).error === "string"
      ? (result.data as { error: string }).error.toLowerCase()
      : "";
  const isReservationOrOwnershipLoss =
    errorMessage.includes("idempotency key is currently reserved") ||
    errorMessage.includes("idempotency reservation ownership was lost");
  const identifiesSameExecution =
    result.idempotentReplay === true || result.idempotencyKey === execution.idempotencyKey;
  return isReservationOrOwnershipLoss && identifiesSameExecution;
}

function executionFromFailure(
  execution: AdminActionExecution,
  error: unknown,
  completedAt: number,
): AdminActionExecution {
  if (error instanceof AdminMutationError) {
    const status =
      isExecutionUnknownBody(error.result.data) ||
      isActiveIdempotencyConflict(execution, error.result) ||
      error.result.executionCertainty?.trim().toLowerCase() === "unknown" ||
      error.result.status >= 500
        ? "unknown"
        : "failed";
    return {
      ...execution,
      status,
      requestInFlight: false,
      ok: false,
      output: error.result.formattedBody || error.message,
      error: error.message,
      completedAt,
      httpStatus: error.result.status,
      idempotentReplay: error.result.idempotentReplay,
      responseIdempotencyKey: error.result.idempotencyKey,
      executionCertainty: error.result.executionCertainty ?? status,
      warning: error.result.warning,
    };
  }

  const isUncertainRequestFailure =
    error instanceof RequestFailure &&
    (error.kind === "network" || error.kind === "timeout" || error.kind === "aborted");
  const message = error instanceof Error ? error.message : "Unknown error";
  const status = isUncertainRequestFailure ? "unknown" : "failed";
  return {
    ...execution,
    status,
    requestInFlight: false,
    ok: false,
    output: message,
    error: message,
    completedAt,
    executionCertainty: status,
  };
}

function buildSnapshot(store: ExecutionStore): ExecutionSnapshot {
  const current: Record<string, AdminActionExecution> = {};
  for (const [executionKey, intentId] of store.currentIntentByKey) {
    const execution = store.records.get(intentId);
    if (execution) current[executionKey] = execution;
  }

  return {
    current,
    executions: [...store.records.values()].sort(
      (a, b) => (b.completedAt ?? b.startedAt ?? b.createdAt) - (a.completedAt ?? a.startedAt ?? a.createdAt),
    ),
  };
}

export function AdminActionExecutionProvider({
  children,
  createIdempotencyKey = createDefaultIdempotencyKey,
}: {
  children: ReactNode;
  createIdempotencyKey?: () => string;
}) {
  const storeRef = useRef<ExecutionStore>({
    currentIntentByKey: new Map(),
    records: new Map(),
  });
  const inFlightRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot>({ current: {}, executions: [] });

  const publish = useCallback(() => {
    setSnapshot(buildSnapshot(storeRef.current));
  }, []);

  const createIntent = useCallback(
    (request: AdminActionExecutionRequest, shouldPublish: boolean): AdminActionExecution => {
      const executionKey = getAdminActionExecutionKey(request.action.path, request.scopeKey);
      const idempotencyKey = createIdempotencyKey();
      const createdAt = Date.now();
      const execution: AdminActionExecution = {
        action: request.action,
        executionKey,
        intentId: idempotencyKey,
        idempotencyKey,
        requestPath: request.requestPath,
        requestMethod: request.requestMethod,
        scopeKey: request.scopeKey,
        scopeLabel: request.scopeLabel,
        status: "ready",
        requestInFlight: false,
        ok: false,
        output: "",
        error: null,
        attempts: 0,
        createdAt,
        startedAt: null,
        completedAt: null,
        executedAt: null,
        httpStatus: null,
        idempotentReplay: null,
        responseIdempotencyKey: null,
        executionCertainty: null,
        warning: null,
      };
      const store = storeRef.current;
      store.records.set(execution.intentId, execution);
      store.currentIntentByKey.set(executionKey, execution.intentId);
      if (shouldPublish) publish();
      return execution;
    },
    [createIdempotencyKey, publish],
  );

  const runIntent = useCallback(
    async (execution: AdminActionExecution): Promise<AdminActionRunResult> => {
      const store = storeRef.current;
      const currentIntentId = store.currentIntentByKey.get(execution.executionKey);
      const current = currentIntentId ? store.records.get(currentIntentId) : undefined;
      if (!current || current.intentId !== execution.intentId || current.status !== "ready") {
        return { execution: current ?? execution, didStart: false };
      }
      if (inFlightRef.current.has(execution.executionKey)) {
        return { execution: current, didStart: false };
      }

      inFlightRef.current.add(execution.executionKey);
      const startedAt = Date.now();
      const running: AdminActionExecution = {
        ...current,
        status: "running",
        requestInFlight: true,
        ok: false,
        attempts: current.attempts + 1,
        startedAt: current.startedAt ?? startedAt,
        executedAt: current.executedAt ?? Math.floor(startedAt / 1000),
        completedAt: null,
        error: null,
      };
      store.records.set(running.intentId, running);
      publish();

      let finished: AdminActionExecution;
      try {
        const response = await adminMutation(running.requestPath, {
          method: running.requestMethod,
          idempotencyKey: running.idempotencyKey,
        });
        const status = statusFromSuccessfulResponse(response);
        finished = {
          ...running,
          status,
          requestInFlight: false,
          ok: status !== "failed" && status !== "unknown",
          output: response.formattedBody,
          error: status === "failed" || status === "unknown" ? response.formattedBody : null,
          completedAt: Date.now(),
          httpStatus: response.status,
          idempotentReplay: response.idempotentReplay,
          responseIdempotencyKey: response.idempotencyKey,
          executionCertainty: response.executionCertainty ?? (status === "unknown" ? "unknown" : "confirmed"),
          warning: response.warning,
        };
      } catch (error) {
        finished = executionFromFailure(running, error, Date.now());
      } finally {
        inFlightRef.current.delete(execution.executionKey);
      }

      store.records.set(finished.intentId, finished);
      publish();
      return { execution: finished, didStart: true };
    },
    [publish],
  );

  const execute = useCallback(
    async (request: AdminActionExecutionRequest): Promise<AdminActionRunResult> => {
      const executionKey = getAdminActionExecutionKey(request.action.path, request.scopeKey);
      const currentIntentId = storeRef.current.currentIntentByKey.get(executionKey);
      const current = currentIntentId ? storeRef.current.records.get(currentIntentId) : undefined;
      const execution = current ?? createIntent(request, false);
      return runIntent(execution);
    },
    [createIntent, runIntent],
  );

  const retry = useCallback(
    async (executionKey: string): Promise<AdminActionRunResult> => {
      const store = storeRef.current;
      const currentIntentId = store.currentIntentByKey.get(executionKey);
      const current = currentIntentId ? store.records.get(currentIntentId) : undefined;
      if (!current || (current.status !== "failed" && current.status !== "unknown")) {
        if (!current) throw new Error(`No execution intent exists for ${executionKey}`);
        return { execution: current, didStart: false };
      }
      const ready: AdminActionExecution = {
        ...current,
        status: "ready",
        requestInFlight: false,
        ok: false,
        completedAt: null,
      };
      store.records.set(ready.intentId, ready);
      return runIntent(ready);
    },
    [runIntent],
  );

  const startNew = useCallback(
    (request: AdminActionExecutionRequest): AdminActionExecution => {
      const executionKey = getAdminActionExecutionKey(request.action.path, request.scopeKey);
      const currentIntentId = storeRef.current.currentIntentByKey.get(executionKey);
      const current = currentIntentId ? storeRef.current.records.get(currentIntentId) : undefined;
      if (current?.requestInFlight) return current;
      return createIntent(request, true);
    },
    [createIntent],
  );

  const value = useMemo<AdminActionExecutionContextValue>(
    () => ({ ...snapshot, execute, retry, startNew }),
    [execute, retry, snapshot, startNew],
  );

  return <AdminActionExecutionContext.Provider value={value}>{children}</AdminActionExecutionContext.Provider>;
}

function useAdminActionExecutionContext(): AdminActionExecutionContextValue {
  const context = useContext(AdminActionExecutionContext);
  if (!context) {
    throw new Error("Admin action controls must be rendered inside AdminActionExecutionProvider");
  }
  return context;
}

export function useAdminActionExecution(actionPath: string, scopeKey: string) {
  const context = useAdminActionExecutionContext();
  return {
    execution: context.current[getAdminActionExecutionKey(actionPath, scopeKey)],
    execute: context.execute,
    retry: context.retry,
    startNew: context.startNew,
  };
}

export function useAdminActionExecutions(): readonly AdminActionExecution[] {
  return useAdminActionExecutionContext().executions;
}
