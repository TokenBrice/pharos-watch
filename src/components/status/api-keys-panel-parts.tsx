"use client";

import { useState } from "react";
import { API_KEY_MAX_RATE_LIMIT_PER_MINUTE, API_KEY_MIN_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import type { ApiKeyAuditEntry, ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Search, X } from "lucide-react";
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
import type {
  ApiKeyInventoryExpiryPreset,
  ApiKeyInventoryQuery,
  ApiKeyInventorySortDirection,
  ApiKeyInventorySortField,
  ApiKeyInventoryStatusFilter,
  ApiKeySummaryItem,
  CreateKeyState,
  EditableKeyState,
} from "@/lib/api-key-admin-view-model";
import { formatExpirySummary, isApiKeyExpiringSoon } from "@/lib/api-key-admin-view-model";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { StatusPill } from "./severity-pill";

type CreateKeyPatch = Partial<CreateKeyState>;
type EditableKeyPatch = Partial<EditableKeyState>;

const FIELD_CLASS_NAME =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";
const FILTER_FIELD_CLASS_NAME =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

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
    <div role="group" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="API key inventory summary">
      {items.map((item) => (
        <div key={item.label} className="border-y border-border/60 py-2">
          <div className="text-xs uppercase text-muted-foreground">{item.label}</div>
          <div className="mt-1 pharos-numeric text-xl font-semibold text-foreground">{item.value}</div>
          <div className="text-[11px] text-muted-foreground">{item.detail}</div>
        </div>
      ))}
    </div>
  );
}

export interface ApiKeyInventoryFilterOptions {
  owners: readonly string[];
  hasUnassignedOwner: boolean;
  tiers: readonly string[];
}

export function ApiKeyInventoryControls({
  query,
  expiryPreset,
  options,
  onQueryChange,
  onExpiryPresetChange,
  onReset,
}: {
  query: ApiKeyInventoryQuery;
  expiryPreset: ApiKeyInventoryExpiryPreset;
  options: ApiKeyInventoryFilterOptions;
  onQueryChange: (patch: Partial<ApiKeyInventoryQuery>) => void;
  onExpiryPresetChange: (preset: ApiKeyInventoryExpiryPreset) => void;
  onReset: () => void;
}) {
  const status = query.status ?? "attention";
  const sort = query.sort ?? { field: "status", direction: "asc" };
  const ownerValue = query.owner === undefined ? "" : (query.owner ?? "__unassigned__");

  return (
    <div role="group" className="space-y-3 border-y border-border/60 py-3" aria-label="API key inventory controls">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <label className="min-w-0 space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Search keys</span>
          <span className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              className="h-11 w-full rounded-md border border-input bg-background px-2.5 pl-9 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              value={query.search ?? ""}
              placeholder="Name, owner, prefix, tier, or route"
              onChange={(event) => onQueryChange({ search: event.target.value })}
            />
          </span>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <select
            className={FILTER_FIELD_CLASS_NAME}
            value={status}
            onChange={(event) => onQueryChange({ status: event.target.value as ApiKeyInventoryStatusFilter })}
          >
            <option value="attention">Needs attention</option>
            <option value="all">All statuses</option>
            <option value="expired">Expired</option>
            <option value="expiring-soon">Expiring soon</option>
            <option value="inactive">Inactive</option>
            <option value="non-expiring">Non-expiring</option>
            <option value="active">Active</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Expiration</span>
          <select
            className={FILTER_FIELD_CLASS_NAME}
            value={expiryPreset}
            onChange={(event) => onExpiryPresetChange(event.target.value as ApiKeyInventoryExpiryPreset)}
          >
            <option value="any">Any expiration</option>
            <option value="expired">Past due</option>
            <option value="next-7-days">Due in 7 days</option>
            <option value="next-30-days">Due in 30 days</option>
            <option value="after-30-days">After 30 days</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Owner filter</span>
          <select
            className={FILTER_FIELD_CLASS_NAME}
            value={ownerValue}
            onChange={(event) =>
              onQueryChange({
                owner:
                  event.target.value === ""
                    ? undefined
                    : event.target.value === "__unassigned__"
                      ? null
                      : event.target.value,
              })
            }
          >
            <option value="">All owners</option>
            {options.hasUnassignedOwner ? <option value="__unassigned__">Unassigned</option> : null}
            {options.owners.map((owner) => (
              <option key={owner} value={owner}>
                {owner}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Tier filter</span>
          <select
            className={FILTER_FIELD_CLASS_NAME}
            value={query.tier ?? ""}
            onChange={(event) => onQueryChange({ tier: event.target.value || undefined })}
          >
            <option value="">All tiers</option>
            {options.tiers.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Traffic filter</span>
          <select
            className={FILTER_FIELD_CLASS_NAME}
            value={query.trafficClass ?? ""}
            onChange={(event) =>
              onQueryChange({ trafficClass: (event.target.value || undefined) as ApiKeyTrafficClass | undefined })
            }
          >
            <option value="">All traffic</option>
            <option value="external">External</option>
            <option value="site">Site</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1 lg:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Sort</span>
          <span className="flex gap-2">
            <select
              className={FILTER_FIELD_CLASS_NAME}
              value={sort.field}
              onChange={(event) =>
                onQueryChange({
                  sort: { ...sort, field: event.target.value as ApiKeyInventorySortField },
                })
              }
            >
              <option value="status">Status</option>
              <option value="expiry">Expiry</option>
              <option value="last-use">Last use</option>
              <option value="rate-limit">Rate limit</option>
              <option value="name">Name</option>
            </select>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              className="size-11 shrink-0"
              aria-label={`Sort ${sort.direction === "asc" ? "descending" : "ascending"}`}
              title={`Sort ${sort.direction === "asc" ? "descending" : "ascending"}`}
              onClick={() =>
                onQueryChange({
                  sort: {
                    ...sort,
                    direction: (sort.direction === "asc" ? "desc" : "asc") as ApiKeyInventorySortDirection,
                  },
                })
              }
            >
              {sort.direction === "asc" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
            </Button>
          </span>
        </label>

        <div className="flex items-end lg:col-span-2 xl:col-span-3">
          <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={onReset}>
            <RotateCcw aria-hidden="true" />
            Reset view
          </Button>
        </div>
      </div>
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
        <Button className="min-h-11" onClick={onCreate} disabled={busy} aria-busy={busy}>
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
            className="size-11 border border-amber-500/30 bg-background text-foreground hover:bg-muted hover:text-foreground"
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
          <Button type="button" className="min-h-11" onClick={onClose} disabled={!canClose}>
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
          <Button type="button" className="min-h-11" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="button" className="min-h-11" variant="destructive" onClick={onRotate}>
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

export function ApiKeyInventoryPagination({
  page,
  pageSize,
  totalPages,
  totalItems,
  totalInventoryItems,
  firstItemNumber,
  lastItemNumber,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  totalInventoryItems: number;
  firstItemNumber: number;
  lastItemNumber: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <nav
      aria-label="API key inventory pagination"
      className="flex flex-col gap-3 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing{" "}
        <span className="font-mono tabular-nums">
          {firstItemNumber}-{lastItemNumber}
        </span>{" "}
        of <span className="font-mono tabular-nums">{totalItems}</span> matching keys
        {totalItems !== totalInventoryItems ? ` (${totalInventoryItems} total)` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Rows
          <select
            className="h-11 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <span className="min-w-20 text-center font-mono text-xs tabular-nums text-muted-foreground">
          Page {page} / {totalPages}
        </span>
        <Button
          type="button"
          size="icon-sm"
          className="size-11"
          variant="outline"
          disabled={page <= 1}
          aria-label="Go to previous API key page"
          title="Previous page"
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          className="size-11"
          variant="outline"
          disabled={page >= totalPages}
          aria-label="Go to next API key page"
          title="Next page"
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

export function ApiKeyTable({
  keys,
  nowSeconds,
  busyKeyId,
  selectedKeyId,
  emptyMessage,
  onSelect,
  onDeactivate,
  onRotate,
}: {
  keys: readonly ApiKeySummary[];
  nowSeconds: number;
  busyKeyId: number | null;
  selectedKeyId: number | null;
  emptyMessage: string;
  onSelect: (apiKey: ApiKeySummary, origin: HTMLButtonElement) => void;
  onDeactivate: (apiKey: ApiKeySummary) => void;
  onRotate: (apiKey: ApiKeySummary) => void;
}) {
  if (keys.length === 0) {
    return (
      <div className="border-y border-border/60 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
    );
  }

  return (
    <TableFrame
      tableId="api-keys"
      chrome="bare"
      stickyHeader
      className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/60 bg-background/35"
      viewportClassName="max-h-[34rem]"
      viewportProps={{ vertical: true }}
      tableProps={{ "aria-label": "API key inventory" }}
      tableClassName="min-w-[76rem] border-collapse text-left text-xs"
    >
      <TableHeader className="border-b border-border/70 bg-muted text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead className="px-3 py-2 font-medium">Status</TableHead>
          <TableHead className="px-3 py-2 font-medium">Key</TableHead>
          <TableHead className="px-3 py-2 font-medium">Owner</TableHead>
          <TableHead className="px-3 py-2 font-medium">Tier</TableHead>
          <TableHead className="px-3 py-2 font-medium">Traffic</TableHead>
          <TableHead className="px-3 py-2 font-medium">Limit</TableHead>
          <TableHead className="px-3 py-2 font-medium">Expiry</TableHead>
          <TableHead className="px-3 py-2 font-medium">Last used</TableHead>
          <TableHead className="sticky right-0 z-20 border-l border-border/70 bg-muted px-3 py-2 font-medium shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/55">
        {keys.map((key) => {
          const keyStatus = getApiKeyStatus(key, nowSeconds);
          const expiringSoon = isApiKeyExpiringSoon(key, nowSeconds);
          const isBusy = busyKeyId === key.id;
          const isSelected = selectedKeyId === key.id;
          return (
            <TableRow
              key={key.id}
              rowIntent="scan"
              aria-selected={isSelected}
              data-state={isSelected ? "selected" : undefined}
              className={isSelected ? "bg-primary/8" : "hover:bg-muted/25"}
            >
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
                {isSelected ? <span className="sr-only">Selected for details</span> : null}
              </TableCell>
              <TableCell className="max-w-[15rem] px-3 py-2 align-top text-muted-foreground">
                <div className="truncate">{key.ownerEmail ?? "Unassigned"}</div>
              </TableCell>
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
              <TableCell
                className={
                  isSelected
                    ? "sticky right-0 z-[5] border-l border-border/70 bg-muted px-3 py-2 align-top shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]"
                    : "sticky right-0 z-[5] border-l border-border/70 bg-background px-3 py-2 align-top shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]"
                }
              >
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="min-h-11"
                    variant={isSelected ? "default" : "outline"}
                    disabled={isBusy}
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? `api-key-detail-panel-${key.id}` : undefined}
                    aria-label={`${isSelected ? "Close details for" : "Edit"} ${apiKeyAccessibleIdentity(key)}`}
                    onClick={(event) => onSelect(key, event.currentTarget)}
                  >
                    {isSelected ? "Selected" : "Edit"}
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11"
                    variant="outline"
                    disabled={isBusy || !key.isActive}
                    aria-label={`Deactivate ${apiKeyAccessibleIdentity(key)}`}
                    onClick={() => onDeactivate(key)}
                  >
                    Deactivate
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11"
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
