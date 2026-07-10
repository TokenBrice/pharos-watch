"use client";

import { useMemo, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type {
  ApiKeySelfServeAdminMutationResponse,
  ApiKeySelfServeRequestAdminSummary,
  ApiKeySelfServeStatus,
} from "@shared/types";
import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { postAdminJson } from "@/lib/admin-access";
import { cn } from "@/lib/utils";
import { useApiKeyRequests } from "@/hooks/use-api-key-requests";
import {
  API_KEY_REQUEST_ACTION_LABELS,
  API_KEY_REQUEST_STATUS_FILTERS,
  API_KEY_REQUEST_STATUS_LABELS,
  buildApiKeyRequestSummary,
  createApiKeyRequestIdempotencyKey,
  describeRequester,
} from "@/lib/api-key-request-admin-view-model";
import type { ApiKeyRequestAction } from "@/lib/api-key-request-admin-view-model";
import { ApiKeyRequestCard } from "./api-key-request-card";

const EMPTY_REQUESTS: readonly ApiKeySelfServeRequestAdminSummary[] = [];
const REQUEST_LIST_LIMIT = 50;

export function ApiKeyRequestsPanel() {
  const [statusFilter, setStatusFilter] = useState<"all" | ApiKeySelfServeStatus>("pending_verification");
  const { data, error, isLoading, refetch, isFetching } = useApiKeyRequests({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: REQUEST_LIST_LIMIT,
  });
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<{
    request: ApiKeySelfServeRequestAdminSummary;
    action: ApiKeyRequestAction;
    origin: HTMLElement | null;
  } | null>(null);
  const [reasonDraft, setReasonDraft] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const requests = data?.requests ?? EMPTY_REQUESTS;
  const generatedAt = data?.generatedAt ?? Math.floor(Date.now() / 1000);
  const requestSummary = useMemo(
    () => buildApiKeyRequestSummary(requests, generatedAt, statusFilter, REQUEST_LIST_LIMIT),
    [generatedAt, requests, statusFilter],
  );

  async function runMutation(request: ApiKeySelfServeRequestAdminSummary, action: ApiKeyRequestAction, reason: string) {
    setBusyRequestId(request.requestId);
    setMutationError(null);
    setMutationNotice(null);
    try {
      const path =
        action === "reject"
          ? API_PATHS.apiKeyRequestAdminReject(request.requestId)
          : API_PATHS.apiKeyRequestAdminReleaseClaim(request.requestId);
      const result = await postAdminJson<ApiKeySelfServeAdminMutationResponse>(
        path,
        { reason },
        { idempotencyKey: createApiKeyRequestIdempotencyKey(action, request.requestId) },
      );
      setMutationNotice(
        `Request marked ${API_KEY_REQUEST_STATUS_LABELS[result.status].toLowerCase()}; claim ${result.claimStatus ?? "none"}.`,
      );
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "API key request action failed");
    } finally {
      setBusyRequestId(null);
    }
  }

  function focusElement(element: HTMLElement | null) {
    queueMicrotask(() => {
      if (element?.isConnected) element.focus();
    });
  }

  function closePendingMutation() {
    const origin = pendingMutation?.origin ?? null;
    setPendingMutation(null);
    setReasonError(null);
    focusElement(origin);
  }

  function requestMutation(
    request: ApiKeySelfServeRequestAdminSummary,
    action: ApiKeyRequestAction,
    origin: HTMLElement | null,
  ) {
    setMutationError(null);
    setReasonDraft("");
    setReasonError(null);
    setPendingMutation({ request, action, origin });
  }

  function confirmPendingMutation() {
    if (!pendingMutation) return;
    const trimmed = reasonDraft.trim();
    if (trimmed.length < 4) {
      setReasonError("Enter a reason with at least 4 characters.");
      return;
    }
    const { request, action, origin } = pendingMutation;
    setPendingMutation(null);
    focusElement(origin);
    void runMutation(request, action, trimmed.slice(0, 300));
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Self-Serve API Requests</CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isLoading && !error ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Request triage summary">
            {requestSummary.map((item) => (
              <div key={item.label} className="border-y border-border/60 py-2">
                <div className="text-xs uppercase text-muted-foreground">{item.label}</div>
                <div className="mt-1 pharos-numeric text-xl font-semibold text-foreground">{item.value}</div>
                <div className="text-[11px] text-muted-foreground">{item.detail}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2" role="group" aria-label="Request status filter">
          {API_KEY_REQUEST_STATUS_FILTERS.map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              className="min-h-11"
              variant={statusFilter === status ? "default" : "outline"}
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {API_KEY_REQUEST_STATUS_LABELS[status]}
            </Button>
          ))}
        </div>

        {mutationNotice ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{mutationNotice}</p>
          </div>
        ) : null}

        {mutationError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-300"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{mutationError}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            Loading API key requests...
          </div>
        ) : null}

        {!isLoading && error ? (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-300"
          >
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
              <ApiKeyRequestCard
                key={request.requestId}
                request={request}
                generatedAt={generatedAt}
                busyRequestId={busyRequestId}
                onReject={(selectedRequest, origin) => requestMutation(selectedRequest, "reject", origin)}
                onReleaseClaim={(selectedRequest, origin) => requestMutation(selectedRequest, "release-claim", origin)}
              />
            ))}
          </div>
        ) : null}

        <Dialog
          open={pendingMutation != null}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              closePendingMutation();
            }
          }}
        >
          <DialogContent>
            {pendingMutation ? (
              <>
                <DialogHeader>
                  <DialogTitle>{API_KEY_REQUEST_ACTION_LABELS[pendingMutation.action]}</DialogTitle>
                  <DialogDescription>
                    Confirm {API_KEY_REQUEST_ACTION_LABELS[pendingMutation.action]} for{" "}
                    {describeRequester(pendingMutation.request)}. This changes self-serve API access state.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-1">
                  <label htmlFor="api-key-request-reason" className="text-xs font-medium text-muted-foreground">
                    Reason <span className="font-normal">(at least 4 characters)</span>
                  </label>
                  <Textarea
                    id="api-key-request-reason"
                    value={reasonDraft}
                    onChange={(e) => setReasonDraft(e.target.value)}
                    maxLength={300}
                    placeholder={`Reason for ${API_KEY_REQUEST_ACTION_LABELS[pendingMutation.action].toLowerCase()}`}
                    aria-invalid={reasonError != null}
                  />
                  {reasonError ? (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                      {reasonError}
                    </p>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button className="min-h-11" variant="outline" onClick={closePendingMutation}>
                    Cancel
                  </Button>
                  <Button className="min-h-11" variant="destructive" onClick={confirmPendingMutation}>
                    Confirm
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
