"use client";

import { useMemo, useState } from "react";
import type {
  ApiKeyCreateResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
  ApiKeySummary,
} from "@shared/types";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { postAdminJson } from "@/lib/admin-access";
import { useApiKeys } from "@/hooks/use-api-keys";
import {
  buildApiKeyInventorySummary,
  buildCreateApiKeyPayload,
  buildEditableKeyState,
  buildUpdateApiKeyPayload,
  DEFAULT_CREATE_KEY_STATE,
  requirePlaintextToken,
} from "@/lib/api-key-admin-view-model";
import type { CreateKeyState, EditableKeyState } from "@/lib/api-key-admin-view-model";
import {
  ApiKeyInventorySummary,
  ApiKeyTable,
  ApiKeyRowEditor,
  CreateApiKeyForm,
  TokenRevealPanel,
} from "./api-keys-panel-parts";

const EMPTY_KEYS: readonly ApiKeySummary[] = [];

export function ApiKeysPanel() {
  const { data, error, isLoading, refetch } = useApiKeys();
  const [createState, setCreateState] = useState<CreateKeyState>(DEFAULT_CREATE_KEY_STATE);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, EditableKeyState>>({});
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{ label: string; token: string } | null>(null);

  const keys = data?.keys ?? EMPTY_KEYS;
  const nowSeconds = data?.generatedAt ?? Math.floor(Date.now() / 1000);
  const keySummary = useMemo(() => buildApiKeyInventorySummary(keys, nowSeconds), [keys, nowSeconds]);
  const draftState = useMemo(() => {
    const next: Record<number, EditableKeyState> = {};
    for (const key of keys) {
      next[key.id] = drafts[key.id] ?? buildEditableKeyState(key);
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
      const response = await postAdminJson<ApiKeyCreateResponse>(
        API_PATHS.apiKeys(),
        buildCreateApiKeyPayload(createState),
      );
      setRevealedToken({ label: `Created ${response.key.name}`, token: requirePlaintextToken(response, "created") });
      setCreateState(DEFAULT_CREATE_KEY_STATE);
      setIsCreateOpen(false);
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
        {!isLoading && !error ? <ApiKeyInventorySummary items={keySummary} /> : null}

        {!isLoading && !error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/35 px-3 py-2">
            <div>
              <h3 className="text-sm font-medium text-foreground">Key inventory</h3>
              <p className="text-xs text-muted-foreground">
                Scan keys first; open create or edit only when you need to mutate credentials.
              </p>
            </div>
            <Button size="sm" variant={isCreateOpen ? "default" : "outline"} onClick={() => setIsCreateOpen((value) => !value)}>
              {isCreateOpen ? "Creating key" : "Create read key"}
            </Button>
          </div>
        ) : null}

        {isCreateOpen ? (
          <CreateApiKeyForm
            busy={createBusy}
            state={createState}
            onChange={(patch) => setCreateState((previous) => ({ ...previous, ...patch }))}
            onCreate={handleCreate}
          />
        ) : null}

        {revealedToken ? <TokenRevealPanel revealedToken={revealedToken} /> : null}

        {errorMessage ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400">
            {errorMessage}
          </div>
        ) : null}

        {isLoading ? <div className="text-sm text-muted-foreground">Loading API keys...</div> : null}
        {!isLoading && error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400">
            {error.message}
          </div>
        ) : null}

        {!isLoading && !error ? (
          <div className="space-y-3">
            <ApiKeyTable
              keys={keys}
              nowSeconds={nowSeconds}
              busyKeyId={busyKeyId}
              editingKeyId={editingKeyId}
              onEdit={(keyId) => setEditingKeyId((current) => current === keyId ? null : keyId)}
              onDeactivate={(keyId) => runKeyAction(async () => {
                await postAdminJson<ApiKeyMutationResponse>(`/api/api-keys/${keyId}/deactivate`);
              }, keyId)}
              onRotate={(keyId) => runKeyAction(async () => {
                const response = await postAdminJson<ApiKeyRotateResponse>(`/api/api-keys/${keyId}/rotate`);
                setRevealedToken({
                  label: `Rotated ${response.key.name}`,
                  token: requirePlaintextToken(response, "rotated"),
                });
              }, keyId)}
            />

            {keys.map((key) => {
              if (editingKeyId !== key.id) return null;
              const draft = draftState[key.id] ?? buildEditableKeyState(key);
              const isBusy = busyKeyId === key.id;

              return (
                <ApiKeyRowEditor
                  key={key.id}
                  apiKey={key}
                  draft={draft}
                  nowSeconds={nowSeconds}
                  isBusy={isBusy}
                  onDraftChange={(patch) => setDrafts((previous) => ({
                    ...previous,
                    [key.id]: { ...draft, ...patch },
                  }))}
                  onSave={() => runKeyAction(async () => {
                    const response = await postAdminJson<ApiKeyMutationResponse>(
                      `/api/api-keys/${key.id}/update`,
                      buildUpdateApiKeyPayload(draft),
                    );
                    setDrafts((previous) => ({ ...previous, [key.id]: buildEditableKeyState(response.key) }));
                    setEditingKeyId(null);
                  }, key.id)}
                  onDeactivate={() => runKeyAction(async () => {
                    await postAdminJson<ApiKeyMutationResponse>(`/api/api-keys/${key.id}/deactivate`);
                  }, key.id)}
                  onRotate={() => runKeyAction(async () => {
                    const response = await postAdminJson<ApiKeyRotateResponse>(`/api/api-keys/${key.id}/rotate`);
                    setRevealedToken({
                      label: `Rotated ${response.key.name}`,
                      token: requirePlaintextToken(response, "rotated"),
                    });
                  }, key.id)}
                />
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
