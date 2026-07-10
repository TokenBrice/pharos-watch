import { expect, test, type Page } from "@playwright/test";

const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

const MINI_APP_STATE = {
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

function sdkBody(initData: string, platform: string): string {
  return `window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    platform: ${JSON.stringify(platform)},
    initDataUnsafe: { user: { username: "watcher" } },
    ready() {}, expand() {}, onEvent() {}, offEvent() {}
  } };`;
}

async function trackSessionRequests(page: Page): Promise<{ count: () => number }> {
  let sessionRequestCount = 0;
  await page.route("**/api/telegram-mini-app/session", async (route) => {
    sessionRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MINI_APP_STATE),
    });
  });
  return { count: () => sessionRequestCount };
}

test("standalone Mini App stays in preview after the Telegram SDK loads", async ({ page }) => {
  const sessionRequests = await trackSessionRequests(page);
  let sdkRequested = false;
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    sdkRequested = true;
    await route.fulfill({ status: 200, contentType: "text/javascript", body: sdkBody("", "unknown") });
  });

  await page.goto("/pharoswatchbot/app/", { waitUntil: "domcontentloaded" });

  await expect.poll(() => sdkRequested).toBe(true);
  await expect(page.getByRole("heading", { name: "PharosWatchBot app preview" })).toBeVisible({ timeout: 1_500 });
  await expect(page.getByRole("link", { name: "Open PharosWatchBot" })).toHaveAttribute("href", "https://t.me/PharosWatchBot");
  expect(sessionRequests.count()).toBe(0);
});

test("a delayed Telegram SDK completes a supported signed launch", async ({ page }) => {
  const sessionRequests = await trackSessionRequests(page);
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: sdkBody("signed-init-data", "tdesktop"),
    });
  });

  await page.goto(
    "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop",
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible({ timeout: 2_000 });
  expect(sessionRequests.count()).toBe(1);
});

test("an unsupported Telegram host receives the non-sensitive preview", async ({ page }) => {
  const sessionRequests = await trackSessionRequests(page);
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: sdkBody("signed-init-data", "unknown"),
    });
  });

  await page.goto(
    "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown",
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "PharosWatchBot app preview" })).toBeVisible({ timeout: 1_500 });
  expect(sessionRequests.count()).toBe(0);
});
