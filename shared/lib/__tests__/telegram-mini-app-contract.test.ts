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
  TelegramMiniAppResponseSchema,
  createTelegramMiniAppSnapshot,
  telegramMiniAppVersionCompatibility,
  type TelegramMiniAppOperation,
} from "../telegram-mini-app-contract";
import { makeMiniAppState } from "../../test-utils/telegram-mini-app-state";
import {
  TELEGRAM_DEWS_BANDS, TELEGRAM_SAFETY_MODES, TELEGRAM_DEPEG_STEPS,
  TelegramDewsBandSchema, TelegramSafetyModeSchema, TelegramDepegStepBpsSchema,
  isDepegStepValue, isTelegramSafetyMode,
} from "../../types/status/telegram";
import {
  DEWS_BAND_CODES, DEWS_BAND_CODE_BY_VALUE, isDewsBandCode,
  SAFETY_MODE_CODES, SAFETY_MODE_CODE_BY_VALUE, isSafetyModeCode,
} from "../telegram-alert-families";
import { isDewsAlertBand } from "../classification/risk";

const { catalog: _catalog, ...mutableState } = makeMiniAppState({
  subscriptions: [],
  health: { lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null },
});

const operations: TelegramMiniAppOperation[] = [
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
  { kind: "unsubscribe-all" },
  { kind: "forget-me" },
  { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { dews: true } } },
  { kind: "remove-coin", stablecoinId: "usdc-circle" },
  { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } },
  { kind: "unfollow-preset", presetId: "usd-top10" },
];

describe("Telegram Mini App shared contract", () => {
  it("validates every canonical tuning value and round-trips bijective callback maps", () => {
    for (const [values, schema, codes, inverse, guard] of [
      [TELEGRAM_DEWS_BANDS, TelegramDewsBandSchema, DEWS_BAND_CODES, DEWS_BAND_CODE_BY_VALUE, isDewsBandCode],
      [TELEGRAM_SAFETY_MODES, TelegramSafetyModeSchema, SAFETY_MODE_CODES, SAFETY_MODE_CODE_BY_VALUE, isSafetyModeCode],
    ] as const) {
      expect(new Set(Object.values(codes)).size).toBe(values.length);
      expect(Object.values(codes)).toEqual([...values]);
      for (const value of values) {
        expect(schema.parse(value)).toBe(value);
        const code = (inverse as Record<string, string>)[value];
        expect(guard(code)).toBe(true);
        expect((codes as Record<string, string>)[code]).toBe(value);
      }
      for (const invalid of ["0", "", "constructor", "toString"]) expect(guard(invalid)).toBe(false);
    }
    for (const dewsMinBand of TELEGRAM_DEWS_BANDS) {
      expect(isDewsAlertBand(dewsMinBand)).toBe(true);
      expect(TelegramMiniAppOperationSchema.parse({
        kind: "set-coin", stablecoinId: "usdc-circle", patch: { dewsMinBand },
      })).toMatchObject({ patch: { dewsMinBand } });
    }
    for (const safetyMode of TELEGRAM_SAFETY_MODES) {
      expect(isTelegramSafetyMode(safetyMode)).toBe(true);
      expect(TelegramMiniAppOperationSchema.parse({
        kind: "set-coin", stablecoinId: "usdc-circle", patch: { safetyMode },
      })).toMatchObject({ patch: { safetyMode } });
    }
    for (const depegStepBps of TELEGRAM_DEPEG_STEPS) {
      expect(isDepegStepValue(depegStepBps)).toBe(true);
      expect(TelegramDepegStepBpsSchema.parse(depegStepBps)).toBe(depegStepBps);
      expect(TelegramMiniAppOperationSchema.parse({
        kind: "set-coin", stablecoinId: "usdc-circle", patch: { depegStepBps },
      })).toMatchObject({ patch: { depegStepBps } });
    }
    for (const invalid of [0, 99, null, undefined, "100"]) expect(isDepegStepValue(invalid)).toBe(false);
    for (const invalid of ["off", "", null, undefined]) expect(isTelegramSafetyMode(invalid)).toBe(false);
  });

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

  it("rejects a one-sided quiet-hours window that defaults into start === end", () => {
    // An omitted counterpart keeps its default, so these would persist 7-7 and
    // 22-22: enabled quiet hours that never suppress a delivery.
    for (const operation of [
      { kind: "set-quiet-hours", enabled: true, startHourUtc: 7 },
      { kind: "set-quiet-hours", enabled: true, endHourUtc: 22 },
    ]) {
      expect(TelegramMiniAppOperationSchema.safeParse(operation).success).toBe(false);
    }
    expect(TelegramMiniAppOperationSchema.safeParse({ kind: "set-quiet-hours", enabled: true }).success).toBe(true);
    expect(TelegramMiniAppOperationSchema.safeParse({
      kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7,
    }).success).toBe(true);
  });

  it("rejects retired recap operations at standalone and signed request boundaries", () => {
    for (const enabled of [true, false]) {
      const operation = { kind: "set-recap", enabled, deliveryHourLocal: 9 };
      expect(TelegramMiniAppOperationSchema.safeParse(operation).success).toBe(false);
      expect(TelegramMiniAppMutationRequestSchema.safeParse({
        initData: "signed",
        contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
        operation,
      }).success).toBe(false);
    }
    expect(createTelegramMiniAppSnapshot(mutableState).state.subscriber).not.toHaveProperty("recap");
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

  it("rejects the retired watchlist token export and import operations", () => {
    for (const kind of ["export-watchlist", "preview-watchlist-import", "confirm-watchlist-import"]) {
      expect(TelegramMiniAppOperationSchema.safeParse({ kind, token: "pw2.token.digest" }).success).toBe(false);
    }
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
    for (const kind of ["confirm-bulk-watchlist", "undo-bulk-watchlist"] as const) {
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

  it("accepts an optional NAV peg label on catalog coins", () => {
    expect(TelegramMiniAppCatalogSchema.safeParse({
      ...TELEGRAM_MINI_APP_CATALOG,
      searchableCoins: [{
        stablecoinId: "susde-ethena",
        symbol: "sUSDe",
        name: "Ethena Staked USDe",
        peg: "USD",
        pegLabel: "USDe NAV",
      }],
    }).success).toBe(true);
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
    for (const contractVersion of ["5", "6"]) {
      expect(telegramMiniAppVersionCompatibility({
        contractVersion,
        catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      })).toBe("contract-version-mismatch");
      expect(telegramMiniAppVersionCompatibility({ contractVersion })).toBe("contract-version-mismatch");
      expect(telegramMiniAppVersionCompatibility({
        contractVersion, catalogVersion: "not-the-current-catalog",
      })).toBe("contract-version-mismatch");
    }
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
