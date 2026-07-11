"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiKeyCreateResponse, ApiKeyMutationResponse, ApiKeyRotateResponse, ApiKeySummary } from "@shared/types";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiKeys } from "@/hooks/use-api-keys";
import { useApiKeyAuditLog } from "@/hooks/use-api-key-audit-log";
import {
  buildApiKeyExpiryWindow,
  buildApiKeyInventorySummary,
  buildApiKeyInventoryView,
  buildCreateApiKeyPayload,
  buildEditableKeyState,
  buildUpdateApiKeyPayload,
  DEFAULT_API_KEY_INVENTORY_QUERY,
  DEFAULT_CREATE_KEY_STATE,
} from "@/lib/api-key-admin-view-model";
import type {
  ApiKeyInventoryExpiryPreset,
  ApiKeyInventoryQuery,
  CreateKeyState,
  EditableKeyState,
} from "@/lib/api-key-admin-view-model";
import {
  AdminMutationFeedback,
  AdminMutationReceipt,
  buildAdminMutationReceiptMetadata,
  type AdminMutationReceiptMetadata,
} from "./admin-mutation-feedback";
import {
  type AdminMutationIntentExecution,
  type AdminMutationIntentRequest,
  useAdminMutationIntents,
} from "./admin-mutation-intent";
import {
  ApiKeyDetailEditor,
  ApiKeyInventoryControls,
  ApiKeyInventoryPagination,
  ApiKeyInventorySummary,
  ApiKeyTable,
  CreateApiKeyForm,
  TokenRevealDialog,
  TokenUnavailableReplayDialog,
} from "./api-keys-panel-parts";

const EMPTY_KEYS: readonly ApiKeySummary[] = [];
const CREATE_LANE = "api-key:create";

type LifecycleAction = "rotate" | "deactivate";

interface PendingLifecycleAction {
  action: LifecycleAction;
  apiKey: ApiKeySummary;
}

interface RevealedToken {
  label: string;
  token: string;
  laneKey: string;
  execution: AdminMutationIntentExecution;
}

interface TokenRecovery {
  label: string;
  apiKey: ApiKeySummary;
  recovery: string;
  origin: HTMLElement | null;
  execution: AdminMutationIntentExecution;
}

function updateLane(keyId: number): string {
  return `api-key:update:${keyId}`;
}

function lifecycleLane(action: LifecycleAction, keyId: number): string {
  return `api-key:${action}:${keyId}`;
}

function focusElement(element: HTMLElement | null) {
  queueMicrotask(() => element?.focus());
}

export function ApiKeysPanel() {
  const { data, error, isLoading, isFetching, refetch } = useApiKeys();
  const { executions, execute, retrySame, executeNew, clear } = useAdminMutationIntents();
  const [createState, setCreateState] = useState<CreateKeyState>(DEFAULT_CREATE_KEY_STATE);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState<ApiKeyInventoryQuery>(() => ({
    ...DEFAULT_API_KEY_INVENTORY_QUERY,
    sort: { ...DEFAULT_API_KEY_INVENTORY_QUERY.sort! },
  }));
  const [expiryPreset, setExpiryPreset] = useState<ApiKeyInventoryExpiryPreset>("any");
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, EditableKeyState>>({});
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ receipt: AdminMutationReceiptMetadata; message: string } | null>(null);
  const [pendingLifecycle, setPendingLifecycle] = useState<PendingLifecycleAction | null>(null);
  const [revealedToken, setRevealedToken] = useState<RevealedToken | null>(null);
  const [tokenRecovery, setTokenRecovery] = useState<TokenRecovery | null>(null);
  const [mountedAtSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const inventoryWorkbenchRef = useRef<HTMLDivElement>(null);
  const selectionOriginRef = useRef<HTMLButtonElement | null>(null);
  const lifecycleOriginRef = useRef<HTMLElement | null>(null);
  const tokenOriginRef = useRef<HTMLElement | null>(null);

  const keys = data?.keys ?? EMPTY_KEYS;
  const nowSeconds = data?.generatedAt ?? mountedAtSeconds;
  const keySummary = useMemo(() => buildApiKeyInventorySummary(keys, nowSeconds), [keys, nowSeconds]);
  const inventoryView = useMemo(
    () =>
      buildApiKeyInventoryView(keys, nowSeconds, {
        ...inventoryQuery,
        expiryWindow: buildApiKeyExpiryWindow(expiryPreset, nowSeconds),
      }),
    [expiryPreset, inventoryQuery, keys, nowSeconds],
  );
  const filterOptions = useMemo(() => {
    const owners = new Set<string>();
    const tiers = new Set<string>();
    let hasUnassignedOwner = false;
    for (const key of keys) {
      if (key.ownerEmail == null) hasUnassignedOwner = true;
      else owners.add(key.ownerEmail);
      tiers.add(key.tier);
    }
    return {
      owners: [...owners].sort((left, right) => left.localeCompare(right)),
      hasUnassignedOwner,
      tiers: [...tiers].sort((left, right) => left.localeCompare(right)),
    };
  }, [keys]);
  const selectedKey = inventoryView.keys.find((key) => key.id === selectedKeyId) ?? null;
  const auditQuery = useApiKeyAuditLog(selectedKey?.id ?? null);
  const draftState = useMemo(() => {
    const next: Record<number, EditableKeyState> = {};
    for (const key of keys) {
      next[key.id] = drafts[key.id] ?? buildEditableKeyState(key);
    }
    return next;
  }, [drafts, keys]);
  const selectedDraft = selectedKey ? (draftState[selectedKey.id] ?? buildEditableKeyState(selectedKey)) : null;
  const selectedKeyIdOnPage = selectedKey?.id ?? null;

  useEffect(() => {
    if (selectedKeyIdOnPage != null) detailPanelRef.current?.focus();
  }, [selectedKeyIdOnPage]);

  function updateInventoryQuery(patch: Partial<ApiKeyInventoryQuery>) {
    setInventoryQuery((previous) => ({ ...previous, ...patch, page: 1 }));
    setSelectedKeyId(null);
  }

  function changeInventoryPage(page: number) {
    setInventoryQuery((previous) => ({ ...previous, page }));
    setSelectedKeyId(null);
  }

  function changeInventoryPageSize(pageSize: number) {
    setInventoryQuery((previous) => ({ ...previous, page: 1, pageSize }));
    setSelectedKeyId(null);
  }

  function changeExpiryPreset(preset: ApiKeyInventoryExpiryPreset) {
    setExpiryPreset(preset);
    setInventoryQuery((previous) => ({ ...previous, page: 1 }));
    setSelectedKeyId(null);
  }

  function resetInventoryView() {
    setInventoryQuery({
      ...DEFAULT_API_KEY_INVENTORY_QUERY,
      sort: { ...DEFAULT_API_KEY_INVENTORY_QUERY.sort! },
    });
    setExpiryPreset("any");
    setSelectedKeyId(null);
  }

  function selectKey(apiKey: ApiKeySummary, origin: HTMLButtonElement) {
    if (selectedKeyId === apiKey.id) {
      setSelectedKeyId(null);
      return;
    }
    selectionOriginRef.current = origin;
    setSelectedKeyId(apiKey.id);
  }

  function closeKeyDetails() {
    const origin = selectionOriginRef.current;
    setSelectedKeyId(null);
    focusElement(origin);
  }

  async function refreshInventory() {
    const result = await refetch();
    return result?.data;
  }

  function revealToken(
    execution: AdminMutationIntentExecution,
    response: ApiKeyCreateResponse | ApiKeyRotateResponse,
    action: "created" | "rotated",
    origin: HTMLElement | null,
  ) {
    const label = `${action === "created" ? "Created" : "Rotated"} ${response.key.name}`;
    const token = typeof response.token === "string" && response.token.trim().length > 0 ? response.token : null;
    if (!token) {
      const replayResponse = response as typeof response & {
        recovery?: unknown;
        tokenUnavailableOnReplay?: unknown;
      };
      setTokenRecovery({
        label,
        apiKey: response.key,
        recovery:
          typeof replayResponse.recovery === "string"
            ? replayResponse.recovery
            : "The plaintext token was not returned. Rotate this identified key to issue a replacement token before using it.",
        origin,
        execution,
      });
      return;
    }
    tokenOriginRef.current = origin;
    setRevealedToken({
      label,
      token,
      laneKey: execution.laneKey,
      execution,
    });
  }

  async function runCreate(mode: "start" | "retry" | "new") {
    setErrorMessage(null);
    setReceipt(null);
    let request: AdminMutationIntentRequest;
    try {
      request =
        mode === "start"
          ? {
              laneKey: CREATE_LANE,
              path: API_PATHS.apiKeys(),
              body: buildCreateApiKeyPayload(createState),
            }
          : (executions[CREATE_LANE]?.request ??
            (() => {
              throw new Error("No create intent is available to retry");
            })());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not prepare API key creation");
      return;
    }

    setCreateBusy(true);
    const result =
      mode === "retry"
        ? await retrySame(CREATE_LANE)
        : mode === "new"
          ? await executeNew(request)
          : await execute(request);
    if (!result.didStart) {
      setCreateBusy(false);
      return;
    }
    setCreateBusy(false);
    if (result.execution.status !== "succeeded") return;

    try {
      revealToken(result.execution, result.execution.data as ApiKeyCreateResponse, "created", createTriggerRef.current);
      setCreateState(DEFAULT_CREATE_KEY_STATE);
      setIsCreateOpen(false);
      await refreshInventory();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Created API key token could not be shown");
    }
  }

  async function runUpdate(apiKey: ApiKeySummary, draft: EditableKeyState, mode: "start" | "retry" | "new") {
    const laneKey = updateLane(apiKey.id);
    setErrorMessage(null);
    setReceipt(null);
    let request: AdminMutationIntentRequest;
    try {
      request =
        mode === "start"
          ? {
              laneKey,
              path: API_PATHS.apiKeyUpdate(apiKey.id),
              body: buildUpdateApiKeyPayload(draft),
            }
          : (executions[laneKey]?.request ??
            (() => {
              throw new Error("No update intent is available to retry");
            })());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not prepare API key update");
      return;
    }

    setBusyKeyId(apiKey.id);
    const result =
      mode === "retry" ? await retrySame(laneKey) : mode === "new" ? await executeNew(request) : await execute(request);
    if (!result.didStart) {
      setBusyKeyId(null);
      return;
    }
    setBusyKeyId(null);
    if (result.execution.status !== "succeeded") return;

    const response = result.execution.data as ApiKeyMutationResponse;
    setDrafts((previous) => ({ ...previous, [apiKey.id]: buildEditableKeyState(response.key) }));
    setReceipt({
      receipt: buildAdminMutationReceiptMetadata(result.execution),
      message: `Updated ${response.key.name}.`,
    });
    const refreshedInventory = await refreshInventory();
    const reconciledKeys =
      refreshedInventory?.keys ?? keys.map((key) => (key.id === response.key.id ? response.key : key));
    const refreshedNowSeconds = refreshedInventory?.generatedAt ?? nowSeconds;
    const refreshedView = buildApiKeyInventoryView(reconciledKeys, refreshedNowSeconds, {
      ...inventoryQuery,
      expiryWindow: buildApiKeyExpiryWindow(expiryPreset, refreshedNowSeconds),
    });
    const selectedKeyIsRendered = refreshedView.keys.some((key) => key.id === apiKey.id);
    if (selectedKeyId === apiKey.id) {
      if (!selectedKeyIsRendered) {
        setSelectedKeyId(null);
        selectionOriginRef.current = null;
        focusElement(inventoryWorkbenchRef.current);
      } else {
        await auditQuery.refetch();
      }
    }
  }

  function requestLifecycle(action: LifecycleAction, apiKey: ApiKeySummary, origin: HTMLElement) {
    setErrorMessage(null);
    setReceipt(null);
    lifecycleOriginRef.current = origin;
    setPendingLifecycle({ action, apiKey });
  }

  function closeLifecycleDialog() {
    const origin = lifecycleOriginRef.current;
    setPendingLifecycle(null);
    focusElement(origin);
  }

  async function runLifecycle(mode: "start" | "retry" | "new") {
    if (!pendingLifecycle) return;
    const { action, apiKey } = pendingLifecycle;
    const laneKey = lifecycleLane(action, apiKey.id);
    const request =
      mode === "start"
        ? {
            laneKey,
            path: action === "rotate" ? API_PATHS.apiKeyRotate(apiKey.id) : API_PATHS.apiKeyDeactivate(apiKey.id),
          }
        : executions[laneKey]?.request;
    if (!request) return;

    setBusyKeyId(apiKey.id);
    const result =
      mode === "retry" ? await retrySame(laneKey) : mode === "new" ? await executeNew(request) : await execute(request);
    if (!result.didStart) {
      setBusyKeyId(null);
      return;
    }
    setBusyKeyId(null);
    if (result.execution.status !== "succeeded") return;

    if (action === "rotate") {
      try {
        revealToken(
          result.execution,
          result.execution.data as ApiKeyRotateResponse,
          "rotated",
          lifecycleOriginRef.current,
        );
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Rotated API key token could not be shown");
      }
    } else {
      const response = result.execution.data as ApiKeyMutationResponse;
      setReceipt({
        receipt: buildAdminMutationReceiptMetadata(result.execution),
        message: `Deactivated ${response.key.name}.`,
      });
    }
    setPendingLifecycle(null);
    await refreshInventory();
    if (selectedKeyId === apiKey.id) await auditQuery.refetch();
  }

  function closeTokenDialog() {
    if (!revealedToken) return;
    const origin = tokenOriginRef.current;
    setReceipt({
      receipt: buildAdminMutationReceiptMetadata(revealedToken.execution),
      message: `${revealedToken.label}; one-time token closed.`,
    });
    clear(revealedToken.laneKey);
    setRevealedToken(null);
    focusElement(origin);
  }

  function closeTokenRecovery() {
    if (!tokenRecovery) return;
    const origin = tokenRecovery.origin;
    setReceipt({
      receipt: buildAdminMutationReceiptMetadata(tokenRecovery.execution),
      message: `${tokenRecovery.label}; one-time token was unavailable on replay.`,
    });
    clear(tokenRecovery.execution.laneKey);
    setTokenRecovery(null);
    focusElement(origin);
  }

  function rotateRecoveredKey() {
    if (!tokenRecovery) return;
    lifecycleOriginRef.current = tokenRecovery.origin;
    setReceipt(null);
    setPendingLifecycle({ action: "rotate", apiKey: tokenRecovery.apiKey });
    setTokenRecovery(null);
  }

  const pendingLane = pendingLifecycle ? lifecycleLane(pendingLifecycle.action, pendingLifecycle.apiKey.id) : null;
  const pendingExecution = pendingLane ? executions[pendingLane] : undefined;
  const pendingBusy = pendingExecution?.requestInFlight === true;

  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle as="h3" className="text-base">API Keys</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        {!isLoading && !error ? <ApiKeyInventorySummary items={keySummary} /> : null}

        {!isLoading && !error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/35 px-3 py-2">
            <div>
              <h3 id="api-key-inventory-heading" className="text-sm font-medium text-foreground">
                Key inventory
              </h3>
              <p className="text-xs text-muted-foreground">
                Scan keys first; open create or edit only when you need to mutate credentials.
              </p>
            </div>
            <Button
              ref={createTriggerRef}
              size="sm"
              className="min-h-11"
              variant={isCreateOpen ? "default" : "outline"}
              onClick={() => setIsCreateOpen((value) => !value)}
            >
              {isCreateOpen ? "Creating key" : "Create read key"}
            </Button>
          </div>
        ) : null}

        {isCreateOpen ? (
          <div className="space-y-3">
            <CreateApiKeyForm
              busy={createBusy}
              state={createState}
              onChange={(patch) => setCreateState((previous) => ({ ...previous, ...patch }))}
              onCreate={() => void runCreate("start")}
            />
            <AdminMutationFeedback
              execution={executions[CREATE_LANE]}
              onRetrySame={() => void runCreate("retry")}
              onStartNew={() => void runCreate("new")}
              newIntentLabel="Start new create intent"
            />
          </div>
        ) : null}

        <AdminMutationReceipt receipt={receipt?.receipt ?? null} message={receipt?.message ?? null} />

        {errorMessage ? (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400"
          >
            {errorMessage}
          </div>
        ) : null}

        {isLoading ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            Loading API keys...
          </div>
        ) : null}
        {!isLoading && error ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-400"
          >
            <p>{error.message}</p>
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              variant="outline"
              onClick={() => void refreshInventory()}
              disabled={isFetching}
              aria-busy={isFetching}
            >
              <RefreshCw className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
              Retry API key inventory
            </Button>
          </div>
        ) : null}

        {!isLoading && !error ? (
          <div
            ref={inventoryWorkbenchRef}
            role="region"
            tabIndex={-1}
            aria-labelledby="api-key-inventory-heading"
            className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ApiKeyInventoryControls
              query={inventoryQuery}
              expiryPreset={expiryPreset}
              options={filterOptions}
              onQueryChange={updateInventoryQuery}
              onExpiryPresetChange={changeExpiryPreset}
              onReset={resetInventoryView}
            />
            <ApiKeyTable
              keys={inventoryView.keys}
              nowSeconds={nowSeconds}
              busyKeyId={busyKeyId}
              selectedKeyId={selectedKeyId}
              emptyMessage={keys.length === 0 ? "No API keys created yet." : "No keys match the current view."}
              onSelect={selectKey}
              onDeactivate={(apiKey) => requestLifecycle("deactivate", apiKey, document.activeElement as HTMLElement)}
              onRotate={(apiKey) => requestLifecycle("rotate", apiKey, document.activeElement as HTMLElement)}
            />
            <ApiKeyInventoryPagination
              page={inventoryView.page}
              pageSize={inventoryView.pageSize}
              totalPages={inventoryView.totalPages}
              totalItems={inventoryView.totalItems}
              totalInventoryItems={inventoryView.totalInventoryItems}
              firstItemNumber={inventoryView.firstItemNumber}
              lastItemNumber={inventoryView.lastItemNumber}
              onPageChange={changeInventoryPage}
              onPageSizeChange={changeInventoryPageSize}
            />

            {selectedKey && selectedDraft ? (
              <section
                id={`api-key-detail-panel-${selectedKey.id}`}
                ref={detailPanelRef}
                tabIndex={-1}
                aria-labelledby={`api-key-detail-${selectedKey.id}`}
                className="min-w-0 space-y-3 border-t border-border pt-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ApiKeyDetailEditor
                  apiKey={selectedKey}
                  draft={selectedDraft}
                  nowSeconds={nowSeconds}
                  isBusy={busyKeyId === selectedKey.id}
                  auditEntries={auditQuery.data?.entries ?? []}
                  auditError={auditQuery.error}
                  auditLoading={auditQuery.isLoading}
                  auditFetching={auditQuery.isFetching}
                  onDraftChange={(patch) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [selectedKey.id]: { ...selectedDraft, ...patch },
                    }))
                  }
                  onSave={() => void runUpdate(selectedKey, selectedDraft, "start")}
                  onDeactivate={() =>
                    requestLifecycle("deactivate", selectedKey, document.activeElement as HTMLElement)
                  }
                  onRotate={() => requestLifecycle("rotate", selectedKey, document.activeElement as HTMLElement)}
                  onClose={closeKeyDetails}
                  onRetryAudit={() => void auditQuery.refetch()}
                />
                <AdminMutationFeedback
                  execution={executions[updateLane(selectedKey.id)]}
                  onRetrySame={() => void runUpdate(selectedKey, selectedDraft, "retry")}
                  onStartNew={() => void runUpdate(selectedKey, selectedDraft, "new")}
                  newIntentLabel="Start new update intent"
                />
              </section>
            ) : null}
          </div>
        ) : null}

        <Dialog
          open={pendingLifecycle != null}
          onOpenChange={(open) => {
            if (!open && !pendingBusy) closeLifecycleDialog();
          }}
        >
          <DialogContent
            showCloseButton={!pendingBusy}
            onEscapeKeyDown={(event) => {
              if (pendingBusy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (pendingBusy) event.preventDefault();
            }}
          >
            {pendingLifecycle ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {pendingLifecycle.action === "rotate" ? "Rotate API key" : "Deactivate API key"}
                  </DialogTitle>
                  <DialogDescription>
                    {pendingLifecycle.apiKey.name} · ID {pendingLifecycle.apiKey.id} ·{" "}
                    <span className="font-mono">{pendingLifecycle.apiKey.maskedToken}</span>
                  </DialogDescription>
                </DialogHeader>
                <dl className="grid gap-3 text-sm">
                  <div>
                    <dt className="font-medium text-foreground">Risk</dt>
                    <dd className="text-muted-foreground">
                      {pendingLifecycle.action === "rotate" ? "High" : "Moderate"} · live credential mutation
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Exact effect</dt>
                    <dd className="text-muted-foreground">
                      {pendingLifecycle.action === "rotate"
                        ? "Replaces the secret and prefix immediately. The current token stops authenticating; name, owner, tier, limit, active state, and expiry are preserved."
                        : "Sets this key inactive immediately. Requests using its current token will be rejected; metadata and audit history remain."}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Recovery</dt>
                    <dd className="text-muted-foreground">
                      {pendingLifecycle.action === "rotate"
                        ? "Save the one-time replacement token. If it is lost, rotate again; the token being replaced cannot be restored."
                        : "Set isActive=true through the audited API-key update endpoint, or create a replacement key if reactivation is inappropriate."}
                    </dd>
                  </div>
                </dl>
                <AdminMutationFeedback
                  execution={pendingExecution}
                  onRetrySame={() => void runLifecycle("retry")}
                  onStartNew={() => void runLifecycle("new")}
                  newIntentLabel={`Start new ${pendingLifecycle.action} intent`}
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={closeLifecycleDialog}
                    disabled={pendingBusy}
                  >
                    Cancel
                  </Button>
                  {pendingExecution?.status !== "failed" && pendingExecution?.status !== "unknown" ? (
                    <Button
                      type="button"
                      className="min-h-11"
                      variant={pendingLifecycle.action === "rotate" ? "destructive" : "default"}
                      disabled={pendingBusy}
                      aria-busy={pendingBusy}
                      onClick={() => void runLifecycle("start")}
                    >
                      {pendingBusy
                        ? "Working..."
                        : `Confirm ${pendingLifecycle.action} of ${pendingLifecycle.apiKey.name} (ID ${pendingLifecycle.apiKey.id})`}
                    </Button>
                  ) : null}
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>

        {revealedToken ? (
          <TokenRevealDialog
            key={revealedToken.execution.intentId}
            revealedToken={{
              label: revealedToken.label,
              token: revealedToken.token,
              idempotencyKey: revealedToken.execution.idempotencyKey,
              idempotentReplay: revealedToken.execution.idempotentReplay,
              executionCertainty: revealedToken.execution.executionCertainty,
            }}
            onClose={closeTokenDialog}
          />
        ) : null}

        {tokenRecovery ? (
          <TokenUnavailableReplayDialog
            key={tokenRecovery.execution.intentId}
            label={tokenRecovery.label}
            apiKey={tokenRecovery.apiKey}
            recovery={tokenRecovery.recovery}
            idempotencyKey={tokenRecovery.execution.idempotencyKey}
            idempotentReplay={tokenRecovery.execution.idempotentReplay}
            executionCertainty={tokenRecovery.execution.executionCertainty}
            onRotate={rotateRecoveredKey}
            onClose={closeTokenRecovery}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
