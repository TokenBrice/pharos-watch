import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  installTelegramSdkFixture,
  MINI_APP_STATE,
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

test("the signed Mini App keeps compact controls usable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const sessionRequests = await trackMiniAppSessionRequests(page, {
    ...MINI_APP_STATE,
    subscriptions: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        alertTypes: { dews: true, depeg: true, safety: false, launch: false, reserve: false },
        dewsMinBand: "ALERT",
        depegStepBps: 250,
        safetyMode: null,
        snoozeUntilTs: null,
      },
    ],
  });
  await installTelegramSdkFixture(page);

  await page.goto(
    TELEGRAM_SIGNED_LAUNCH_PATH,
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible({ timeout: 2_000 });
  expect(sessionRequests.count()).toBe(1);

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  for (const label of ["home", "watchlist", "presets", "settings"]) {
    const tab = page.getByRole("tab", { name: label });
    await expect(tab).toBeVisible();
    expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }

  const refreshBox = await page.getByRole("button", { name: "Refresh session" }).boundingBox();
  expect(refreshBox?.width).toBeGreaterThanOrEqual(44);
  expect(refreshBox?.height).toBeGreaterThanOrEqual(44);

  await page.getByRole("tab", { name: "watchlist" }).click();
  for (const target of [
    page.getByRole("button", { name: "Remove USDC" }),
    page.locator("summary").filter({ hasText: "Snooze USDC" }),
    page.locator("summary").filter({ hasText: "Tune USDC" }),
  ]) {
    const box = await target.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("an authenticated 320px Mini App repairs hostile Telegram theme contrast", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await trackMiniAppSessionRequests(page);
  await page.route(TELEGRAM_SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: telegramSdkBody("signed-init-data", "tdesktop", {
        colorScheme: "light",
        themeParams: {
          bg_color: "#ffffff",
          text_color: "#fefefe",
          secondary_bg_color: "#fdfdfd",
          section_bg_color: "#fcfcfc",
          hint_color: "#fafafa",
          subtitle_text_color: "#fbfbfb",
          button_color: "#fefefe",
          button_text_color: "#ffffff",
          link_color: "#f8f8f8",
          accent_text_color: "#f7f7f7",
          section_header_text_color: "#f6f6f6",
          destructive_text_color: "#f5f5f5",
        },
      }),
    });
  });

  await page.goto(
    TELEGRAM_SIGNED_LAUNCH_PATH,
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible({ timeout: 5_000 });
  const results = await new AxeBuilder({ page })
    .include(".pharos-mini-app")
    .withRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.locator(".pharos-mini-app").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
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
