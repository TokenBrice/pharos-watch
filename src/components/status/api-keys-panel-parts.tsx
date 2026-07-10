"use client";

import { useState } from "react";
import { API_KEY_MAX_RATE_LIMIT_PER_MINUTE, API_KEY_MIN_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import type { ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import type { ApiKeySummaryItem, CreateKeyState, EditableKeyState } from "@/lib/api-key-admin-view-model";
import { formatExpirySummary, isApiKeyExpiringSoon } from "@/lib/api-key-admin-view-model";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { StatusPill } from "./severity-pill";

type CreateKeyPatch = Partial<CreateKeyState>;
type EditableKeyPatch = Partial<EditableKeyState>;

const FIELD_CLASS_NAME =
  "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";

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
        <input
          className={FIELD_CLASS_NAME}
          value={state.tier}
          onChange={(event) => onChange({ tier: event.target.value } as Partial<TState>)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Traffic Class</span>
        <select
          className={FIELD_CLASS_NAME}
          value={state.trafficClass}
          onChange={(event) => onChange({ trafficClass: event.target.value as ApiKeyTrafficClass } as Partial<TState>)}
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

export function ApiKeyInventorySummary({ items }: { items: readonly ApiKeySummaryItem[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="API key inventory summary">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border/60 bg-background/35 px-3 py-2">
          <div className="text-xs uppercase text-muted-foreground">{item.label}</div>
          <div className="mt-1 pharos-numeric text-xl font-semibold text-foreground">{item.value}</div>
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

export function TokenRevealDialog({
  revealedToken,
  onClose,
}: {
  revealedToken: {
    label: string;
    token: string;
    idempotencyKey: string;
    idempotentReplay: boolean | null;
    executionCertainty: string | null;
  };
  onClose: () => void;
}) {
  const [acknowledgement, setAcknowledgement] = useState<"copied" | "dismissed" | null>(null);
  const canClose = acknowledgement != null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && canClose) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (!canClose) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{revealedToken.label} one-time token</DialogTitle>
          <DialogDescription>
            This plaintext token will be removed from the page when you close this dialog and cannot be recovered.
          </DialogDescription>
        </DialogHeader>

        <div
          role="status"
          aria-live="assertive"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
        >
          {revealedToken.label}. The token is ready. Copy it to the approved credential store now.
        </div>

        <div className="flex items-start gap-2">
          <pre
            aria-label={`${revealedToken.label} plaintext token`}
            className="min-w-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs"
          >
            {revealedToken.token}
          </pre>
          <CopyButton
            text={revealedToken.token}
            className="border border-amber-500/30 bg-background text-foreground hover:bg-muted hover:text-foreground"
          />
        </div>

        <div className="font-mono text-[11px] text-muted-foreground">
          replay {revealedToken.idempotentReplay ? "yes" : "no"} · certainty{" "}
          {revealedToken.executionCertainty ?? "confirmed"} · intent {revealedToken.idempotencyKey}
        </div>

        <fieldset className="space-y-2 rounded-md border border-border/60 p-3">
          <legend className="px-1 text-xs font-medium text-foreground">Before closing</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="token-acknowledgement"
              checked={acknowledgement === "copied"}
              onChange={() => setAcknowledgement("copied")}
            />
            I copied this token to the approved credential store.
          </label>
          <label className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100">
            <input
              type="radio"
              name="token-acknowledgement"
              checked={acknowledgement === "dismissed"}
              onChange={() => setAcknowledgement("dismissed")}
            />
            I am intentionally dismissing this token without saving it and understand it will be lost.
          </label>
        </fieldset>

        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={!canClose}>
            {acknowledgement === "dismissed" ? "Dismiss token" : "Finish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TokenUnavailableReplayDialog({
  label,
  apiKey,
  recovery,
  idempotencyKey,
  idempotentReplay,
  executionCertainty,
  onRotate,
  onClose,
}: {
  label: string;
  apiKey: ApiKeySummary;
  recovery: string;
  idempotencyKey: string;
  idempotentReplay: boolean | null;
  executionCertainty: string | null;
  onRotate: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{label} confirmed; token unavailable</DialogTitle>
          <DialogDescription>
            The worker replay confirmed the credential mutation without persisting or returning its one-time secret.
          </DialogDescription>
        </DialogHeader>
        <div
          role="alert"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
        >
          <p className="font-medium">
            {apiKey.name} · ID {apiKey.id} · <span className="font-mono">{apiKey.maskedToken}</span>
          </p>
          <p className="mt-2">{recovery}</p>
          <p className="mt-2 font-mono text-[11px]">
            replay {idempotentReplay ? "yes" : "no"} · certainty {executionCertainty ?? "confirmed"} · intent{" "}
            {idempotencyKey}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="button" variant="destructive" onClick={onRotate}>
            Rotate {apiKey.name} (ID {apiKey.id}) now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function apiKeyAccessibleIdentity(apiKey: ApiKeySummary): string {
  return `${apiKey.name} (${apiKey.maskedToken}, ID ${apiKey.id})`;
}

export function ApiKeyTable({
  keys,
  nowSeconds,
  busyKeyId,
  editingKeyId,
  onEdit,
  onDeactivate,
  onRotate,
}: {
  keys: readonly ApiKeySummary[];
  nowSeconds: number;
  busyKeyId: number | null;
  editingKeyId: number | null;
  onEdit: (keyId: number) => void;
  onDeactivate: (apiKey: ApiKeySummary) => void;
  onRotate: (apiKey: ApiKeySummary) => void;
}) {
  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
        No API keys created yet.
      </div>
    );
  }

  return (
    <TableFrame
      tableId="api-keys"
      chrome="bare"
      className="overflow-hidden rounded-lg border border-border/60 bg-background/35"
      tableClassName="min-w-[68rem] border-collapse text-left text-xs"
    >
      <TableHeader className="border-b border-border/70 bg-muted/30 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead className="px-3 py-2 font-medium">Status</TableHead>
          <TableHead className="px-3 py-2 font-medium">Key</TableHead>
          <TableHead className="px-3 py-2 font-medium">Owner</TableHead>
          <TableHead className="px-3 py-2 font-medium">Tier</TableHead>
          <TableHead className="px-3 py-2 font-medium">Traffic</TableHead>
          <TableHead className="px-3 py-2 font-medium">Limit</TableHead>
          <TableHead className="px-3 py-2 font-medium">Expiry</TableHead>
          <TableHead className="px-3 py-2 font-medium">Last used</TableHead>
          <TableHead className="px-3 py-2 font-medium">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/55">
        {keys.map((key) => {
          const keyStatus = getApiKeyStatus(key, nowSeconds);
          const expiringSoon = isApiKeyExpiringSoon(key, nowSeconds);
          const isBusy = busyKeyId === key.id;
          const isEditing = editingKeyId === key.id;
          return (
            <TableRow key={key.id} className={isEditing ? "bg-primary/8" : "hover:bg-muted/25"}>
              <TableCell className="px-3 py-2 align-top">
                <div className="flex flex-wrap gap-1.5">
                  <StatusPill className={apiKeyStatusBadgeClassName(keyStatus)}>{keyStatus}</StatusPill>
                  {expiringSoon ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      expiring soon
                    </span>
                  ) : null}
                  {key.expiresAt == null ? (
                    <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      non-expiring exception
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="max-w-[15rem] px-3 py-2 align-top">
                <div className="truncate text-sm font-medium text-foreground">{key.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{key.maskedToken}</div>
              </TableCell>
              <TableCell className="px-3 py-2 align-top text-muted-foreground">{key.ownerEmail ?? "—"}</TableCell>
              <TableCell className="px-3 py-2 align-top font-mono text-muted-foreground">{key.tier}</TableCell>
              <TableCell className="px-3 py-2 align-top font-mono text-muted-foreground">{key.trafficClass}</TableCell>
              <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-foreground">
                {key.rateLimitPerMinute}/min
              </TableCell>
              <TableCell className="max-w-[16rem] px-3 py-2 align-top text-muted-foreground">
                {formatExpirySummary(key, nowSeconds)}
              </TableCell>
              <TableCell className="max-w-[14rem] px-3 py-2 align-top text-muted-foreground">
                <div>{key.lastUsedAt ? new Date(key.lastUsedAt * 1000).toLocaleString() : "never"}</div>
                <div className="truncate font-mono text-[11px]">{key.lastUsedRoute ?? "no route"}</div>
              </TableCell>
              <TableCell className="px-3 py-2 align-top">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={isEditing ? "default" : "outline"}
                    disabled={isBusy}
                    aria-label={`${isEditing ? "Close editor for" : "Edit"} ${apiKeyAccessibleIdentity(key)}`}
                    onClick={() => onEdit(key.id)}
                  >
                    {isEditing ? "Editing" : "Edit"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy || !key.isActive}
                    aria-label={`Deactivate ${apiKeyAccessibleIdentity(key)}`}
                    onClick={() => onDeactivate(key)}
                  >
                    Deactivate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy}
                    aria-label={`Rotate ${apiKeyAccessibleIdentity(key)}`}
                    onClick={() => onRotate(key)}
                  >
                    Rotate
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
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
          <div className="font-mono tabular-nums text-xs text-muted-foreground">{apiKey.maskedToken}</div>
        </div>
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
      </div>

      <ApiKeyEditableFields
        state={draft}
        onChange={onDraftChange}
        gridClassName="grid gap-3 lg:grid-cols-4"
        expiryLabel="Expiry"
        expiryOptions={[
          { value: "custom", label: "Custom expiry" },
          { value: "non-expiring", label: "Non-expiring exception" },
        ]}
      />

      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>Expiry: {formatExpirySummary(apiKey, nowSeconds)}</div>
        <div>Last used route: {apiKey.lastUsedRoute ?? "never"}</div>
        <div>Last used at: {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt * 1000).toISOString() : "never"}</div>
      </div>

      {draft.expiryMode === "non-expiring" ? (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
          Saving will persist <span className="font-mono tabular-nums">expiresAt: null</span> as an explicit
          non-expiring exception.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          aria-label={`Save changes to ${apiKeyAccessibleIdentity(apiKey)}`}
          onClick={onSave}
        >
          {isBusy ? "Saving..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy || !apiKey.isActive}
          aria-label={`Deactivate ${apiKeyAccessibleIdentity(apiKey)} from editor`}
          onClick={onDeactivate}
        >
          Deactivate
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          aria-label={`Rotate ${apiKeyAccessibleIdentity(apiKey)} from editor`}
          onClick={onRotate}
        >
          Rotate
        </Button>
      </div>
    </div>
  );
}
