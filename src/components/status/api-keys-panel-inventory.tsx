"use client";

import type { ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import type {
  ApiKeyInventoryExpiryPreset,
  ApiKeyInventoryQuery,
  ApiKeyInventorySortDirection,
  ApiKeyInventorySortField,
  ApiKeyInventoryStatusFilter,
  ApiKeySummaryItem,
} from "@/lib/api-key-admin-view-model";
import { formatExpirySummary, isApiKeyExpiringSoon } from "@/lib/api-key-admin-view-model";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { FilterSelect, STATUS_FILTER_FIELD_CLASS, STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { StatusPill } from "./severity-pill";
import { cn } from "@/lib/utils";
import { apiKeyAccessibleIdentity } from "./api-key-presentation";
import { formatStatusTimestamp } from "@/lib/status/dashboard-presentation";
// The Sort control keeps the bare class: its `<select>` shares a flex row with
// the direction toggle rather than filling the label, so it is not a
// `FilterSelect`.

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

        <FilterSelect
          label="Status"
          value={status}
          onChange={(value) => onQueryChange({ status: value as ApiKeyInventoryStatusFilter })}
        >
          <option value="attention">Needs attention</option>
          <option value="all">All statuses</option>
          <option value="expired">Expired</option>
          <option value="expiring-soon">Expiring soon</option>
          <option value="inactive">Inactive</option>
          <option value="non-expiring">Non-expiring</option>
          <option value="active">Active</option>
        </FilterSelect>

        <FilterSelect
          label="Expiration"
          value={expiryPreset}
          onChange={(value) => onExpiryPresetChange(value as ApiKeyInventoryExpiryPreset)}
        >
          <option value="any">Any expiration</option>
          <option value="expired">Past due</option>
          <option value="next-7-days">Due in 7 days</option>
          <option value="next-30-days">Due in 30 days</option>
          <option value="after-30-days">After 30 days</option>
        </FilterSelect>

        <FilterSelect
          label="Owner filter"
          value={ownerValue}
          onChange={(value) =>
            onQueryChange({ owner: value === "" ? undefined : value === "__unassigned__" ? null : value })
          }
        >
          <option value="">All owners</option>
          {options.hasUnassignedOwner ? <option value="__unassigned__">Unassigned</option> : null}
          {options.owners.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect label="Tier filter" value={query.tier ?? ""} onChange={(value) => onQueryChange({ tier: value || undefined })}>
          <option value="">All tiers</option>
          {options.tiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          label="Traffic filter"
          value={query.trafficClass ?? ""}
          onChange={(value) => onQueryChange({ trafficClass: (value || undefined) as ApiKeyTrafficClass | undefined })}
        >
          <option value="">All traffic</option>
          <option value="external">External</option>
          <option value="site">Site</option>
        </FilterSelect>

        <label className="min-w-0 space-y-1 lg:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Sort</span>
          <span className="flex gap-2">
            <select
              className={STATUS_FILTER_FIELD_CLASS}
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
      className={cn("min-w-0 max-w-full overflow-hidden rounded-md", STATUS_PANEL_SHELL_CLASS)}
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
                <div>{formatStatusTimestamp(key.lastUsedAt, { fallback: "never" })}</div>
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
