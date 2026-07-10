import type {
  EndpointDefinition,
  StatusPageActionAuditMode,
  StatusPageActionDryRun,
  StatusPageActionScope,
} from "@shared/lib/api-endpoints";
import { logAdminAction } from "./admin-action-audit";
import { sha256Hex } from "./hash";
import { logWorkerEvent } from "./structured-log";

export type CatalogActionAuditOwner = "canonical" | "handler";
export type CatalogActionAuditOutcome = "succeeded" | "accepted" | "queued" | "failed" | "unknown";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const SAFE_TARGET_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const EXECUTION_CERTAINTY_MAX_LENGTH = 32;

export function getCatalogActionAuditOwner(endpoint: EndpointDefinition): CatalogActionAuditOwner | null {
  if (!endpoint.statusPageAction) return null;
  const owner: StatusPageActionAuditMode = endpoint.statusPageAction.auditMode ?? "canonical";
  return owner;
}

function getSafeIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("Idempotency-Key")?.trim() ?? "";
  return value.length > 0 && value.length <= IDEMPOTENCY_KEY_MAX_LENGTH ? value : null;
}

function getSafeTarget(scope: StatusPageActionScope, url: URL): { target: string; label: string } {
  if (scope.type !== "asset-or-batch") {
    return { target: scope.label, label: scope.label };
  }

  const requestedTargetParam = url.searchParams.get(scope.queryParam);
  if (requestedTargetParam == null) {
    return { target: "batch", label: scope.batchLabel };
  }
  const requestedTarget = requestedTargetParam.trim();
  if (SAFE_TARGET_PATTERN.test(requestedTarget)) {
    return { target: requestedTarget, label: scope.assetLabel };
  }
  return { target: "invalid-target", label: scope.assetLabel };
}

function isDryRun(dryRun: StatusPageActionDryRun, url: URL): boolean {
  if (!dryRun.supported) return false;
  const requestedMode = url.searchParams.get(dryRun.queryParam);
  if (requestedMode != null) return requestedMode !== "false";
  if (!dryRun.liveSupported) return true;
  return dryRun.default;
}

function getActionMode(endpoint: EndpointDefinition, url: URL, method: string): "dry-run" | "live" | "inspect" {
  const action = endpoint.statusPageAction;
  if (!action) return "inspect";
  if (isDryRun(action.dryRun, url)) return "dry-run";
  if (endpoint.mutatingAdmin && method.toUpperCase() !== "GET") return "live";
  if (action.kind === "inspect" || action.risk === "read-only") return "inspect";
  return "live";
}

function getOutcome(endpoint: EndpointDefinition, response: Response): CatalogActionAuditOutcome {
  if (response.headers.get("X-Execution-Certainty")?.toLowerCase() === "unknown") return "unknown";
  if (response.status < 200 || response.status >= 300) return "failed";
  if (response.status === 202) {
    return endpoint.statusPageAction?.resultMode === "queued" ? "queued" : "accepted";
  }
  return "succeeded";
}

function getExecutionCertainty(response: Response, outcome: CatalogActionAuditOutcome): string {
  const header = response.headers.get("X-Execution-Certainty")?.trim().toLowerCase() ?? "";
  if (/^[a-z0-9_-]+$/u.test(header) && header.length <= EXECUTION_CERTAINTY_MAX_LENGTH) return header;
  return outcome === "unknown" ? "unknown" : "confirmed";
}

export async function auditCatalogActionResponse({
  db,
  endpoint,
  request,
  response,
}: {
  db: D1Database;
  endpoint: EndpointDefinition | undefined;
  request: Request;
  response: Response;
}): Promise<void> {
  if (!endpoint?.statusPageAction || getCatalogActionAuditOwner(endpoint) !== "canonical") return;
  if (response.headers.get("X-Idempotency-Conflict") === "request-mismatch") return;

  const idempotencyKey = getSafeIdempotencyKey(request);
  const idempotencyKeyHash = idempotencyKey ? await sha256Hex(idempotencyKey) : null;
  const intentKey = idempotencyKeyHash ? `catalog:v1:${idempotencyKeyHash}` : undefined;
  const url = new URL(request.url);
  const { target, label: scopeLabel } = getSafeTarget(endpoint.statusPageAction.scope, url);
  const outcome = getOutcome(endpoint, response);
  const executionCertainty = getExecutionCertainty(response, outcome);
  const idempotentReplay = response.headers.get("X-Idempotent-Replay") === "true";

  const persisted = await logAdminAction(
    db,
    {
      action: endpoint.key,
      target,
      result: outcome === "failed" || outcome === "unknown" ? "error" : "ok",
      httpStatus: response.status,
      intentKey,
      intentWriteMode: idempotentReplay ? "insert-if-missing" : "authoritative",
      details: {
        path: endpoint.path,
        method: request.method.toUpperCase(),
        mode: getActionMode(endpoint, url, request.method),
        outcome,
        status: outcome,
        executionCertainty,
        resultMode: endpoint.statusPageAction.resultMode,
        scope: {
          type: endpoint.statusPageAction.scope.type,
          label: scopeLabel,
        },
        idempotencyKeyHash,
        idempotentReplay,
      },
    },
    request,
  );
  if (!persisted) {
    throw new Error("Canonical admin action audit could not be persisted");
  }
}

export async function auditCatalogActionResponseSafely(
  input: Parameters<typeof auditCatalogActionResponse>[0],
): Promise<boolean> {
  try {
    await auditCatalogActionResponse(input);
    return true;
  } catch (error) {
    logWorkerEvent({
      scope: "admin",
      level: "warn",
      event: "catalog_action_audit_failed",
      route: input.endpoint?.key,
      source: "admin_action_audit",
      message: "Catalog action audit failed after the route returned",
      error,
    });
    return false;
  }
}
