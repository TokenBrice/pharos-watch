import type { EndpointMethod, StatusPageAction } from "@shared/lib/api-endpoints";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

export type AdminMutationExecutionStatus =
  | "ready"
  | "running"
  | "accepted"
  | "queued"
  | "succeeded"
  | "failed"
  | "unknown";

export interface AdminMutationExecution<Request> {
  laneKey: string;
  intentId: string;
  idempotencyKey: string;
  request: Request;
  status: AdminMutationExecutionStatus;
  requestInFlight: boolean;
  ok: boolean;
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
  startedAt: number | null;
  completedAt: number | null;
  executedAt: number | null;
}

export interface AdminMutationRunResult<Execution> {
  execution: Execution;
  didStart: boolean;
}

export interface AdminActionExecutionRequest {
  action: StatusPageAction;
  requestPath: string;
  requestMethod: EndpointMethod;
  scopeKey: string;
  scopeLabel: string;
}

export interface AdminActionExecution extends AdminMutationExecution<AdminActionExecutionRequest> {
  action: StatusPageAction;
  executionKey: string;
  requestPath: string;
  requestMethod: EndpointMethod;
  scopeKey: string;
  scopeLabel: string;
}

export type AdminActionRunResult = AdminMutationRunResult<AdminActionExecution>;

export interface AdminActionReadinessSource {
  getSnapshot: () => readonly ActionReadinessCheck[];
  subscribe: (listener: () => void) => () => void;
}

export interface AdminActionDialogRequest {
  action: StatusPageAction;
  initialDryRun?: boolean;
  readinessChecks?: readonly ActionReadinessCheck[];
  readinessSource?: AdminActionReadinessSource;
  onFinished?: (execution: AdminActionExecution) => void;
  returnFocus?: HTMLElement | null;
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
