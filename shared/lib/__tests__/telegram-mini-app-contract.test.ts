import { describe, expect, it } from "vitest";
import { TELEGRAM_MINI_APP_CATALOG } from "../telegram-mini-app-catalog";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TelegramMiniAppCatalogSchema,
  TelegramMiniAppMutationRequestSchema,
  TelegramMiniAppOperationSchema,
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
      depegStepBps: 250,
    },
    quietHours: {
      enabled: false,
      startHourUtc: null,
      endHourUtc: null,
      timezone: "UTC",
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

  it("derives one shared catalog version from the generated bundled catalog", () => {
    expect(TelegramMiniAppCatalogSchema.parse(TELEGRAM_MINI_APP_CATALOG).searchableCoins.length).toBeGreaterThan(300);
    expect(TELEGRAM_MINI_APP_CATALOG_VERSION).toMatch(/^catalog-v1-[0-9a-f]{8}$/);
    expect(JSON.stringify(TELEGRAM_MINI_APP_CATALOG).length).toBeGreaterThan(40_000);
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
