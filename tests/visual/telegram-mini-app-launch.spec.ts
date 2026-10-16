import { expect, test } from "@playwright/test";
import {
  installTelegramSdkFixture,
  TELEGRAM_SDK_URL,
  TELEGRAM_SIGNED_LAUNCH_PATH,
  telegramSdkBody,
  trackMiniAppSessionRequests,
} from "./telegram-mini-app-fixtures";

test("standalone Mini App stays in preview after the Telegram SDK loads", async ({ page }) => {
  const sessionRequests = await trackMiniAppSessionRequests(page);
  let sdkRequested = false;
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    sdkRequested = true;
    await route.fulfill({ status: 200, contentType: "text/javascript", body: telegramSdkBody("", "unknown") });
  });

  await page.goto("/pharoswatchbot/app/", { waitUntil: "domcontentloaded" });

  await expect.poll(() => sdkRequested).toBe(true);
  await expect(page.getByRole("heading", { name: "PharosWatchBot app preview" })).toBeVisible({ timeout: 1_500 });
  await expect(page.getByRole("link", { name: "Open PharosWatchBot" })).toHaveAttribute("href", "https://t.me/PharosWatchBot");
  expect(sessionRequests.count()).toBe(0);
});

test("a delayed Telegram SDK completes a supported signed launch", async ({ page }) => {
  const sessionRequests = await trackMiniAppSessionRequests(page);
  await installTelegramSdkFixture(page, { delayMs: 300 });

  await page.goto(
    TELEGRAM_SIGNED_LAUNCH_PATH,
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible({ timeout: 2_000 });
  expect(sessionRequests.count()).toBe(1);
});

test("an unsupported Telegram host receives the non-sensitive preview", async ({ page }) => {
  const sessionRequests = await trackMiniAppSessionRequests(page);
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: telegramSdkBody("signed-init-data", "unknown"),
    });
  });

  await page.goto(
    "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown",
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "PharosWatchBot app preview" })).toBeVisible({ timeout: 1_500 });
  expect(sessionRequests.count()).toBe(0);
});
