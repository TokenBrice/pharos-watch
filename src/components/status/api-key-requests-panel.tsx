"use client";

import { useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type {
  ApiKeySelfServeAdminMutationResponse,
  ApiKeySelfServeRequestAdminSummary,
  ApiKeySelfServeStatus,
} from "@shared/types";
import { AlertCircle, CheckCircle2, RefreshCw, ShieldOff, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildAdminApiPath } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApiKeyRequests } from "@/hooks/use-api-key-requests";

const STATUS_FILTERS: readonly ("all" | ApiKeySelfServeStatus)[] = [
  "all",
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
];

const STATUS_LABELS: Record<"all" | ApiKeySelfServeStatus, string> = {
  all: "All",
  pending_verification: "Pending",
  issued: "Issued",
  rejected: "Rejected",
  blocked: "Blocked",
  expired: "Expired",
};

const EMPTY_REQUESTS: readonly ApiKeySelfServeRequestAdminSummary[] = [];
const REQUEST_LIST_LIMIT = 50;
const ACTION_LABELS = {
  reject: "reject",
  "release-claim": "release claim",
} as const;

function statusClassName(status: ApiKeySelfServeStatus): string {
  switch (status) {
    case "issued":
      return "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
    case "pending_verification":
      return "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300";
    case "rejected":
    case "blocked":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "expired":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function formatTime(epochSeconds: number | null): string {
  if (epochSeconds == null) return "never";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatRelative(epochSeconds: number | null, nowSeconds: number): string {
  if (epochSeconds == null) return "never";
  const delta = epochSeconds - nowSeconds;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60);
  if (minutes < 90) {
    return delta >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  const hours = Math.round(abs / 3600);
  if (hours < 48) {
    return delta >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(abs / 86_400);
  return delta >= 0 ? `in ${days}d` : `${days}d ago`;
}

async function postAdminJson<T>(
  path: string,
  body: { reason: string },
  idempotencyKey: string,
): Promise<T> {
  const response = await fetch(buildRequestUrl(buildAdminApiPath(path)), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pharos-Admin": "1",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${response.status}: ${text}`;
    throw new Error(message);
  }
  return parsed as T;
}

function describeRequester(request: ApiKeySelfServeRequestAdminSummary): string {
  return request.organization || request.requesterName || "Unlabeled requester";
}

function createIdempotencyKey(action: "reject" | "release-claim", requestId: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `api-key-request:${action}:${requestId}:${randomPart}`;
}

function RequestCard({
  request,
  generatedAt,
  busyRequestId,
  onReject,
  onReleaseClaim,
}: {
  request: ApiKeySelfServeRequestAdminSummary;
  generatedAt: number;
  busyRequestId: string | null;
  onReject: (request: ApiKeySelfServeRequestAdminSummary) => void;
  onReleaseClaim: (request: ApiKeySelfServeRequestAdminSummary) => void;
}) {
  const busy = busyRequestId === request.requestId;
  const hasActiveUnexpiredKey =
    request.linkedKeyActive === true
    && (request.linkedKeyExpiresAt == null || request.linkedKeyExpiresAt > generatedAt);
  const canReleaseClaim = !hasActiveUnexpiredKey && request.claimStatus !== "released";
  const canReject = request.status === "pending_verification" || request.status === "issued";
  const requesterLabel = describeRequester(request);

  return (
    <article className="space-y-4 rounded-lg border border-border/60 bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", statusClassName(request.status))}>
              {STATUS_LABELS[request.status]}
            </span>
          </div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {requesterLabel}
          </h3>
          <p className="text-sm text-muted-foreground">
            Created {formatRelative(request.createdAt, generatedAt)} - Claim {request.claimStatus ?? "none"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !canReject}
            onClick={() => onReject(request)}
          >
            <ShieldOff className="h-4 w-4" aria-hidden="true" />
            Reject
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !canReleaseClaim}
            onClick={() => onReleaseClaim(request)}
          >
            <Unlock className="h-4 w-4" aria-hidden="true" />
            Release Claim
          </Button>
        </div>
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-muted-foreground">Cadence</div>
          <div className="font-medium text-foreground">{request.expectedCadence ?? "unknown"}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Volume</div>
          <div className="font-medium text-foreground">{request.expectedVolume ?? "not provided"}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Risk</div>
          <div className="font-medium text-foreground">{request.riskScore}</div>
        </div>
      </div>

      <details className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">Use case and endpoints</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{request.useCase}</p>
          <div className="flex flex-wrap gap-2">
            {request.intendedEndpoints.length > 0 ? request.intendedEndpoints.map((endpoint) => (
              <span key={endpoint} className="rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-xs text-muted-foreground">
                {endpoint}
              </span>
            )) : (
              <span className="text-xs text-muted-foreground">No endpoint list provided</span>
            )}
          </div>
        </div>
      </details>

      {request.riskReasons.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {request.riskReasons.map((reason) => (
            <span key={reason} className="rounded-md border border-amber-500/25 bg-amber-500/8 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      <details className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">Requester details</summary>
        <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <div>Email: <span className="break-all">{request.email}</span></div>
          <div>Name: {request.requesterName ?? "not provided"}</div>
          <div>Organization: {request.organization ?? "not provided"}</div>
          <div>Project: {request.projectUrl ?? "not provided"}</div>
          <div>Terms: {request.acceptedTerms ? "accepted" : "missing"}</div>
          <div>Email verified: {request.emailVerified ? "yes" : "no"}</div>
        </div>
      </details>

      <div className="grid gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
        <div>Created: {formatTime(request.createdAt)} ({formatRelative(request.createdAt, generatedAt)})</div>
        <div>Verification expires: {formatTime(request.verificationExpiresAt)}</div>
        <div>Issued: {formatTime(request.issuedAt)}</div>
        <div>Key: {request.linkedKeyPrefix ?? "none"}</div>
        <div>Claim: {request.claimStatus ?? "none"}</div>
        <div>Self-serve expiry: {formatTime(request.selfServeExpiresAt)}</div>
        <div>Updated: {formatTime(request.updatedAt)}</div>
        <div>Rejected: {formatTime(request.rejectedAt)}</div>
      </div>
    </article>
  );
}

export function ApiKeyRequestsPanel() {
  const [statusFilter, setStatusFilter] = useState<"all" | ApiKeySelfServeStatus>("all");
  const { data, error, isLoading, refetch, isFetching } = useApiKeyRequests({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: REQUEST_LIST_LIMIT,
  });
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);

  const requests = data?.requests ?? EMPTY_REQUESTS;
  const generatedAt = data?.generatedAt ?? Math.floor(Date.now() / 1000);

  function collectMutationReason(
    request: ApiKeySelfServeRequestAdminSummary,
    action: "reject" | "release-claim",
  ): string | null {
    const label = ACTION_LABELS[action];
    const confirmed = window.confirm(
      `Confirm ${label} for ${describeRequester(request)}. This changes self-serve API access state.`,
    );
    if (!confirmed) return null;

    const reason = window.prompt(`Reason for ${label}:`);
    if (reason == null) return null;

    const trimmed = reason.trim();
    if (trimmed.length < 4) {
      setMutationError("Action cancelled. Enter a reason with at least 4 characters.");
      return null;
    }
    return trimmed.slice(0, 300);
  }

  async function runMutation(
    request: ApiKeySelfServeRequestAdminSummary,
    action: "reject" | "release-claim",
    reason: string,
  ) {
    setBusyRequestId(request.requestId);
    setMutationError(null);
    setMutationNotice(null);
    try {
      const path = action === "reject"
        ? API_PATHS.apiKeyRequestAdminReject(request.requestId)
        : API_PATHS.apiKeyRequestAdminReleaseClaim(request.requestId);
      const result = await postAdminJson<ApiKeySelfServeAdminMutationResponse>(
        path,
        { reason },
        createIdempotencyKey(action, request.requestId),
      );
      setMutationNotice(`Request marked ${STATUS_LABELS[result.status].toLowerCase()}; claim ${result.claimStatus ?? "none"}.`);
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "API key request action failed");
    } finally {
      setBusyRequestId(null);
    }
  }

  function requestMutation(request: ApiKeySelfServeRequestAdminSummary, action: "reject" | "release-claim") {
    setMutationError(null);
    const reason = collectMutationReason(request, action);
    if (!reason) return;
    void runMutation(request, action, reason);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Self-Serve API Requests</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Request status filter">
          {STATUS_FILTERS.map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={statusFilter === status ? "default" : "outline"}
              onClick={() => setStatusFilter(status)}
            >
              {STATUS_LABELS[status]}
            </Button>
          ))}
        </div>

        {mutationNotice ? (
          <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{mutationNotice}</p>
          </div>
        ) : null}

        {mutationError ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{mutationError}</p>
          </div>
        ) : null}

        {isLoading ? <div className="text-sm text-muted-foreground">Loading API key requests...</div> : null}

        {!isLoading && error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-300">
            {error.message}
          </div>
        ) : null}

        {!isLoading && !error && requests.length === 0 ? (
          <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
            No self-serve API key requests match this filter.
          </div>
        ) : null}

        {!isLoading && !error && requests.length > 0 ? (
          <div className="space-y-3">
            {requests.map((request) => (
              <RequestCard
                key={request.requestId}
                request={request}
                generatedAt={generatedAt}
                busyRequestId={busyRequestId}
                onReject={(selectedRequest) => requestMutation(selectedRequest, "reject")}
                onReleaseClaim={(selectedRequest) => requestMutation(selectedRequest, "release-claim")}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
