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
  await expect(page.getByRole("heading", { name: "PharosWatchBot", exact: true })).toBeVisible();
  await expect(page.locator("#bot img")).toHaveJSProperty("complete", true);
  await page.evaluate(() => document.fonts.ready);
}

test.describe("PharosWatchBot public page", () => {
  test("keeps the 320px decision path in the first fold without horizontal overflow", async ({ page }) => {
    await openBotPage(page, 320, 568);

    await expect(page.getByRole("link", { name: /Open Bot/i }).first()).toBeVisible();
    const examplesTop = await page.locator("#alerts").evaluate((element) => element.getBoundingClientRect().top);
    expect(examplesTop).toBeLessThan(568);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await expect(page.locator("#bot")).toHaveScreenshot("pharoswatchbot-hero-320.png", {
      animations: "disabled",
    });
  });

  test("keeps the 375px reference keyboard accessible and axe-clean", async ({ page }) => {
    await openBotPage(page, 375, 667);

    const commandSummary = page.locator("#commands summary");
    await commandSummary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#commands details")).toHaveAttribute("open", "");
    await expect(page.getByLabel("PharosWatchBot command reference")).toBeVisible();

    const inaccessibleCommandOverflow = await page.getByLabel("PharosWatchBot command reference").evaluate((root) => {
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

    await page.locator("#mini-app").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "The same alert state, without slash commands" })).toBeVisible();
    await page.locator("header").evaluateAll((headers) => {
      for (const header of headers) (header as HTMLElement).style.visibility = "hidden";
    });
    const feedbackButton = page.getByRole("button", { name: "Send feedback" });
    if (await feedbackButton.count()) {
      await feedbackButton.first().evaluate((button) => {
        const dock = button.closest(".fixed") as HTMLElement | null;
        if (dock) dock.style.display = "none";
      });
    }
    await expect(page.locator("#mini-app")).toHaveScreenshot("pharoswatchbot-mini-app-375.png", {
      animations: "disabled",
    });
  });

  test("preserves the unframed desktop product scene", async ({ page }) => {
    await openBotPage(page, 1440, 900);

    await expect(page.locator("#bot")).toHaveCSS("border-top-left-radius", "0px");
    await expect(page.locator("#bot")).toHaveScreenshot("pharoswatchbot-hero-desktop.png", {
      animations: "disabled",
    });
  });
});
