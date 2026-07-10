import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TAGS, summarizeViolations } from "./a11y/axe-shared";
import {
  installTelegramSdkFixture,
  MINI_APP_STATE,
  TELEGRAM_SIGNED_LAUNCH_PATH,
  trackMiniAppSessionRequests,
} from "./telegram-mini-app-fixtures";

const LIGHT_THEME = {
  bg_color: "#ffffff",
  text_color: "#111827",
  secondary_bg_color: "#f3f4f6",
  section_bg_color: "#ffffff",
  hint_color: "#4b5563",
  subtitle_text_color: "#4b5563",
  button_color: "#1266a3",
  button_text_color: "#ffffff",
  link_color: "#1266a3",
};

const DARK_THEME = {
  bg_color: "#111827",
  text_color: "#f9fafb",
  secondary_bg_color: "#1f2937",
  section_bg_color: "#1f2937",
  hint_color: "#d1d5db",
  subtitle_text_color: "#d1d5db",
  button_color: "#75bdf2",
  button_text_color: "#111827",
  link_color: "#75bdf2",
};

const POPULATED_STATE = {
  ...MINI_APP_STATE,
  subscriber: {
    ...MINI_APP_STATE.subscriber,
    quietHours: {
      enabled: true,
      startHourUtc: 22,
      endHourUtc: 7,
      timezone: "Europe/Belgrade",
    },
  },
  presets: [
    {
      id: "usd-top25",
      label: "USD Top 25",
      description: "Largest USD-pegged stablecoins",
      alertTypes: { dews: true, depeg: true, safety: false },
      depegStepBps: 250,
    },
  ],
  subscriptions: [
    {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      alertTypes: { dews: true, depeg: true, safety: false, launch: false, reserve: true },
      dewsMinBand: "ALERT",
      depegStepBps: 250,
      safetyMode: null,
      snoozeUntilTs: null,
    },
    {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      name: "Tether",
      alertTypes: { dews: true, depeg: false, safety: true, launch: false, reserve: false },
      dewsMinBand: "WARNING",
      depegStepBps: null,
      safetyMode: "all",
      snoozeUntilTs: null,
    },
  ],
  catalog: {
    recommendedPresets: [
      { id: "usd-top25", label: "USD Top 25", description: "Largest USD-pegged stablecoins" },
      { id: "euro-stablecoins", label: "Euro stablecoins", description: "Tracked EUR-pegged assets" },
    ],
    searchableCoins: [
      { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", peg: "USD" },
      { stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD" },
      { stablecoinId: "eurc-circle", symbol: "EURC", name: "Euro Coin", peg: "EUR" },
    ],
  },
  health: {
    lastSuccessfulDeliveryAt: 1_700_000_000,
    lastSuccessfulReplyAt: 1_700_000_100,
    queuedAlerts: 2,
    recentFailureClass: null,
  },
};

async function expectAxeClean(page: Page, stateName: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    summarizeViolations(`/pharoswatchbot/app#${stateName}`, results.violations),
    `axe-core violations (${stateName})`,
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "Mini App must reflow without page-level horizontal scrolling",
  ).toBe(true);
}

async function launchSignedMiniApp(page: Page): Promise<void> {
  await page.goto(TELEGRAM_SIGNED_LAUNCH_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible({ timeout: 5_000 });
}

test.describe("authenticated Telegram Mini App accessibility", () => {
  test("populated light state covers every panel at 320px with safe areas and keyboard tabs", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await trackMiniAppSessionRequests(page, POPULATED_STATE);
    await installTelegramSdkFixture(page, {
      sdk: {
        colorScheme: "light",
        themeParams: LIGHT_THEME,
        safeAreaInset: { top: 12, right: 3, bottom: 14, left: 4 },
        contentSafeAreaInset: { top: 6, right: 5, bottom: 8, left: 7 },
      },
    });
    await launchSignedMiniApp(page);

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--telegram-safe-area-top").trim())).toBe("18px");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--telegram-safe-area-bottom").trim())).toBe("22px");

    await expectAxeClean(page, "home-light-narrow");
    await expectNoHorizontalOverflow(page);

    const homeTab = page.getByRole("tab", { name: "home" });
    await homeTab.focus();
    await page.keyboard.press("ArrowRight");
    const watchlistTab = page.getByRole("tab", { name: "watchlist" });
    await expect(watchlistTab).toBeFocused();
    await expect(watchlistTab).toHaveAttribute("aria-selected", "true");
    expect(await watchlistTab.evaluate((element) => getComputedStyle(element).boxShadow !== "none")).toBe(true);
    await expectAxeClean(page, "watchlist-light-narrow");

    await page.getByRole("tab", { name: "presets" }).click();
    await expect(page.getByText("Euro stablecoins")).toBeVisible();
    await expectAxeClean(page, "presets-light-narrow");

    await page.getByRole("tab", { name: "settings" }).click();
    await expect(page.getByRole("heading", { name: "Global alerts" })).toBeVisible();
    await expectAxeClean(page, "settings-light-narrow");
    await expectNoHorizontalOverflow(page);

    for (const target of [
      page.getByRole("button", { name: "Refresh session" }),
      page.getByRole("tab", { name: "home" }),
      page.getByRole("tab", { name: "settings" }),
    ]) {
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("dark tall state respects reduced motion and 200% text resizing", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 932 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await trackMiniAppSessionRequests(page, POPULATED_STATE);
    await installTelegramSdkFixture(page, { sdk: { colorScheme: "dark", themeParams: DARK_THEME } });
    await launchSignedMiniApp(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const transitionDurations = await page.getByRole("tab", { name: "home" }).evaluate((element) =>
      getComputedStyle(element).transitionDuration.split(",").map((value) => Number.parseFloat(value) || 0));
    expect(Math.max(...transitionDurations)).toBeLessThanOrEqual(0.01);

    await expectAxeClean(page, "home-dark-tall-200-percent-text");
    await expectNoHorizontalOverflow(page);
    await page.getByRole("tab", { name: "settings" }).click();
    await expectAxeClean(page, "settings-dark-tall-200-percent-text");
    await expectNoHorizontalOverflow(page);
  });

  test("group and stale-auth read-only states remain explicit and accessible", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    let currentState = {
      ...POPULATED_STATE,
      viewer: {
        ...POPULATED_STATE.viewer,
        chatId: "-10042",
        chatType: "supergroup",
        canMutate: false,
        mutationBlockReason: "not-private",
      },
    };
    await trackMiniAppSessionRequests(page, () => currentState);
    await installTelegramSdkFixture(page, { sdk: { colorScheme: "light", themeParams: LIGHT_THEME } });
    await launchSignedMiniApp(page);

    await expect(page.getByRole("heading", { name: "Group settings are command-only for now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use recommended setup" })).toBeDisabled();
    await expectAxeClean(page, "group-read-only");

    currentState = {
      ...currentState,
      viewer: {
        ...POPULATED_STATE.viewer,
        canMutate: false,
        mutationBlockReason: "stale-auth",
      },
    };
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Reopen Telegram to edit settings" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Use recommended setup" })).toBeDisabled();
    await expectAxeClean(page, "stale-auth-read-only");
  });

  test("mutation failure and forgotten terminal states are announced and accessible", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await trackMiniAppSessionRequests(page, POPULATED_STATE);
    await installTelegramSdkFixture(page, {
      sdk: { colorScheme: "light", themeParams: LIGHT_THEME, autoConfirm: true },
    });
    let mutationCount = 0;
    await page.route("**/api/telegram-mini-app/mutate*", async (route) => {
      mutationCount += 1;
      if (mutationCount === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unavailable", code: "internal" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(POPULATED_STATE),
      });
    });
    await launchSignedMiniApp(page);

    await page.getByRole("button", { name: "Use recommended setup" }).click();
    await expect(page.getByRole("status")).toContainText("Something went wrong");
    await expectAxeClean(page, "mutation-error");

    await page.getByRole("tab", { name: "settings" }).click();
    await page.getByRole("button", { name: "Delete all my data" }).click();
    await expect(page.getByRole("heading", { name: "Your data has been deleted" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Every alert and preference");
    await expectAxeClean(page, "forgotten");
    expect(mutationCount).toBe(2);
  });
});
