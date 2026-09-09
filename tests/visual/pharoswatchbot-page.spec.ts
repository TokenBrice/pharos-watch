import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAGS, summarizeViolations } from "./a11y/axe-shared";

const PULSE_FIXTURE = {
  activeWatchers: 842,
  coinSubscriptions: 2_431,
  explicitCoinSubscriptions: 2_100,
  presetImpliedCoinSubscriptions: 331,
  activePresetFollowers: 94,
  newWatchersToday: 8,
  churnedWatchersToday: 2,
  reactivatedWatchersToday: 3,
  historySource: "snapshot",
  topCoins: ["USDT", "USDC", "USDe", "DAI", "USD1"],
  watcherHistory: [
    {
      date: "2026-07-09",
      timestamp: 1_783_555_200_000,
      snapshotAt: 1_783_555_500,
      newWatchers: 7,
      activeWatchers: 834,
      churnedWatchers: 1,
      reactivatedWatchers: 2,
    },
    {
      date: "2026-07-10",
      timestamp: 1_783_641_600_000,
      snapshotAt: 1_783_641_900,
      newWatchers: 8,
      activeWatchers: 842,
      churnedWatchers: 2,
      reactivatedWatchers: 3,
    },
  ],
  pendingDeliveries: 0,
  miniAppSessionsToday: 19,
  miniAppMutationsToday: 11,
  miniAppDeniedToday: 0,
  currentSnapshotAt: 1_783_641_900,
  lifecycleHistoryUpdatedAt: 1_783_641_900,
  lifecycleHistoryEverySeconds: 900,
  quality: { status: "complete", unavailableFields: [] },
  privacy: { exactActiveWatchers: true, lowCardinalityThreshold: 5, suppressedFields: [] },
  updatedAt: 1_783_641_900,
  updatedEverySeconds: 300,
};

async function openBotPage(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => window.localStorage.setItem("theme", "light"));
  const fulfillPulse = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PULSE_FIXTURE) });
  };
  await page.route("**/_site-data/telegram-pulse*", fulfillPulse);
  await page.route("**/api/telegram-pulse*", fulfillPulse);
  await page.goto("/pharoswatchbot/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#watch").getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#watch svg[role=\"presentation\"]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test.describe("PharosWatchBot public page", () => {
  test("keeps the 320px decision path in the first fold without horizontal overflow", async ({ page }) => {
    await openBotPage(page, 320, 568);

    const hero = page.locator("#watch");
    await expect(hero.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(hero.getByRole("link", { name: "Open the bot", exact: true })).toBeInViewport();
    await expect(hero.getByRole("link", { name: "See example alerts", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("keeps the 375px command reference keyboard accessible and axe-clean", async ({ page }) => {
    await openBotPage(page, 375, 667);

    const manual = page.locator("#manual");
    await expect(manual.getByRole("heading", { level: 2 }).first()).toBeVisible();
    const commandReference = page.getByLabel("PharosWatchBot command reference");
    await expect(commandReference).toBeVisible();
    const commandFilter = page.getByRole("searchbox", { name: "Filter bot commands" });
    await commandFilter.focus();
    await expect(commandFilter).toBeFocused();

    const inaccessibleCommandOverflow = await commandReference.evaluate((root) => {
      const elements = [root, ...root.querySelectorAll<HTMLElement>("*")];
      return elements.some((element) => {
        const overflowX = window.getComputedStyle(element).overflowX;
        const scrollsHorizontally =
          (overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth + 1;
        return scrollsHorizontally && element.tabIndex < 0;
      });
    });
    expect(inaccessibleCommandOverflow).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(summarizeViolations("/pharoswatchbot#reference", results.violations), "axe-core violations").toEqual([]);

    const control = page.locator("#control");
    await control.scrollIntoViewIfNeeded();
    await expect(control.getByRole("heading", { level: 2 })).toBeVisible();
  });

  test("preserves the unframed desktop product scene", async ({ page }) => {
    await openBotPage(page, 1440, 900);

    const hero = page.locator("#watch");
    await expect(hero).toHaveCSS("border-top-left-radius", "0px");
    await expect(hero.locator('svg[role="presentation"]')).toBeVisible();
  });
});
