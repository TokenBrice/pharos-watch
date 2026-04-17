"use client";

import { useMemo, useState } from "react";
import { formatElapsedSeconds } from "@shared/lib/format";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import type {
  ApiKeyCreateResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
  ApiKeySummary,
  ApiKeyTrafficClass,
} from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildAdminApiPath } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { useApiKeys } from "@/hooks/use-api-keys";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";

interface EditableKeyState {
  name: string;
  ownerEmail: string;
  tier: string;
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: string;
  expiryMode: "custom" | "non-expiring";
  expiresAtInput: string;
}

type CreateExpiryMode = "default" | "custom" | "non-expiring";

const EMPTY_KEYS: readonly ApiKeySummary[] = [];
const API_KEY_EXPIRING_SOON_WINDOW_SEC = WEEK_SECONDS;
const API_KEY_MIN_RATE_LIMIT_PER_MINUTE = 1;
const API_KEY_MAX_RATE_LIMIT_PER_MINUTE = 10_000;

function buildEditableState(key: ApiKeySummary): EditableKeyState {
  return {
    name: key.name,
    ownerEmail: key.ownerEmail ?? "",
    tier: key.tier,
    trafficClass: key.trafficClass,
    rateLimitPerMinute: String(key.rateLimitPerMinute),
    expiryMode: key.expiresAt == null ? "non-expiring" : "custom",
    expiresAtInput: key.expiresAt == null ? "" : formatDateTimeLocalValue(key.expiresAt),
  };
}

function fieldClassName() {
  return "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTimeLocalValue(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}T${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function parseDateTimeLocalValue(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match;
  const epochMs = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  ).getTime();
  return Number.isFinite(epochMs) ? Math.floor(epochMs / 1000) : null;
}

function parseRateLimitInput(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Rate limit must be a whole number");
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < API_KEY_MIN_RATE_LIMIT_PER_MINUTE ||
    parsed > API_KEY_MAX_RATE_LIMIT_PER_MINUTE
  ) {
    throw new Error(
      `Rate limit must be between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
    );
  }
  return parsed;
}

function isExpiringSoon(key: ApiKeySummary, nowSeconds: number): boolean {
  return key.isActive
    && key.expiresAt != null
    && key.expiresAt > nowSeconds
    && key.expiresAt - nowSeconds <= API_KEY_EXPIRING_SOON_WINDOW_SEC;
}

function formatExpirySummary(key: ApiKeySummary, nowSeconds: number): string {
  if (key.expiresAt == null) {
    return "Non-expiring exception";
  }
  const absolute = new Date(key.expiresAt * 1000).toLocaleString();
  if (key.expiresAt <= nowSeconds) {
    return `Expired ${formatElapsedSeconds(nowSeconds - key.expiresAt)} ago at ${absolute}`;
  }
  return `Expires ${absolute} (${formatElapsedSeconds(key.expiresAt - nowSeconds)} remaining)`;
}

async function postAdminJson<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(buildRequestUrl(buildAdminApiPath(path)), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pharos-Admin": "1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${response.status}: ${text}`;
    throw new Error(message);
  }

  return parsed as T;
}

export function ApiKeysPanel() {
  const { data, error, isLoading, refetch } = useApiKeys();
  const [createName, setCreateName] = useState("");
  const [createOwnerEmail, setCreateOwnerEmail] = useState("");
  const [createTier, setCreateTier] = useState("standard");
  const [createTrafficClass, setCreateTrafficClass] = useState<ApiKeyTrafficClass>("external");
  const [createRateLimit, setCreateRateLimit] = useState("120");
  const [createExpiryMode, setCreateExpiryMode] = useState<CreateExpiryMode>("default");
  const [createExpiresAtInput, setCreateExpiresAtInput] = useState("");
  const [drafts, setDrafts] = useState<Record<number, EditableKeyState>>({});
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{ label: string; token: string } | null>(null);

  const keys = data?.keys ?? EMPTY_KEYS;
  const nowSeconds = data?.generatedAt ?? Math.floor(Date.now() / 1000);
  const draftState = useMemo(() => {
    const next: Record<number, EditableKeyState> = {};
    for (const key of keys) {
      next[key.id] = drafts[key.id] ?? buildEditableState(key);
    }
    return next;
  }, [drafts, keys]);

  async function runKeyAction(action: () => Promise<void>, keyId?: number) {
    setErrorMessage(null);
    if (keyId != null) {
      setBusyKeyId(keyId);
    }
    try {
      await action();
      await refetch();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleCreate() {
    setErrorMessage(null);
    setCreateBusy(true);
    try {
      const createPayload: Record<string, unknown> = {
        name: createName,
        ownerEmail: createOwnerEmail || null,
        tier: createTier,
        trafficClass: createTrafficClass,
        rateLimitPerMinute: parseRateLimitInput(createRateLimit),
      };
      if (createExpiryMode === "custom") {
        const parsedExpiry = parseDateTimeLocalValue(createExpiresAtInput);
        if (parsedExpiry == null) {
          throw new Error("Custom expiry requires a valid date and time");
        }
        createPayload.expiresAt = parsedExpiry;
      } else if (createExpiryMode === "non-expiring") {
        createPayload.expiresAt = null;
      }

      const response = await postAdminJson<ApiKeyCreateResponse>("/api/api-keys", {
        ...createPayload,
      });
      setRevealedToken({ label: `Created ${response.key.name}`, token: response.token });
      setCreateName("");
      setCreateOwnerEmail("");
      setCreateTier("standard");
      setCreateTrafficClass("external");
      setCreateRateLimit("120");
      setCreateExpiryMode("default");
      setCreateExpiresAtInput("");
      await refetch();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">API Keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
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
              <input className={fieldClassName()} value={createName} onChange={(event) => setCreateName(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Owner Email</span>
              <input className={fieldClassName()} value={createOwnerEmail} onChange={(event) => setCreateOwnerEmail(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Tier</span>
              <input className={fieldClassName()} value={createTier} onChange={(event) => setCreateTier(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Traffic Class</span>
              <select className={fieldClassName()} value={createTrafficClass} onChange={(event) => setCreateTrafficClass(event.target.value as ApiKeyTrafficClass)}>
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
                value={createRateLimit}
                onChange={(event) => setCreateRateLimit(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Expiry Policy</span>
              <select className={fieldClassName()} value={createExpiryMode} onChange={(event) => setCreateExpiryMode(event.target.value as CreateExpiryMode)}>
                <option value="default">Default 90 days</option>
                <option value="custom">Custom expiry</option>
                <option value="non-expiring">Non-expiring exception</option>
              </select>
            </label>
            {createExpiryMode === "custom" && (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Expires At</span>
                <input
                  type="datetime-local"
                  step={60}
                  className={fieldClassName()}
                  value={createExpiresAtInput}
                  onChange={(event) => setCreateExpiresAtInput(event.target.value)}
                />
              </label>
            )}
          </div>
          <div className="rounded-md border border-border/60 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
            {createExpiryMode === "default"
              ? "Default 90 days from creation. The request omits expiresAt and the worker applies the standard lifecycle."
              : createExpiryMode === "custom"
                ? "Custom expiry is converted from your local datetime to UTC epoch seconds before save."
                : "Non-expiring exception. Use only when lifecycle management is intentionally handled outside the default 90-day policy."}
          </div>
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={createBusy} aria-busy={createBusy}>
              {createBusy ? "Creating..." : "Create Key"}
            </Button>
          </div>
        </div>

        {revealedToken && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-4">
            <div className="text-sm font-medium text-foreground">{revealedToken.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">This token will not be shown again.</div>
            <pre className="mt-3 overflow-auto rounded bg-background/80 p-3 text-xs">{revealedToken.token}</pre>
          </div>
        )}

        {errorMessage && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400">
            {errorMessage}
          </div>
        )}

        {isLoading && <div className="text-sm text-muted-foreground">Loading API keys...</div>}
        {!isLoading && error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400">
            {error.message}
          </div>
        )}

        {!isLoading && !error && (
          <div className="space-y-3">
            {keys.length === 0 && (
              <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
                No API keys created yet.
              </div>
            )}

            {keys.map((key) => {
              const draft = draftState[key.id] ?? buildEditableState(key);
              const isBusy = busyKeyId === key.id;
              const keyStatus = getApiKeyStatus(key, nowSeconds);
              const expiringSoon = isExpiringSoon(key, nowSeconds);

              return (
                <div key={key.id} className="space-y-3 rounded-lg border border-border/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{key.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{key.maskedToken}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${apiKeyStatusBadgeClassName(keyStatus)}`}>
                        {keyStatus}
                      </span>
                      {expiringSoon && (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                          expiring soon
                        </span>
                      )}
                      {key.expiresAt == null && (
                        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          non-expiring exception
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-4">
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Name</span>
                      <input
                        className={fieldClassName()}
                        value={draft.name}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, name: event.target.value } }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Owner Email</span>
                      <input
                        className={fieldClassName()}
                        value={draft.ownerEmail}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, ownerEmail: event.target.value } }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Tier</span>
                      <input
                        className={fieldClassName()}
                        value={draft.tier}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, tier: event.target.value } }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Traffic Class</span>
                      <select
                        className={fieldClassName()}
                        value={draft.trafficClass}
                        onChange={(event) => setDrafts((prev) => ({
                          ...prev,
                          [key.id]: { ...draft, trafficClass: event.target.value as ApiKeyTrafficClass },
                        }))}
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
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, rateLimitPerMinute: event.target.value } }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Expiry</span>
                      <select
                        className={fieldClassName()}
                        value={draft.expiryMode}
                        onChange={(event) => setDrafts((prev) => ({
                          ...prev,
                          [key.id]: { ...draft, expiryMode: event.target.value as EditableKeyState["expiryMode"] },
                        }))}
                      >
                        <option value="custom">Custom expiry</option>
                        <option value="non-expiring">Non-expiring exception</option>
                      </select>
                    </label>
                    {draft.expiryMode === "custom" && (
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-muted-foreground">Expires At</span>
                        <input
                          type="datetime-local"
                          step={60}
                          className={fieldClassName()}
                          value={draft.expiresAtInput}
                          onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, expiresAtInput: event.target.value } }))}
                        />
                      </label>
                    )}
                  </div>

                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>Expiry: {formatExpirySummary(key, nowSeconds)}</div>
                    <div>Last used route: {key.lastUsedRoute ?? "never"}</div>
                    <div>Last used at: {key.lastUsedAt ? new Date(key.lastUsedAt * 1000).toISOString() : "never"}</div>
                  </div>

                  {draft.expiryMode === "non-expiring" && (
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
                      Saving will persist <span className="font-mono">expiresAt: null</span> as an explicit non-expiring exception.
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => runKeyAction(async () => {
                        const expiresAt = draft.expiryMode === "custom"
                          ? parseDateTimeLocalValue(draft.expiresAtInput)
                          : null;
                        if (draft.expiryMode === "custom" && expiresAt == null) {
                          throw new Error("Custom expiry requires a valid date and time");
                        }
                        const response = await postAdminJson<ApiKeyMutationResponse>(`/api/api-keys/${key.id}/update`, {
                          name: draft.name,
                          ownerEmail: draft.ownerEmail || null,
                          tier: draft.tier,
                          trafficClass: draft.trafficClass,
	                          rateLimitPerMinute: parseRateLimitInput(draft.rateLimitPerMinute),
                          expiresAt,
                        });
                        setDrafts((prev) => ({ ...prev, [key.id]: buildEditableState(response.key) }));
                      }, key.id)}
                    >
                      {isBusy ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy || !key.isActive}
                      onClick={() => runKeyAction(async () => {
                        await postAdminJson<ApiKeyMutationResponse>(`/api/api-keys/${key.id}/deactivate`);
                      }, key.id)}
                    >
                      Deactivate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => runKeyAction(async () => {
                        const response = await postAdminJson<ApiKeyRotateResponse>(`/api/api-keys/${key.id}/rotate`);
                        setRevealedToken({ label: `Rotated ${response.key.name}`, token: response.token });
                      }, key.id)}
                    >
                      Rotate
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
