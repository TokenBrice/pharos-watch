"use client";

import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { ApiKeyAuditEntry, ApiKeySummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { useApiKeyAuditLog } from "@/hooks/use-api-key-audit-log";
import { useApiKeys } from "@/hooks/use-api-keys";
import { isApiKeyExpiringSoon } from "@/lib/api-key-admin-view-model";
import { cn } from "@/lib/utils";

const AUDIT_ANOMALY_WINDOW_SEC = 7 * 24 * 60 * 60;

/** Lifecycle churn that warrants a look at the audit trail, not routine issuance. */
const AUDIT_ANOMALY_ACTIONS = new Set(["rotated", "deactivated"]);

export interface CredentialSummaryItem {
  label: string;
  value: string;
  detail: string;
  emphasisClassName?: string;
}

function countRecentAuditAnomalies(entries: readonly ApiKeyAuditEntry[], nowSeconds: number): number {
  return entries.filter(
    (entry) => AUDIT_ANOMALY_ACTIONS.has(entry.action) && entry.createdAt >= nowSeconds - AUDIT_ANOMALY_WINDOW_SEC,
  ).length;
}

/**
 * Same predicates as `buildApiKeyInventorySummary` (API Management), so the
 * Triage summary can never disagree with the lifecycle workbench counts.
 */
export function buildCredentialSummaryItems({
  keys,
  auditEntries,
  nowSeconds,
}: {
  keys: readonly ApiKeySummary[] | null;
  auditEntries: readonly ApiKeyAuditEntry[] | null;
  nowSeconds: number;
}): CredentialSummaryItem[] {
  let active = 0;
  let expiringSoon = 0;
  let expired = 0;
  let nonExpiring = 0;

  for (const key of keys ?? []) {
    if (key.isActive) active += 1;
    if (isApiKeyExpiringSoon(key, nowSeconds)) expiringSoon += 1;
    if (key.expiresAt != null && key.expiresAt <= nowSeconds) expired += 1;
    if (key.expiresAt == null) nonExpiring += 1;
  }

  const anomalies = auditEntries == null ? null : countRecentAuditAnomalies(auditEntries, nowSeconds);

  return [
    {
      label: "Active",
      value: keys == null ? "Unknown" : String(active),
      detail: keys == null ? "inventory not loaded" : `of ${keys.length} total keys`,
    },
    {
      label: "Expiring soon",
      value: keys == null ? "Unknown" : String(expiringSoon),
      detail: "active keys inside 7 days",
      emphasisClassName: expiringSoon > 0 ? "text-amber-700 dark:text-amber-300" : undefined,
    },
    {
      label: "Expired",
      value: keys == null ? "Unknown" : String(expired),
      detail: "needs rotation or deactivation",
      emphasisClassName: expired > 0 ? "text-red-700 dark:text-red-300" : undefined,
    },
    {
      label: "Non-expiring",
      value: keys == null ? "Unknown" : String(nonExpiring),
      detail: "explicit exceptions",
    },
    {
      label: "Audit anomalies",
      value: anomalies == null ? "Unknown" : String(anomalies),
      detail: "rotations and deactivations, 7 days",
      emphasisClassName: anomalies != null && anomalies > 0 ? "text-amber-700 dark:text-amber-300" : undefined,
    },
  ];
}

/**
 * Compact credential-lifecycle summary for the Triage workspace. Counts only:
 * the inventory rows, editors, and mutations stay in `/admin-api/` (plan
 * section 7.7). Missing evidence renders as Unknown, never zero.
 */
export function CredentialSummaryCard() {
  const inventory = useApiKeys();
  const auditLog = useApiKeyAuditLog("global");
  // The inventory's generatedAt anchors both expiry and anomaly windows;
  // without it the anomaly window has no trustworthy "now", so both surfaces
  // stay Unknown together instead of guessing from an impure render clock.
  const nowSeconds = inventory.data?.generatedAt ?? null;
  const items = buildCredentialSummaryItems({
    keys: inventory.data?.keys ?? null,
    auditEntries: nowSeconds == null ? null : (auditLog.data?.entries ?? null),
    nowSeconds: nowSeconds ?? 0,
  });

  return (
    <section aria-labelledby="credential-summary-title" className="rounded-xl border border-border/60 bg-background/35 p-4">
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

      {inventory.isLoading ? (
        <p role="status" aria-live="polite" className="mt-3 border-y border-border/60 py-3 text-sm text-muted-foreground">
          Loading credential summary...
        </p>
      ) : (
        <>
          {inventory.isError ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
              <span>Credential inventory could not be loaded; counts below are Unknown.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                onClick={() => void inventory.refetch()}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {items.map((item) => (
              <div key={item.label} className="min-w-0 border-y border-border/60 py-2">
                <div className="text-xs uppercase text-muted-foreground">{item.label}</div>
                <div className={cn("mt-1 pharos-numeric text-xl font-semibold text-foreground", item.emphasisClassName)}>
                  {item.value}
                </div>
                <div className="text-[11px] text-muted-foreground">{item.detail}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
