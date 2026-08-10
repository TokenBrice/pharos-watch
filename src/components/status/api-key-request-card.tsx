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
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";

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
    <article className={cn("space-y-4 rounded-lg p-4", STATUS_PANEL_SHELL_CLASS)}>
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

      <div className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-muted-foreground">Cadence</div>
          <div className="font-medium text-foreground">{request.expectedCadence ?? "unknown"}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Volume</div>
          <div className="font-medium text-foreground">{request.expectedVolume ?? "not provided"}</div>
        </div>
      </div>

      <details className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-foreground">
          Use case
        </summary>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{request.useCase}</p>
      </details>

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
          <div className="min-w-0">
            Project: <span className="break-all">{request.projectUrl ?? "not provided"}</span>
          </div>
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
