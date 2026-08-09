"use client";

import Link from "next/link";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { ApiKeyAuditEntry } from "@shared/types";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminActionAuditEntry } from "@/lib/actions-workbench-model";
import {
  buildOperationalActivityView,
  type OperationalActivityEntry,
  type OperationalActivitySource,
} from "@/lib/operational-history-model";
import { cn } from "@/lib/utils";
import { StatusPill } from "./severity-pill";

export interface OperationalActivitySourceState<TEntry> {
  entries: readonly TEntry[];
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  onRetry: () => void;
}

export interface OperationalActivityProps {
  adminActions: OperationalActivitySourceState<AdminActionAuditEntry>;
  credentialAudit: OperationalActivitySourceState<ApiKeyAuditEntry>;
  nowSeconds: number;
}

const SOURCE_LABELS: Record<OperationalActivitySource, string> = {
  "admin-action": "Admin action",
  "credential-audit": "Credential audit",
};

function sourceLabel(sources: readonly OperationalActivitySource[]): string {
  return sources.map((source) => SOURCE_LABELS[source]).join(" + ");
}

function outcomeClassName(outcome: OperationalActivityEntry["outcome"]): string {
  if (outcome === "error") return "bg-red-500/15 text-red-700 dark:text-red-300";
  if (outcome === "unknown") return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
  if (outcome === "ok") return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  return "bg-muted text-muted-foreground";
}

function SourceStatus<TEntry>({ label, state }: { label: string; state: OperationalActivitySourceState<TEntry> }) {
  const status = state.error
    ? "Unavailable"
    : state.isLoading && state.entries.length === 0
      ? "Loading"
      : state.entries.length === 0
        ? "No events"
        : `${state.entries.length} events`;
  return (
    <div className="min-w-0 space-y-2 border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">{label}</h4>
          <p className="text-xs text-muted-foreground">{status}</p>
        </div>
        {state.error ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={state.isFetching}
            aria-busy={state.isFetching}
            onClick={state.onRetry}
          >
            <RefreshCw className={state.isFetching ? "animate-spin" : ""} aria-hidden="true" />
            Retry {label.toLowerCase()}
          </Button>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="break-words text-xs text-red-700 dark:text-red-300">
          {state.error.message}
        </p>
      ) : null}
    </div>
  );
}

function ActivityRow({ entry, nowSeconds }: { entry: OperationalActivityEntry; nowSeconds: number }) {
  return (
    <li className="min-w-0 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{entry.actionLabel}</span>
            <StatusPill className={outcomeClassName(entry.outcome)}>
              {entry.outcome === "unknown" ? "Unknown" : entry.outcome}
            </StatusPill>
            <StatusPill className="bg-muted text-muted-foreground">{sourceLabel(entry.sources)}</StatusPill>
          </div>
          <dl className="grid min-w-0 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="inline font-medium text-foreground">Actor: </dt>
              <dd className="inline break-all">{entry.actors.length > 0 ? entry.actors.join(", ") : "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="inline font-medium text-foreground">Target: </dt>
              <dd className="inline break-all">{entry.target}</dd>
            </div>
            <div className="min-w-0">
              <dt className="inline font-medium text-foreground">Action code: </dt>
              <dd className="inline break-all font-mono">{entry.actionCode}</dd>
            </div>
            {entry.httpStatus != null ? (
              <div>
                <dt className="inline font-medium text-foreground">HTTP: </dt>
                <dd className="inline font-mono tabular-nums">{entry.httpStatus}</dd>
              </div>
            ) : null}
          </dl>
          {entry.detail != null ? (
            <details className="text-xs">
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
                Safe structured detail
              </summary>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Sensitive fields, assignments, and token-shaped values are redacted.
              </p>
              <pre className="mt-2 max-h-56 min-w-0 overflow-auto whitespace-pre-wrap break-all bg-muted/50 p-2 font-mono text-[11px] text-foreground">
                {JSON.stringify(entry.detail, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
        <div className="shrink-0 text-left text-xs text-muted-foreground lg:text-right">
          <p>{formatElapsedSeconds(Math.max(0, nowSeconds - entry.at))} ago</p>
          <time dateTime={new Date(entry.at * 1000).toISOString()} className="mt-1 block font-mono tabular-nums">
            {new Date(entry.at * 1000).toLocaleString()}
          </time>
        </div>
      </div>
    </li>
  );
}

export function OperationalActivity({ adminActions, credentialAudit, nowSeconds }: OperationalActivityProps) {
  const view = buildOperationalActivityView(adminActions.entries, credentialAudit.entries);
  const awaitingAnySource = view.entries.length === 0 && (adminActions.isLoading || credentialAudit.isLoading);
  const noAvailableEntries = view.entries.length === 0 && !awaitingAnySource;

  return (
    <section aria-labelledby="operational-activity-title" className="min-w-0 space-y-4 border-y border-border/60 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 id="operational-activity-title" className="text-base font-semibold text-foreground">
            Operational activity
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Persisted admin actions and credential lifecycle events in one read-only sequence. Coverage reflects audit
            rows emitted by the deployed backend and excludes browser-session-only results.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" className="min-h-11">
            <Link href="/admin/actions/">
              Actions workspace
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="min-h-11">
            <Link href="/admin-api/">
              API Management
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <SourceStatus label="Admin action log" state={adminActions} />
        <SourceStatus label="Credential audit" state={credentialAudit} />
      </div>

      {view.deduplicatedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {view.deduplicatedCount} cross-source lifecycle {view.deduplicatedCount === 1 ? "duplicate" : "duplicates"}{" "}
          reconciled.
        </p>
      ) : null}

      {awaitingAnySource ? (
        <p role="status" aria-live="polite" className="py-6 text-center text-sm text-muted-foreground">
          Loading operational activity...
        </p>
      ) : noAvailableEntries ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No persisted operational activity is available from the current source responses.
        </p>
      ) : (
        <ol
          className={cn(
            "divide-y divide-border/60",
            (adminActions.isFetching || credentialAudit.isFetching) && "opacity-80",
          )}
        >
          {view.entries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} nowSeconds={nowSeconds} />
          ))}
        </ol>
      )}
    </section>
  );
}
