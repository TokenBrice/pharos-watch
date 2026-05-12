"use client";

import {
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import type { ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import type {
  ApiKeySummaryItem,
  CreateExpiryMode,
  CreateKeyState,
  EditableKeyState,
} from "@/lib/api-key-admin-view-model";
import {
  formatExpirySummary,
  isApiKeyExpiringSoon,
} from "@/lib/api-key-admin-view-model";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";

type CreateKeyPatch = Partial<CreateKeyState>;
type EditableKeyPatch = Partial<EditableKeyState>;

function fieldClassName() {
  return "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";
}

export function ApiKeyInventorySummary({ items }: { items: readonly ApiKeySummaryItem[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="API key inventory summary">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border/60 bg-background/35 px-3 py-2">
          <div className="text-xs uppercase text-muted-foreground">{item.label}</div>
          <div className="mt-1 font-mono text-xl font-semibold text-foreground">{item.value}</div>
          <div className="text-[11px] text-muted-foreground">{item.detail}</div>
        </div>
      ))}
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
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <input className={fieldClassName()} value={state.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Owner Email</span>
          <input className={fieldClassName()} value={state.ownerEmail} onChange={(event) => onChange({ ownerEmail: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Tier</span>
          <input className={fieldClassName()} value={state.tier} onChange={(event) => onChange({ tier: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Traffic Class</span>
          <select
            className={fieldClassName()}
            value={state.trafficClass}
            onChange={(event) => onChange({ trafficClass: event.target.value as ApiKeyTrafficClass })}
          >
            <option value="external">external</option>
            <option value="site">site</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Rate Limit / Minute</span>
          <input
            type="number"
            min={API_KEY_MIN_RATE_LIMIT_PER_MINUTE}
            max={API_KEY_MAX_RATE_LIMIT_PER_MINUTE}
            step={1}
            className={fieldClassName()}
            value={state.rateLimitPerMinute}
            onChange={(event) => onChange({ rateLimitPerMinute: event.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Expiry Policy</span>
          <select
            className={fieldClassName()}
            value={state.expiryMode}
            onChange={(event) => onChange({ expiryMode: event.target.value as CreateExpiryMode })}
          >
            <option value="default">Default 90 days</option>
            <option value="custom">Custom expiry</option>
            <option value="non-expiring">Non-expiring exception</option>
          </select>
        </label>
        {state.expiryMode === "custom" ? (
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Expires At</span>
            <input
              type="datetime-local"
              step={60}
              className={fieldClassName()}
              value={state.expiresAtInput}
              onChange={(event) => onChange({ expiresAtInput: event.target.value })}
            />
          </label>
        ) : null}
      </div>
      <div className="rounded-md border border-border/60 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
        {state.expiryMode === "default"
          ? "Default 90 days from creation. The request omits expiresAt and the worker applies the standard lifecycle."
          : state.expiryMode === "custom"
            ? "Custom expiry is converted from your local datetime to UTC epoch seconds before save."
            : "Non-expiring exception. Use only when lifecycle management is intentionally handled outside the default 90-day policy."}
      </div>
      <div className="flex justify-end">
        <Button onClick={onCreate} disabled={busy} aria-busy={busy}>
          {busy ? "Creating..." : "Create Key"}
        </Button>
      </div>
    </div>
  );
}

export function TokenRevealPanel({ revealedToken }: { revealedToken: { label: string; token: string } }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">{revealedToken.label}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Copy this token now. It will not be shown again after this page state is lost.
          </div>
        </div>
        <CopyButton
          text={revealedToken.token}
          className="border border-amber-500/30 bg-background/70 text-foreground hover:bg-background hover:text-foreground"
        />
      </div>
      <pre className="mt-3 overflow-auto rounded bg-background/80 p-3 text-xs">{revealedToken.token}</pre>
    </div>
  );
}

export function ApiKeyRowEditor({
  apiKey,
  draft,
  nowSeconds,
  isBusy,
  onDraftChange,
  onSave,
  onDeactivate,
  onRotate,
}: {
  apiKey: ApiKeySummary;
  draft: EditableKeyState;
  nowSeconds: number;
  isBusy: boolean;
  onDraftChange: (patch: EditableKeyPatch) => void;
  onSave: () => void;
  onDeactivate: () => void;
  onRotate: () => void;
}) {
  const keyStatus = getApiKeyStatus(apiKey, nowSeconds);
  const expiringSoon = isApiKeyExpiringSoon(apiKey, nowSeconds);

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">{apiKey.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{apiKey.maskedToken}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${apiKeyStatusBadgeClassName(keyStatus)}`}>
            {keyStatus}
          </span>
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
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <input className={fieldClassName()} value={draft.name} onChange={(event) => onDraftChange({ name: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Owner Email</span>
          <input className={fieldClassName()} value={draft.ownerEmail} onChange={(event) => onDraftChange({ ownerEmail: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Tier</span>
          <input className={fieldClassName()} value={draft.tier} onChange={(event) => onDraftChange({ tier: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Traffic Class</span>
          <select
            className={fieldClassName()}
            value={draft.trafficClass}
            onChange={(event) => onDraftChange({ trafficClass: event.target.value as ApiKeyTrafficClass })}
          >
            <option value="external">external</option>
            <option value="site">site</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Rate Limit / Minute</span>
          <input
            type="number"
            min={API_KEY_MIN_RATE_LIMIT_PER_MINUTE}
            max={API_KEY_MAX_RATE_LIMIT_PER_MINUTE}
            step={1}
            className={fieldClassName()}
            value={draft.rateLimitPerMinute}
            onChange={(event) => onDraftChange({ rateLimitPerMinute: event.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Expiry</span>
          <select
            className={fieldClassName()}
            value={draft.expiryMode}
            onChange={(event) => onDraftChange({ expiryMode: event.target.value as EditableKeyState["expiryMode"] })}
          >
            <option value="custom">Custom expiry</option>
            <option value="non-expiring">Non-expiring exception</option>
          </select>
        </label>
        {draft.expiryMode === "custom" ? (
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Expires At</span>
            <input
              type="datetime-local"
              step={60}
              className={fieldClassName()}
              value={draft.expiresAtInput}
              onChange={(event) => onDraftChange({ expiresAtInput: event.target.value })}
            />
          </label>
        ) : null}
      </div>

      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>Expiry: {formatExpirySummary(apiKey, nowSeconds)}</div>
        <div>Last used route: {apiKey.lastUsedRoute ?? "never"}</div>
        <div>Last used at: {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt * 1000).toISOString() : "never"}</div>
      </div>

      {draft.expiryMode === "non-expiring" ? (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
          Saving will persist <span className="font-mono">expiresAt: null</span> as an explicit non-expiring exception.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={isBusy} onClick={onSave}>
          {isBusy ? "Saving..." : "Save"}
        </Button>
        <Button size="sm" variant="outline" disabled={isBusy || !apiKey.isActive} onClick={onDeactivate}>
          Deactivate
        </Button>
        <Button size="sm" variant="outline" disabled={isBusy} onClick={onRotate}>
          Rotate
        </Button>
      </div>
    </div>
  );
}
