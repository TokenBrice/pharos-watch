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
import { postMiniAppSnapshot, postMiniAppState, refreshMiniAppBundleOnce } from "./mini-app-api";

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
      depegStepBps: 250,
    },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
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

  it("keeps the state-only compatibility wrapper for callers that do not need revision metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => legacyState }));

    await expect(postMiniAppState("/api/telegram-mini-app/session", { initData: "signed" })).resolves.toEqual(legacyState);
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
