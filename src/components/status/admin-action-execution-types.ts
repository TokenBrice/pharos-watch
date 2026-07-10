import type { EndpointMethod, StatusPageAction } from "@shared/lib/api-endpoints";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

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
  resultData: unknown;
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

export interface AdminActionRunResult {
  execution: AdminActionExecution;
  didStart: boolean;
}

export interface AdminActionDialogRequest {
  action: StatusPageAction;
  initialDryRun?: boolean;
  readinessChecks?: readonly ActionReadinessCheck[];
  onFinished?: (execution: AdminActionExecution) => void;
}

export interface AdminActionDialogState extends AdminActionDialogRequest {
  dialogId: number;
}

export interface AdminActionExecutionController {
  current: Readonly<Record<string, AdminActionExecution>>;
  executions: readonly AdminActionExecution[];
  execute: (request: AdminActionExecutionRequest) => Promise<AdminActionRunResult>;
  retry: (executionKey: string) => Promise<AdminActionRunResult>;
  startNew: (request: AdminActionExecutionRequest) => AdminActionExecution;
}
