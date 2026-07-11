// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  createTelegramMiniAppSnapshot,
  telegramMiniAppStateRevision,
  type TelegramMiniAppMutableState,
  type TelegramMiniAppState,
} from "@shared/lib/telegram-mini-app-contract";
import { SchemaValidationError } from "@/lib/api";
import {
  postMiniAppBulkWatchlistPreview,
  postMiniAppPortability,
  postMiniAppSnapshot,
  postMiniAppState,
  refreshMiniAppBundleOnce,
} from "./mini-app-api";

const mutableState: TelegramMiniAppMutableState = {
  viewer: {
    userId: "42",
    username: "watcher",
    chatId: "42",
    chatType: "private",
    canMutate: true,
    mutationBlockReason: null,
  },
  subscriber: {
    exists: true,
    globalAlerts: {
      dews: true,
      depeg: true,
      safety: false,
      launch: false,
      reserve: false,
      freeze: false,
      depegStepBps: 250,
    },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    recap: { enabled: false, deliveryHourLocal: 9, timezoneConfirmed: true, nextDueAt: null, lastWindowEndAt: null, lastDeliveredLocalDate: null, lastOutcome: null },
    snoozeUntilTs: null,
  },
  presets: [],
  subscriptions: [],
  health: {
    lastSuccessfulDeliveryAt: null,
    lastSuccessfulReplyAt: null,
    queuedAlerts: 0,
    recentFailureClass: null,
  },
};

const legacyState: TelegramMiniAppState = {
  ...mutableState,
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [{ stablecoinId: "legacy", symbol: "OLD", name: "Old Worker" }],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mini App versioned API client", () => {
  it("sends version capabilities and hydrates a compact snapshot from the bundled catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => createTelegramMiniAppSnapshot(mutableState),
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(requestUrl.searchParams.get(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toBe(
      TELEGRAM_MINI_APP_CONTRACT_VERSION,
    );
    expect(requestUrl.searchParams.get(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toBe(
      TELEGRAM_MINI_APP_CATALOG_VERSION,
    );
    expect(snapshot.state.catalog.searchableCoins.length).toBeGreaterThan(300);
    expect(snapshot.stateRevision).toBe(createTelegramMiniAppSnapshot(mutableState).stateRevision);
  });

  it("keeps a new client compatible with an old Worker's full-catalog response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => legacyState }));

    const snapshot = await postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" });

    expect(snapshot.state.catalog.searchableCoins).toEqual(legacyState.catalog.searchableCoins);
    expect(snapshot.stateRevision).toBe(telegramMiniAppStateRevision(mutableState));
  });

  it.each([
    ["contractVersion", "worker-contract-next", "contract-version-mismatch"],
    ["catalogVersion", "worker-catalog-next", "catalog-version-mismatch"],
  ] as const)("rejects a compact snapshot with an incompatible %s", async (field, value, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...createTelegramMiniAppSnapshot(mutableState), [field]: value }),
    }));

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 409, code });
  });

  it("rejects malformed success payloads before they reach Mini App state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "invalid" }) }));

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("keeps the state-only compatibility wrapper for callers that do not need revision metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => legacyState }));

    await expect(postMiniAppState("/api/telegram-mini-app/session", { initData: "signed" })).resolves.toEqual(legacyState);
  });

  it("validates a versioned portable watchlist preview without hydrating state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        result: {
          kind: "watchlist-import-preview",
          expectedPreferenceGeneration: 1,
          previewFingerprint: "preview-v1-12-deadbeef",
          preview: {
            directAdds: [], directRemoves: [], directChanges: [],
            presetAdds: [], presetRemoves: [], presetChanges: [],
            directBroadenedCoverage: [], directRemovedCoverage: [],
            presetBroadenedCoverage: [], presetRemovedCoverage: [],
          },
        },
      }),
    }));

    await expect(postMiniAppPortability("/api/telegram-mini-app/mutate", {
      initData: "signed",
      operation: { kind: "export-watchlist" },
    })).resolves.toMatchObject({ result: { kind: "watchlist-import-preview" } });
  });

  it.each([
    ["contractVersion", "worker-contract-next", "contract-version-mismatch"],
    ["catalogVersion", "worker-catalog-next", "catalog-version-mismatch"],
  ] as const)("rejects a portable watchlist response with an incompatible %s", async (field, value, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        [field]: value,
        result: { kind: "watchlist-export", token: "signed-export", directCount: 1, presetCount: 0 },
      }),
    }));

    await expect(postMiniAppPortability("/api/telegram-mini-app/mutate", {
      initData: "signed",
      operation: { kind: "export-watchlist" },
    })).rejects.toMatchObject({ status: 409, code });
  });

  it("uses the versioned signed transport for bulk watchlist previews", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        result: {
          kind: "bulk-watchlist-preview",
          expectedPreferenceGeneration: 1,
          previewFingerprint: "preview-v1-12-deadbeef",
          adds: ["usdc-circle"],
          removes: [],
          unchanged: [],
          sourceImpact: [],
          undo: {
            expectedPreferenceGeneration: 2,
            expectedFingerprint: "preview-v1-12-deadbeef",
            restoreDirectRows: [],
            removeStablecoinIds: ["usdc-circle"],
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(postMiniAppBulkWatchlistPreview("/api/telegram-mini-app/mutate", {
      initData: "signed",
      operation: { kind: "preview-bulk-watchlist", stablecoinIds: ["usdc-circle"], action: "add" },
    })).resolves.toMatchObject({ result: { adds: ["usdc-circle"] } });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM);
  });

  it("stores only a non-identifying version flag and refreshes once per target", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const refresh = vi.fn();
    const versions = { contractVersion: "3", catalogVersion: "catalog-v2-next" };

    expect(refreshMiniAppBundleOnce(versions, { storage, refresh })).toBe(true);
    expect(refreshMiniAppBundleOnce(versions, { storage, refresh })).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect([...values.values()]).toEqual(["3:catalog-v2-next"]);
    expect(JSON.stringify([...values.entries()])).not.toContain("initData");
  });

  it("does not auto-refresh when durable session storage is unavailable", () => {
    const refresh = vi.fn();
    const throwingStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(
      refreshMiniAppBundleOnce(
        { contractVersion: "3", catalogVersion: "catalog-v2-next" },
        { storage: throwingStorage, refresh },
      ),
    ).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
