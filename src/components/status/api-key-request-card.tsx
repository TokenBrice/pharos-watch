"use client";

import type { ApiKeySelfServeRequestAdminSummary } from "@shared/types";
import { ShieldOff, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  API_KEY_REQUEST_STATUS_LABELS,
  buildApiKeyRequestCardViewModel,
  formatApiKeyRequestRelativeTime,
  formatApiKeyRequestTime,
  statusClassName,
} from "@/lib/api-key-request-admin-view-model";

export function ApiKeyRequestCard({
  request,
  generatedAt,
  busyRequestId,
  onReject,
  onReleaseClaim,
}: {
  request: ApiKeySelfServeRequestAdminSummary;
  generatedAt: number;
  busyRequestId: string | null;
  onReject: (request: ApiKeySelfServeRequestAdminSummary, origin: HTMLButtonElement) => void;
  onReleaseClaim: (request: ApiKeySelfServeRequestAdminSummary, origin: HTMLButtonElement) => void;
}) {
  const viewModel = buildApiKeyRequestCardViewModel(request, generatedAt, busyRequestId);

  return (
    <article className="space-y-4 rounded-lg border border-border/60 bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                statusClassName(request.status),
              )}
            >
              {API_KEY_REQUEST_STATUS_LABELS[request.status]}
            </span>
          </div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">{viewModel.requesterLabel}</h3>
          <p className="text-sm text-muted-foreground">
            Created {formatApiKeyRequestRelativeTime(request.createdAt, generatedAt)} - Claim{" "}
            {request.claimStatus ?? "none"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            variant="outline"
            disabled={viewModel.busy || !viewModel.canReject}
            title={viewModel.canReject ? viewModel.rejectLabel : "Only pending or issued requests can be rejected."}
            onClick={(event) => onReject(request, event.currentTarget)}
          >
            <ShieldOff className="h-4 w-4" aria-hidden="true" />
            {viewModel.rejectLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            variant="outline"
            disabled={viewModel.busy || !viewModel.canReleaseClaim}
            title={viewModel.releaseClaimTitle}
            onClick={(event) => onReleaseClaim(request, event.currentTarget)}
          >
            <Unlock className="h-4 w-4" aria-hidden="true" />
            {viewModel.releaseClaimLabel}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
        <div className="text-xs uppercase text-muted-foreground">Next action</div>
        <p className="mt-1 text-sm leading-relaxed text-foreground">{viewModel.nextAction}</p>
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
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-foreground">
          Use case and endpoints
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{request.useCase}</p>
          <div className="flex flex-wrap gap-2">
            {request.intendedEndpoints.length > 0 ? (
              request.intendedEndpoints.map((endpoint) => (
                <span
                  key={endpoint}
                  className="rounded-md border border-border/60 bg-background px-2 py-1 font-mono tabular-nums text-xs text-muted-foreground"
                >
                  {endpoint}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No endpoint list provided</span>
            )}
          </div>
        </div>
      </details>

      {request.riskReasons.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {request.riskReasons.map((reason) => (
            <span
              key={reason}
              className="rounded-md border border-amber-500/25 bg-amber-500/8 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
            >
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      <details className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-foreground">
          Requester details
        </summary>
        <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <div>
            Email: <span className="break-all">{request.email}</span>
          </div>
          <div>Name: {request.requesterName ?? "not provided"}</div>
          <div>Organization: {request.organization ?? "not provided"}</div>
          <div>Project: {request.projectUrl ?? "not provided"}</div>
          <div>Terms: {request.acceptedTerms ? "accepted" : "missing"}</div>
          <div>Email verified: {request.emailVerified ? "yes" : "no"}</div>
        </div>
      </details>

      <div className="grid gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
        <div>
          Created: {formatApiKeyRequestTime(request.createdAt)} (
          {formatApiKeyRequestRelativeTime(request.createdAt, generatedAt)})
        </div>
        <div>Verification expires: {formatApiKeyRequestTime(request.verificationExpiresAt)}</div>
        <div>Issued: {formatApiKeyRequestTime(request.issuedAt)}</div>
        <div>Key: {request.linkedKeyPrefix ?? "none"}</div>
        <div>Claim: {request.claimStatus ?? "none"}</div>
        <div>Self-serve expiry: {formatApiKeyRequestTime(request.selfServeExpiresAt)}</div>
        <div>Updated: {formatApiKeyRequestTime(request.updatedAt)}</div>
        <div>Rejected: {formatApiKeyRequestTime(request.rejectedAt)}</div>
      </div>
    </article>
  );
}
