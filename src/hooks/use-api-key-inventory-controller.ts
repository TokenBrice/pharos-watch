import { useMemo, useState } from "react";
import type { ApiKeySummary } from "@shared/types";
import {
  buildApiKeyExpiryWindow,
  buildApiKeyInventorySummary,
  buildApiKeyInventoryView,
  buildEditableKeyState,
  DEFAULT_API_KEY_INVENTORY_QUERY,
  type ApiKeyInventoryExpiryPreset,
  type ApiKeyInventoryQuery,
  type EditableKeyState,
} from "@/lib/api-key-admin-view-model";

export function useApiKeyInventoryController(keys: readonly ApiKeySummary[], nowSeconds: number) {
  const [inventoryQuery, setInventoryQuery] = useState<ApiKeyInventoryQuery>(() => ({
    ...DEFAULT_API_KEY_INVENTORY_QUERY,
    sort: { ...DEFAULT_API_KEY_INVENTORY_QUERY.sort! },
  }));
  const [expiryPreset, setExpiryPreset] = useState<ApiKeyInventoryExpiryPreset>("any");
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, EditableKeyState>>({});

  const keySummary = useMemo(() => buildApiKeyInventorySummary(keys, nowSeconds), [keys, nowSeconds]);
  const inventoryView = useMemo(
    () => buildApiKeyInventoryView(keys, nowSeconds, {
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
  const draftState = useMemo(() => {
    const next: Record<number, EditableKeyState> = {};
    for (const key of keys) next[key.id] = drafts[key.id] ?? buildEditableKeyState(key);
    return next;
  }, [drafts, keys]);
  const selectedDraft = selectedKey ? (draftState[selectedKey.id] ?? buildEditableKeyState(selectedKey)) : null;

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

  function updateSelectedDraft(patch: Partial<EditableKeyState>) {
    if (!selectedKey || !selectedDraft) return;
    setDrafts((previous) => ({
      ...previous,
      [selectedKey.id]: { ...selectedDraft, ...patch },
    }));
  }

  return {
    changeExpiryPreset,
    changeInventoryPage,
    changeInventoryPageSize,
    expiryPreset,
    filterOptions,
    inventoryQuery,
    inventoryView,
    keySummary,
    resetInventoryView,
    selectedDraft,
    selectedKey,
    selectedKeyId,
    setDrafts,
    setSelectedKeyId,
    updateInventoryQuery,
    updateSelectedDraft,
  };
}
