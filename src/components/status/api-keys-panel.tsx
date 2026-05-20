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
  ApiKeyRowEditor,
  CreateApiKeyForm,
  TokenRevealPanel,
} from "./api-keys-panel-parts";

const EMPTY_KEYS: readonly ApiKeySummary[] = [];

export function ApiKeysPanel() {
  const { data, error, isLoading, refetch } = useApiKeys();
  const [createState, setCreateState] = useState<CreateKeyState>(DEFAULT_CREATE_KEY_STATE);
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

        <CreateApiKeyForm
          busy={createBusy}
          state={createState}
          onChange={(patch) => setCreateState((previous) => ({ ...previous, ...patch }))}
          onCreate={handleCreate}
        />

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
            {keys.length === 0 ? (
              <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
                No API keys created yet.
              </div>
            ) : null}

            {keys.map((key) => {
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
