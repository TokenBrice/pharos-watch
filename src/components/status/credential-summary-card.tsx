"use client";

import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { CredentialLifecycleSummaryResponse } from "@pharos/contracts/api-keys";
import { Button } from "@/components/ui/button";
import { useCredentialLifecycleSummary } from "@/hooks/admin-api-hooks";
import { cn } from "@/lib/utils";
import { CountValue, STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";

export interface CredentialSummaryItem {
  label: string;
  /** null = evidence missing; renders Unknown, never zero. */
  value: number | null;
  detail: string;
  /** Static text class for a positive count; zero stays muted. */
  tone?: string;
}

/**
 * Compact credential-lifecycle summary for the Triage workspace. Counts only:
 * the inventory rows, editors, and mutations stay in `/admin-api/` (plan
 * section 7.7). Missing evidence renders as Unknown, never zero. Expired keys
 * are neutral information: the summary does not say whether they are still
 * in use, so only expiring-soon keys and audit anomalies take a tone.
 */
function buildCredentialSummaryItemsFromResponse(
  summary: CredentialLifecycleSummaryResponse | undefined,
): CredentialSummaryItem[] {
  return [
    {
      label: "Active",
      value: summary?.active ?? null,
      detail: summary == null ? "inventory not loaded" : `of ${summary.totalKeys} total keys`,
    },
    {
      label: "Expiring soon",
      value: summary?.expiringSoon ?? null,
      detail: "active keys inside 7 days",
      tone: "text-state-warn",
    },
    {
      label: "Expired",
      value: summary?.expired ?? null,
      detail: "past their expiry date",
    },
    {
      label: "Non-expiring",
      value: summary?.nonExpiring ?? null,
      detail: "explicit exceptions",
    },
    {
      label: "Audit anomalies",
      value: summary?.auditAnomalies7d ?? null,
      detail: "rotations and deactivations, 7 days",
      tone: "text-state-warn",
    },
  ];
}

export function CredentialSummaryCard() {
  const summary = useCredentialLifecycleSummary();
  const items = buildCredentialSummaryItemsFromResponse(summary.data);

  return (
    <section aria-labelledby="credential-summary-title" className={cn("rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="credential-summary-title" className="text-sm font-semibold text-foreground">
            Credentials
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Lifecycle summary only. Rotation, deactivation, and issuance live in API Management.
          </p>
        </div>
        <Link
          href="/admin-api/"
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-foreground hover:bg-muted/50"
        >
          Open API Management
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>

      {summary.isLoading ? (
        <p role="status" aria-live="polite" className="mt-3 border-y border-border/60 py-3 text-sm text-muted-foreground">
          Loading credential summary...
        </p>
      ) : (
        <>
          {summary.isError ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-state-warn-solid/40 bg-state-warn-solid/[0.06] px-3 py-2 text-xs text-state-warn-ink">
              <span>Credential inventory could not be loaded; counts below are Unknown.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                onClick={() => void summary.refetch()}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {items.map((item) => (
              <div key={item.label} className="min-w-0 border-y border-border/60 py-2">
                <div className="pharos-label">{item.label}</div>
                <div className="mt-1 text-xl font-semibold">
                  {item.value == null ? (
                    <span className="text-muted-foreground">Unknown</span>
                  ) : (
                    <CountValue value={item.value} tone={item.tone} />
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{item.detail}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
