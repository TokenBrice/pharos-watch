// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  TelegramMiniAppStateSchema,
  createTelegramMiniAppSnapshot,
  telegramMiniAppStateRevision,
  type TelegramMiniAppState,
} from "@shared/lib/telegram-mini-app-contract";
import { SchemaValidationError } from "@/lib/api";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  postMiniAppBulkWatchlistPreview,
  postMiniAppPortability,
  postMiniAppSnapshot,
  postMiniAppState,
  refreshMiniAppBundleOnce,
} from "./mini-app-api";
import { makeMiniAppState } from "./mini-app-state.test-support";

const { catalog: _catalog, ...mutableState } = makeMiniAppState({
  subscriber: { recap: { available: false } },
});

const legacyState: TelegramMiniAppState = {
  ...mutableState,
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [{ stablecoinId: "legacy", symbol: "OLD", name: "Old Worker" }],
  },
};

const normalizedLegacyState = (() => {
  const state = TelegramMiniAppStateSchema.parse(legacyState);
  const { catalog: _catalog, ...mutable } = state;
  return { state, mutable };
})();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mini App versioned API client", () => {
  it("sends version capabilities and hydrates a compact snapshot from the bundled catalog", async () => {
    const fetchMock = mockFetch([{
      match: "/api/telegram-mini-app/session",
      body: createTelegramMiniAppSnapshot(mutableState),
    }], { requireMatch: true });

    const snapshot = await postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(requestUrl.searchParams.getAll(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toEqual([
      TELEGRAM_MINI_APP_CONTRACT_VERSION,
    ]);
    expect(requestUrl.searchParams.getAll(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toEqual([
      TELEGRAM_MINI_APP_CATALOG_VERSION,
    ]);
    expect(snapshot.state.catalog.searchableCoins.length).toBeGreaterThan(300);
    expect(snapshot.stateRevision).toBe(createTelegramMiniAppSnapshot(mutableState).stateRevision);
  });

  it("appends one version pair after an existing query", async () => {
    const fetchMock = mockFetch([{
      match: "/api/telegram-mini-app/session",
      body: legacyState,
    }], { requireMatch: true });

    await postMiniAppSnapshot("/api/telegram-mini-app/session?source=test", { initData: "signed" });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(requestUrl.searchParams.get("source")).toBe("test");
    expect(requestUrl.searchParams.getAll(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toEqual([
      TELEGRAM_MINI_APP_CONTRACT_VERSION,
    ]);
    expect(requestUrl.searchParams.getAll(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toEqual([
      TELEGRAM_MINI_APP_CATALOG_VERSION,
    ]);
  });

  it("keeps a new client compatible with an old Worker's full-catalog response", async () => {
    mockFetch([{ match: "/api/telegram-mini-app/session", body: legacyState }], { requireMatch: true });

    const snapshot = await postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" });

    expect(snapshot.state.catalog.searchableCoins).toEqual(legacyState.catalog.searchableCoins);
    expect(snapshot.state.subscriber.recap.available).toBe(false);
    expect(snapshot.stateRevision).toBe(telegramMiniAppStateRevision(normalizedLegacyState.mutable));
  });

  it.each([
    ["contractVersion", "worker-contract-next", "contract-version-mismatch"],
    ["catalogVersion", "worker-catalog-next", "catalog-version-mismatch"],
  ] as const)("rejects a compact snapshot with an incompatible %s", async (field, value, code) => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      body: { ...createTelegramMiniAppSnapshot(mutableState), [field]: value },
    }], { requireMatch: true });

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 409, code });
  });

  it("rejects malformed success payloads before they reach Mini App state", async () => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      body: { state: "invalid" },
    }], { requireMatch: true });

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("caps an oversized retry delay reported by the Mini App API", async () => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      status: 429,
      body: { code: "rate-limited", retryAfterSec: 7_200.5 },
    }], { requireMatch: true });

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 429, code: "rate-limited", retryAfterSec: 3_600 });
  });

  it("resolves the retry delay from the parsed body before the Retry-After header", async () => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      status: 429,
      body: { code: "rate-limited", retryAfterSec: 120 },
      headers: { "Retry-After": "30" },
    }], { requireMatch: true });
    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 429, code: "rate-limited", retryAfterSec: 120 });

    mockFetch([{
      match: "/api/telegram-mini-app/session",
      status: 503,
      body: { code: "internal", retryAfterSec: 0 },
      headers: { "Retry-After": "30" },
    }], { requireMatch: true });
    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 503, code: "internal", retryAfterSec: 30 });
  });

  it.each([
    [0.2, 1],
    ["90", 90],
    [-5, null],
    ["soon", null],
  ] as const)("normalizes a retryAfterSec of %s to %s", async (retryAfterSec, expected) => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      status: 429,
      body: { code: "rate-limited", retryAfterSec },
    }], { requireMatch: true });

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 429, code: "rate-limited", retryAfterSec: expected });
  });

  it("keeps the HTTP status and header delay when the error body is not JSON", async () => {
    mockFetch([{
      match: "/api/telegram-mini-app/session",
      respond: () => ({
        response: new Response("<html>bad gateway</html>", { status: 504, headers: { "Retry-After": "45" } }),
      }),
    }], { requireMatch: true });

    await expect(postMiniAppSnapshot("/api/telegram-mini-app/session", { initData: "signed" }))
      .rejects.toMatchObject({ status: 504, code: null, retryAfterSec: 45 });
  });

  it("keeps the state-only compatibility wrapper for callers that do not need revision metadata", async () => {
    mockFetch([{ match: "/api/telegram-mini-app/session", body: legacyState }], { requireMatch: true });

    await expect(postMiniAppState("/api/telegram-mini-app/session", { initData: "signed" }))
      .resolves.toEqual(normalizedLegacyState.state);
  });

  it("validates a versioned portable watchlist preview without hydrating state", async () => {
    mockFetch([{
      match: "/api/telegram-mini-app/mutate",
      body: {
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
      },
    }], { requireMatch: true });

    await expect(postMiniAppPortability("/api/telegram-mini-app/mutate", {
      initData: "signed",
      operation: { kind: "export-watchlist" },
    })).resolves.toMatchObject({ result: { kind: "watchlist-import-preview" } });
  });

  it.each([
    ["contractVersion", "worker-contract-next", "contract-version-mismatch"],
    ["catalogVersion", "worker-catalog-next", "catalog-version-mismatch"],
  ] as const)("rejects a portable watchlist response with an incompatible %s", async (field, value, code) => {
    mockFetch([{
      match: "/api/telegram-mini-app/mutate",
      body: {
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        [field]: value,
        result: { kind: "watchlist-export", token: "signed-export", directCount: 1, presetCount: 0 },
      },
    }], { requireMatch: true });

    await expect(postMiniAppPortability("/api/telegram-mini-app/mutate", {
      initData: "signed",
      operation: { kind: "export-watchlist" },
    })).rejects.toMatchObject({ status: 409, code });
  });

  it("uses the versioned signed transport for bulk watchlist previews", async () => {
    const fetchMock = mockFetch([{
      match: "/api/telegram-mini-app/mutate",
      body: {
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
      },
    }], { requireMatch: true });

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

  it("does not auto-refresh when the browser denies session storage access", () => {
    const refresh = vi.fn();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(refreshMiniAppBundleOnce(
      { contractVersion: "3", catalogVersion: "catalog-v2-next" },
      { refresh },
    )).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh when recording the version target fails", () => {
    const refresh = vi.fn();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    };

    expect(refreshMiniAppBundleOnce(
      { contractVersion: "3", catalogVersion: "catalog-v2-next" },
      { storage, refresh },
    )).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes again when a genuinely new version target is recorded", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const refresh = vi.fn();

    expect(refreshMiniAppBundleOnce(
      { contractVersion: "3", catalogVersion: "catalog-v2" },
      { storage, refresh },
    )).toBe(true);
    expect(refreshMiniAppBundleOnce(
      { contractVersion: "4", catalogVersion: "catalog-v2" },
      { storage, refresh },
    )).toBe(true);
    expect(refreshMiniAppBundleOnce(
      { contractVersion: "4", catalogVersion: "catalog-v2" },
      { storage, refresh },
    )).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
