import type { Page } from "@playwright/test";

export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";
export const TELEGRAM_SIGNED_LAUNCH_PATH =
  "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop";

export const MINI_APP_STATE = {
  viewer: {
    userId: "42",
    username: "watcher",
    firstName: null,
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
  catalog: { recommendedPresets: [], searchableCoins: [] },
  health: {
    lastSuccessfulDeliveryAt: null,
    lastSuccessfulReplyAt: null,
    queuedAlerts: 0,
    recentFailureClass: null,
  },
};

export interface TelegramSdkFixtureOptions {
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  safeAreaInset?: { top?: number; right?: number; bottom?: number; left?: number };
  contentSafeAreaInset?: { top?: number; right?: number; bottom?: number; left?: number };
  autoConfirm?: boolean;
}

export function telegramSdkBody(
  initData: string,
  platform: string,
  options: TelegramSdkFixtureOptions = {},
): string {
  return `window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    platform: ${JSON.stringify(platform)},
    colorScheme: ${JSON.stringify(options.colorScheme)},
    themeParams: ${JSON.stringify(options.themeParams)},
    safeAreaInset: ${JSON.stringify(options.safeAreaInset)},
    contentSafeAreaInset: ${JSON.stringify(options.contentSafeAreaInset)},
    initDataUnsafe: { user: { username: "watcher" } },
    ready() {}, expand() {}, onEvent() {}, offEvent() {},
    isVersionAtLeast() { return true; },
    ${options.autoConfirm ? "showConfirm(_message, callback) { callback(true); }," : ""}
  } };`;
}

export async function trackMiniAppSessionRequests(
  page: Page,
  state: unknown | (() => unknown) = MINI_APP_STATE,
): Promise<{ count: () => number }> {
  let sessionRequestCount = 0;
  await page.route("**/api/telegram-mini-app/session*", async (route) => {
    sessionRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(typeof state === "function" ? state() : state),
    });
  });
  return { count: () => sessionRequestCount };
}

export async function installTelegramSdkFixture(
  page: Page,
  options: {
    initData?: string;
    platform?: string;
    sdk?: TelegramSdkFixtureOptions;
    delayMs?: number;
  } = {},
): Promise<void> {
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: telegramSdkBody(options.initData ?? "signed-init-data", options.platform ?? "tdesktop", options.sdk),
    });
  });
}
