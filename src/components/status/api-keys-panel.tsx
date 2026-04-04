"use client";

import { useMemo, useState } from "react";
import type {
  ApiKeyCreateResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
  ApiKeySummary,
  ApiKeyTrafficClass,
} from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildAdminApiPath, buildAdminFetchInit, type AdminAccess } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { useApiKeys } from "@/hooks/use-api-keys";

interface ApiKeysPanelProps {
  adminAccess: AdminAccess;
}

interface EditableKeyState {
  name: string;
  ownerEmail: string;
  tier: string;
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: string;
}

const EMPTY_KEYS: readonly ApiKeySummary[] = [];

function buildEditableState(key: ApiKeySummary): EditableKeyState {
  return {
    name: key.name,
    ownerEmail: key.ownerEmail ?? "",
    tier: key.tier,
    trafficClass: key.trafficClass,
    rateLimitPerMinute: String(key.rateLimitPerMinute),
  };
}

function fieldClassName() {
  return "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";
}

async function postAdminJson<T>(
  adminAccess: AdminAccess,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const init = buildAdminFetchInit({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await fetch(buildRequestUrl(buildAdminApiPath(path, adminAccess)), init);
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

export function ApiKeysPanel({ adminAccess }: ApiKeysPanelProps) {
  const { data, error, isLoading, refetch } = useApiKeys(adminAccess);
  const [createName, setCreateName] = useState("");
  const [createOwnerEmail, setCreateOwnerEmail] = useState("");
  const [createTier, setCreateTier] = useState("standard");
  const [createTrafficClass, setCreateTrafficClass] = useState<ApiKeyTrafficClass>("external");
  const [createRateLimit, setCreateRateLimit] = useState("120");
  const [drafts, setDrafts] = useState<Record<number, EditableKeyState>>({});
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{ label: string; token: string } | null>(null);

  const keys = data?.keys ?? EMPTY_KEYS;
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
      const response = await postAdminJson<ApiKeyCreateResponse>(adminAccess, "/api/api-keys", {
        name: createName,
        ownerEmail: createOwnerEmail || null,
        tier: createTier,
        trafficClass: createTrafficClass,
        rateLimitPerMinute: Number.parseInt(createRateLimit, 10),
      });
      setRevealedToken({ label: `Created ${response.key.name}`, token: response.token });
      setCreateName("");
      setCreateOwnerEmail("");
      setCreateTier("standard");
      setCreateTrafficClass("external");
      setCreateRateLimit("120");
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
              <input className={fieldClassName()} value={createRateLimit} onChange={(event) => setCreateRateLimit(event.target.value)} />
            </label>
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

              return (
                <div key={key.id} className="space-y-3 rounded-lg border border-border/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{key.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{key.maskedToken}</div>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        key.isActive
                          ? "bg-green-500/15 text-green-700 dark:text-green-400"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {key.isActive ? "active" : "inactive"}
                    </span>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-3">
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
                        className={fieldClassName()}
                        value={draft.rateLimitPerMinute}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key.id]: { ...draft, rateLimitPerMinute: event.target.value } }))}
                      />
                    </label>
                  </div>

                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>Last used route: {key.lastUsedRoute ?? "never"}</div>
                    <div>Last used at: {key.lastUsedAt ? new Date(key.lastUsedAt * 1000).toISOString() : "never"}</div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => runKeyAction(async () => {
                        const response = await postAdminJson<ApiKeyMutationResponse>(
                          adminAccess,
                          `/api/api-keys/${key.id}/update`,
                          {
                            name: draft.name,
                            ownerEmail: draft.ownerEmail || null,
                            tier: draft.tier,
                            trafficClass: draft.trafficClass,
                            rateLimitPerMinute: Number.parseInt(draft.rateLimitPerMinute, 10),
                          },
                        );
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
                        await postAdminJson<ApiKeyMutationResponse>(adminAccess, `/api/api-keys/${key.id}/deactivate`);
                      }, key.id)}
                    >
                      Deactivate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => runKeyAction(async () => {
                        const response = await postAdminJson<ApiKeyRotateResponse>(adminAccess, `/api/api-keys/${key.id}/rotate`);
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
