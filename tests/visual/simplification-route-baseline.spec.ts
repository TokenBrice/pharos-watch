import { expect, test, type Page, type Route } from "@playwright/test";
import { findFrameworkErrorMarker, isFatalRuntimeMessage } from "../../scripts/lib/pages-asset-smoke.mjs";
import { installTelegramSdkFixture, MINI_APP_STATE, TELEGRAM_SIGNED_LAUNCH_PATH } from "./telegram-mini-app-fixtures";

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
  watcherHistory: [],
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

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const ROUTES = [
  { name: "home", path: "/" },
  { name: "discovery-content", path: "/about" },
  { name: "analytics", path: "/depeg" },
  { name: "power-user", path: "/screener" },
  { name: "active-detail", path: "/stablecoin/usdt-tether" },
  { name: "pre-launch-detail", path: "/stablecoin/fiusd-fiserv" },
  { name: "frozen-detail", path: "/stablecoin/usr-resolv" },
  { name: "variant-detail", path: "/stablecoin/susdt-spark" },
  { name: "non-usd-detail", path: "/stablecoin/eurc-circle" },
  { name: "telegram-public", path: "/pharoswatchbot" },
  { name: "telegram-mini-app", path: TELEGRAM_SIGNED_LAUNCH_PATH, miniApp: true },
] as const;

async function installFixedTelegramFixtures(page: Page): Promise<void> {
  const fulfillPulse = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PULSE_FIXTURE) });
  };
  await page.route("**/_site-data/telegram-pulse*", fulfillPulse);
  await page.route("**/api/telegram-pulse*", fulfillPulse);
  await page.route("**/api/telegram-mini-app/session*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MINI_APP_STATE) });
  });
  await installTelegramSdkFixture(page);
}

async function openStaticRoute(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "light");
  });
  await installFixedTelegramFixtures(page);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

function collectFatalRuntimeDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on("pageerror", (error) => {
    if (isFatalRuntimeMessage(error.message)) diagnostics.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && isFatalRuntimeMessage(message.text())) diagnostics.push(message.text());
  });
  return diagnostics;
}

test.describe("W0.2 static-export route characterization", () => {
  test.describe.configure({ timeout: 60_000 });

  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`${route.name} remains stable at ${viewport.name}`, async ({ page }) => {
        const fatalRuntimeDiagnostics = collectFatalRuntimeDiagnostics(page);
        await page.setViewportSize(viewport);
        await openStaticRoute(page, route.path);

        if ("miniApp" in route && route.miniApp) {
          await expect(page.getByRole("heading", { name: "@watcher" })).toBeVisible();
        }

        const bodyText = await page.locator("body").innerText();
        expect(bodyText.trim().length).toBeGreaterThan(0);
        expect(findFrameworkErrorMarker(bodyText)).toBeNull();
        expect(fatalRuntimeDiagnostics).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(page).toHaveScreenshot(`${route.name}-${viewport.name}.png`, {
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
      });
    }
  }
});
