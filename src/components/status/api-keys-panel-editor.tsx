"use client";

import { API_KEY_MAX_RATE_LIMIT_PER_MINUTE, API_KEY_MIN_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { API_KEY_TIER_VALUES } from "@shared/types/api-keys";
import type { ApiKeyAuditEntry, ApiKeySummary, ApiKeyTier } from "@shared/types";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CreateKeyState, EditableKeyState } from "@/lib/api-key-admin-view-model";
import { formatExpirySummary, isApiKeyExpiringSoon } from "@/lib/api-key-admin-view-model";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { StatusPill } from "./severity-pill";
import { cn } from "@/lib/utils";
import { apiKeyAccessibleIdentity } from "./api-key-presentation";

type CreateKeyPatch = Partial<CreateKeyState>;
type EditableKeyPatch = Partial<EditableKeyState>;

const FIELD_CLASS_NAME =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";
// The Sort control keeps the bare class: its `<select>` shares a flex row with
// the direction toggle rather than filling the label, so it is not a
// `FilterSelect`.

function ApiKeyEditableFields<TState extends CreateKeyState | EditableKeyState>({
  state,
  onChange,
  gridClassName,
  expiryLabel,
  expiryOptions,
}: {
  state: TState;
  onChange: (patch: Partial<TState>) => void;
  gridClassName: string;
  expiryLabel: string;
  expiryOptions: Array<{ value: TState["expiryMode"]; label: string }>;
}) {
  return (
    <div className={gridClassName}>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <input
          className={FIELD_CLASS_NAME}
          value={state.name}
          onChange={(event) => onChange({ name: event.target.value } as Partial<TState>)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Owner Email</span>
        <input
          className={FIELD_CLASS_NAME}
          value={state.ownerEmail}
          onChange={(event) => onChange({ ownerEmail: event.target.value } as Partial<TState>)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Tier</span>
        <select
          className={FIELD_CLASS_NAME}
          value={state.tier}
          onChange={(event) => onChange({ tier: event.target.value as ApiKeyTier } as Partial<TState>)}
        >
          {API_KEY_TIER_VALUES.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Rate Limit / Minute</span>
        <input
          type="number"
          min={API_KEY_MIN_RATE_LIMIT_PER_MINUTE}
          max={API_KEY_MAX_RATE_LIMIT_PER_MINUTE}
          step={1}
          className={FIELD_CLASS_NAME}
          value={state.rateLimitPerMinute}
          onChange={(event) => onChange({ rateLimitPerMinute: event.target.value } as Partial<TState>)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{expiryLabel}</span>
        <select
          className={FIELD_CLASS_NAME}
          value={state.expiryMode}
          onChange={(event) => onChange({ expiryMode: event.target.value as TState["expiryMode"] } as Partial<TState>)}
        >
          {expiryOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {state.expiryMode === "custom" ? (
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Expires At</span>
          <input
            type="datetime-local"
            step={60}
            className={FIELD_CLASS_NAME}
            value={state.expiresAtInput}
            onChange={(event) => onChange({ expiresAtInput: event.target.value } as Partial<TState>)}
          />
        </label>
      ) : null}
    </div>
  );
}

export function CreateApiKeyForm({
  busy,
  state,
  onChange,
  onCreate,
}: {
  busy: boolean;
  state: CreateKeyState;
  onChange: (patch: CreateKeyPatch) => void;
  onCreate: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-4">
      <div>
        <h3 className="text-sm font-medium">Create read key</h3>
        <p className="text-xs text-muted-foreground">
          Tokens are shown once. Store them outside Pharos after creation or rotation.
        </p>
      </div>
      <ApiKeyEditableFields
        state={state}
        onChange={onChange}
        gridClassName="grid gap-3 lg:grid-cols-3"
        expiryLabel="Expiry Policy"
        expiryOptions={[
          { value: "default", label: "Default 90 days" },
          { value: "custom", label: "Custom expiry" },
          { value: "non-expiring", label: "Non-expiring exception" },
        ]}
      />
      <div className={cn("rounded-md px-3 py-2 text-xs text-muted-foreground", STATUS_PANEL_SHELL_CLASS)}>
        {state.expiryMode === "default"
          ? "Default 90 days from creation. The request omits expiresAt and the worker applies the standard lifecycle."
          : state.expiryMode === "custom"
            ? "Custom expiry is converted from your local datetime to UTC epoch seconds before save."
            : "Non-expiring exception. Use only when lifecycle management is intentionally handled outside the default 90-day policy."}
      </div>
      <div className="flex justify-end">
        <Button className="min-h-11" onClick={onCreate} disabled={busy} aria-busy={busy}>
          {busy ? "Creating..." : "Create Key"}
        </Button>
      </div>
    </div>
  );
}

function formatAuditAction(action: string): string {
  const words = action.replaceAll("_", " ").replaceAll("-", " ");
  return words.length === 0 ? "Unknown action" : `${words[0].toUpperCase()}${words.slice(1)}`;
}

function ApiKeyAuditHistory({
  entries,
  error,
  isLoading,
  isFetching,
  onRetry,
}: {
  entries: readonly ApiKeyAuditEntry[];
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="api-key-audit-history-title"
      className="min-w-0 space-y-3 xl:border-l xl:border-border/60 xl:pl-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 id="api-key-audit-history-title" className="text-sm font-semibold text-foreground">
            Audit history
          </h4>
          <p className="text-xs text-muted-foreground">Latest 50 lifecycle events for this key.</p>
        </div>
        {!isLoading && !error ? (
          <Button
            type="button"
            size="icon-sm"
            className="size-11"
            variant="ghost"
            disabled={isFetching}
            aria-label="Refresh API key audit history"
            title="Refresh audit history"
            onClick={onRetry}
          >
            <RefreshCw className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Loading audit history...
        </p>
      ) : null}
      {!isLoading && error ? (
        <div
          role="alert"
          className="space-y-3 border-l-2 border-red-500/60 pl-3 text-sm text-red-700 dark:text-red-400"
        >
          <div>
            <p className="font-medium">Audit history unavailable</p>
            <p className="break-words text-xs">{error.message}</p>
          </div>
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            variant="outline"
            disabled={isFetching}
            aria-busy={isFetching}
            onClick={onRetry}
          >
            <RefreshCw className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
            Retry audit history
          </Button>
        </div>
      ) : null}
      {!isLoading && !error && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit events recorded for this key.</p>
      ) : null}
      {!isLoading && !error && entries.length > 0 ? (
        <ol
          className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto border-y border-border/60"
          aria-busy={isFetching}
        >
          {entries.map((entry) => (
            <li key={entry.id} className="min-w-0 py-3 first:pt-2 last:pb-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-foreground">{formatAuditAction(entry.action)}</span>
                <time
                  dateTime={new Date(entry.createdAt * 1000).toISOString()}
                  className="font-mono text-[11px] tabular-nums text-muted-foreground"
                >
                  {new Date(entry.createdAt * 1000).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Actor: {entry.actor}</p>
              {entry.detail != null ? (
                <details className="mt-2 text-xs">
                  <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
                    Event detail
                  </summary>
                  <pre className="mt-2 max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-all bg-muted/50 p-2 font-mono text-[11px] text-foreground">
                    {JSON.stringify(entry.detail, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function ApiKeyDetailEditor({
  apiKey,
  draft,
  nowSeconds,
  isBusy,
  auditEntries,
  auditError,
  auditLoading,
  auditFetching,
  onDraftChange,
  onSave,
  onDeactivate,
  onRotate,
  onClose,
  onRetryAudit,
}: {
  apiKey: ApiKeySummary;
  draft: EditableKeyState;
  nowSeconds: number;
  isBusy: boolean;
  auditEntries: readonly ApiKeyAuditEntry[];
  auditError: Error | null;
  auditLoading: boolean;
  auditFetching: boolean;
  onDraftChange: (patch: EditableKeyPatch) => void;
  onSave: () => void;
  onDeactivate: () => void;
  onRotate: () => void;
  onClose: () => void;
  onRetryAudit: () => void;
}) {
  const keyStatus = getApiKeyStatus(apiKey, nowSeconds);
  const expiringSoon = isApiKeyExpiringSoon(apiKey, nowSeconds);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`api-key-detail-${apiKey.id}`} className="text-base font-semibold text-foreground">
            {apiKey.name}
          </h3>
          <div className="font-mono tabular-nums text-xs text-muted-foreground">{apiKey.maskedToken}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2">
            <StatusPill className={apiKeyStatusBadgeClassName(keyStatus)}>{keyStatus}</StatusPill>
            {expiringSoon ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                expiring soon
              </span>
            ) : null}
            {apiKey.expiresAt == null ? (
              <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                non-expiring exception
              </span>
            ) : null}
          </div>
          <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={onClose}>
            <X aria-hidden="true" />
            Close details
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.8fr)]">
        <div className="min-w-0 space-y-4">
          <ApiKeyEditableFields
            state={draft}
            onChange={onDraftChange}
            gridClassName="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            expiryLabel="Expiry"
            expiryOptions={[
              { value: "custom", label: "Custom expiry" },
              { value: "non-expiring", label: "Non-expiring exception" },
            ]}
          />

          <dl className="grid gap-x-4 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="font-medium text-foreground">Current expiry</dt>
              <dd className="break-words">{formatExpirySummary(apiKey, nowSeconds)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-medium text-foreground">Last used route</dt>
              <dd className="break-all font-mono">{apiKey.lastUsedRoute ?? "never"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-medium text-foreground">Last used at</dt>
              <dd className="break-words font-mono">
                {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt * 1000).toISOString() : "never"}
              </dd>
            </div>
          </dl>

          {draft.expiryMode === "non-expiring" ? (
            <div className="border-l-2 border-amber-500/60 pl-3 text-xs text-muted-foreground">
              Saving will persist <span className="font-mono tabular-nums">expiresAt: null</span> as an explicit
              non-expiring exception.
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
            <Button
              size="sm"
              className="min-h-11"
              variant="outline"
              disabled={isBusy}
              aria-label={`Save changes to ${apiKeyAccessibleIdentity(apiKey)}`}
              onClick={onSave}
            >
              {isBusy ? "Saving..." : "Save"}
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              variant="outline"
              disabled={isBusy || !apiKey.isActive}
              aria-label={`Deactivate ${apiKeyAccessibleIdentity(apiKey)} from editor`}
              onClick={onDeactivate}
            >
              Deactivate
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              variant="outline"
              disabled={isBusy}
              aria-label={`Rotate ${apiKeyAccessibleIdentity(apiKey)} from editor`}
              onClick={onRotate}
            >
              Rotate
            </Button>
          </div>
        </div>
        <ApiKeyAuditHistory
          entries={auditEntries}
          error={auditError}
          isLoading={auditLoading}
          isFetching={auditFetching}
          onRetry={onRetryAudit}
        />
      </div>
    </div>
  );
}
