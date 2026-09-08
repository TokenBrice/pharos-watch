import { describe, expect, it } from "vitest";
import { TELEGRAM_MINI_APP_CATALOG } from "../telegram-mini-app-catalog";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TelegramMiniAppCatalogSchema,
  TelegramMiniAppBulkWatchlistResponseSchema,
  TelegramMiniAppMutableStateSchema,
  TelegramMiniAppMutationRequestSchema,
  TelegramMiniAppOperationSchema,
  TelegramMiniAppPortabilityResponseSchema,
  TelegramMiniAppResponseSchema,
  createTelegramMiniAppSnapshot,
  telegramMiniAppVersionCompatibility,
  type TelegramMiniAppMutableState,
  type TelegramMiniAppOperation,
} from "../telegram-mini-app-contract";

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
    quietHours: {
      enabled: false,
      startHourUtc: null,
      endHourUtc: null,
      timezone: "UTC",
    },
    recap: {
      available: true,
      enabled: false,
      deliveryHourLocal: 9,
      timezoneConfirmed: true,
      nextDueAt: null,
      lastWindowEndAt: null,
      lastDeliveredLocalDate: null,
      lastOutcome: null,
    },
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

const operations: TelegramMiniAppOperation[] = [
  { kind: "export-watchlist" },
  { kind: "preview-watchlist-import", token: "pw2.token.digest" },
  { kind: "confirm-watchlist-import", token: "pw2.token.digest", expectedPreferenceGeneration: 4, previewFingerprint: "preview-v1-12-deadbeef" },
  { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdc-circle"], removeStablecoinIds: ["dai-makerdao"] },
  { kind: "confirm-bulk-watchlist", addStablecoinIds: ["usdc-circle"], removeStablecoinIds: [], expectedPreferenceGeneration: 4, previewFingerprint: "preview-v1-12-deadbeef" },
  { kind: "undo-bulk-watchlist", restoreDirectRows: [{ stablecoinId: "dai-makerdao", alertDews: true, alertDepeg: true, alertSafety: false, alertLaunch: false, alertReserve: false, overrideDews: true, overrideDepeg: true, overrideSafety: false, overrideLaunch: false, overrideReserve: false, dewsMinBand: null, safetyMode: null, depegWorseningBpsStep: null }], removeStablecoinIds: ["usdc-circle"], expectedPreferenceGeneration: 5, expectedFingerprint: "preview-v1-12-deadbeef" },
  { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
  { kind: "set-global", alertType: "reserve", enabled: true },
  { kind: "set-global-depeg-step", depegStepBps: 500 },
  { kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7 },
  { kind: "clear-snooze" },
  { kind: "set-snooze", durationToken: "4h" },
  { kind: "pause" },
  { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" },
  { kind: "set-timezone", timezone: "Europe/Paris" },
  { kind: "set-recap", enabled: true, deliveryHourLocal: 9 },
  { kind: "unsubscribe-all" },
  { kind: "forget-me" },
  { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { dews: true } } },
  { kind: "remove-coin", stablecoinId: "usdc-circle" },
  { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } },
  { kind: "unfollow-preset", presetId: "usd-top10" },
];

describe("Telegram Mini App shared contract", () => {
  it("uses the same operation parser for standalone and mutation-request parsing", () => {
    for (const operation of operations) {
      const direct = TelegramMiniAppOperationSchema.parse(operation);
      const request = TelegramMiniAppMutationRequestSchema.parse({
        initData: "signed",
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        operation,
      });
      expect(request.operation).toEqual(direct);
    }

    expect(
      TelegramMiniAppOperationSchema.safeParse({
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: {},
      }).success,
    ).toBe(false);
  });

  it("parses both the compact contract and the rolling-deploy legacy response", () => {
    const snapshot = createTelegramMiniAppSnapshot(mutableState);
    const legacy = { ...mutableState, catalog: TELEGRAM_MINI_APP_CATALOG };

    expect(TelegramMiniAppResponseSchema.parse(snapshot)).toEqual(snapshot);
    expect(TelegramMiniAppResponseSchema.parse(legacy)).toMatchObject({
      viewer: { userId: "42" },
      catalog: { searchableCoins: expect.any(Array) },
    });
  });

  it("requires the exact, versioned portability preview response", () => {
    expect(TelegramMiniAppPortabilityResponseSchema.safeParse({
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      result: {
        kind: "watchlist-import-preview",
        expectedPreferenceGeneration: 4,
        previewFingerprint: "preview-v1-12-deadbeef",
        preview: {
          directAdds: ["usdc-circle"],
          directRemoves: [],
          directChanges: [],
          presetAdds: [],
          presetRemoves: [],
          presetChanges: [],
          directBroadenedCoverage: [{ id: "usdc-circle", alertTypes: ["dews"] }],
          directRemovedCoverage: [],
          presetBroadenedCoverage: [],
          presetRemovedCoverage: [],
        },
      },
    }).success).toBe(true);
  });

  it("bounds bulk watchlist selections and requires a server-issued undo state fingerprint", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `coin-${index}`);
    expect(TelegramMiniAppOperationSchema.safeParse({
      kind: "preview-bulk-watchlist",
      addStablecoinIds: twenty,
      removeStablecoinIds: [],
    }).success).toBe(true);
    expect(TelegramMiniAppOperationSchema.safeParse({
      kind: "preview-bulk-watchlist",
      addStablecoinIds: [...twenty, "coin-20"],
      removeStablecoinIds: [],
    }).success).toBe(false);
    const response = {
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      result: {
        kind: "bulk-watchlist-preview",
        expectedPreferenceGeneration: 4,
        previewFingerprint: "preview-v1-12-deadbeef",
        adds: ["usdc-circle"],
        removes: ["dai-makerdao"],
        unchanged: [],
        sourceImpact: [{ stablecoinId: "dai-makerdao", action: "remove", inheritedSourcesAfter: ["preset"] }],
        undo: {
          expectedPreferenceGeneration: 5,
          expectedFingerprint: "preview-v1-12-deadbeef",
          restoreDirectRows: [],
          removeStablecoinIds: ["usdc-circle"],
        },
      },
    };
    expect(TelegramMiniAppBulkWatchlistResponseSchema.safeParse(response).success).toBe(true);
    for (const fingerprint of [undefined, "preview-v1-12-nothex00"]) {
      expect(TelegramMiniAppBulkWatchlistResponseSchema.safeParse({
        ...response,
        result: { ...response.result, previewFingerprint: fingerprint },
      }).success).toBe(false);
      expect(TelegramMiniAppBulkWatchlistResponseSchema.safeParse({
        ...response,
        result: { ...response.result, undo: { ...response.result.undo, expectedFingerprint: fingerprint } },
      }).success).toBe(false);
    }
  });

  it("rejects invalid bulk selections at preview and confirmation boundaries", () => {
    const ids = Array.from({ length: 21 }, (_, index) => `coin-${index}`);
    for (const kind of ["preview-bulk-watchlist", "confirm-bulk-watchlist"]) {
      const base = {
        kind,
        ...(kind === "confirm-bulk-watchlist"
          ? { expectedPreferenceGeneration: 4, previewFingerprint: "preview-v1-12-deadbeef" }
          : {}),
      };
      expect(TelegramMiniAppOperationSchema.safeParse({
        ...base, addStablecoinIds: ids.slice(0, 10), removeStablecoinIds: ids.slice(10, 20),
      }).success).toBe(true);
      for (const [addStablecoinIds, removeStablecoinIds] of [
        [ids.slice(0, 11), ids.slice(11)],
        [["a", "a"], []],
        [[], ["a", "a"]],
        [["a"], ["a"]],
        [[], []],
      ]) {
        expect(TelegramMiniAppOperationSchema.safeParse({
          ...base, addStablecoinIds, removeStablecoinIds,
        }).success, `${kind}: ${JSON.stringify([addStablecoinIds, removeStablecoinIds])}`).toBe(false);
      }
    }
  });

  it("rejects absent and malformed confirmation and undo fingerprints", () => {
    for (const kind of ["confirm-watchlist-import", "confirm-bulk-watchlist", "undo-bulk-watchlist"] as const) {
      const operation = operations.find((entry) => entry.kind === kind)!;
      expect(TelegramMiniAppOperationSchema.safeParse(operation).success).toBe(true);
      const key = kind === "undo-bulk-watchlist" ? "expectedFingerprint" : "previewFingerprint";
      const missing = { ...operation } as Record<string, unknown>;
      delete missing[key];
      expect(TelegramMiniAppOperationSchema.safeParse(missing).success).toBe(false);
      expect(TelegramMiniAppOperationSchema.safeParse({ ...operation, [key]: "preview-v1-12-nothex00" }).success).toBe(false);
    }
  });

  it("rejects duplicate, overlapping and oversized undo selections", () => {
    const operation = operations.find((entry) => entry.kind === "undo-bulk-watchlist")!;
    if (operation.kind !== "undo-bulk-watchlist") throw new Error("Missing undo fixture");
    const row = operation.restoreDirectRows[0];
    const restoreDirectRows = Array.from({ length: 10 }, (_, index) => ({ ...row, stablecoinId: `restore-${index}` }));
    const removeStablecoinIds = Array.from({ length: 10 }, (_, index) => `remove-${index}`);
    expect(TelegramMiniAppOperationSchema.safeParse({ ...operation, restoreDirectRows, removeStablecoinIds }).success).toBe(true);
    for (const selection of [
      { restoreDirectRows: [row, row], removeStablecoinIds: [] },
      { restoreDirectRows: [row], removeStablecoinIds: [row.stablecoinId] },
      { restoreDirectRows, removeStablecoinIds: [...removeStablecoinIds, "extra"] },
    ]) {
      expect(TelegramMiniAppOperationSchema.safeParse({ ...operation, ...selection }).success).toBe(false);
    }
  });

  it("derives one shared catalog version from the generated bundled catalog", () => {
    expect(TelegramMiniAppCatalogSchema.safeParse(TELEGRAM_MINI_APP_CATALOG).success).toBe(true);
    expect(TELEGRAM_MINI_APP_CATALOG_VERSION).toMatch(/^catalog-v1-[0-9a-f]{8}$/);
  });

  it("rejects unknown preset ids at catalog and mutable-state boundaries", () => {
    expect(TelegramMiniAppCatalogSchema.safeParse({
      ...TELEGRAM_MINI_APP_CATALOG,
      recommendedPresets: [{ id: "unknown-preset", label: "Unknown" }],
    }).success).toBe(false);
    expect(TelegramMiniAppMutableStateSchema.safeParse({
      ...mutableState,
      presets: [{
        id: "unknown-preset",
        label: "Unknown",
        alertTypes: { dews: true, depeg: false, safety: false },
        depegStepBps: null,
      }],
    }).success).toBe(false);
  });

  it("distinguishes rolling-deploy compatibility without accepting partial capabilities", () => {
    expect(telegramMiniAppVersionCompatibility({})).toBe("legacy");
    expect(
      telegramMiniAppVersionCompatibility({
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      }),
    ).toBe("compatible");
    expect(
      telegramMiniAppVersionCompatibility({
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      }),
    ).toBe("catalog-version-mismatch");
    expect(
      telegramMiniAppVersionCompatibility({
        contractVersion: "1",
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      }),
    ).toBe("contract-version-mismatch");
  });
});
