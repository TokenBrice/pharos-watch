import { expect, test } from "@playwright/test";
import { installOpsApiFixtures, OPS_FIXTURE_NOW_MS } from "./ops-api-fixtures";
import { expectNoHorizontalOverflow, expectStickyHeaderInvariant, sizeViewport } from "./ops-geometry-support";

/**
 * B7 — hostile-string cards and the sticky inventory table header on
 * /admin-api/ (s082-src.md). The jsdom suites deleted their CSS-spelling
 * assertions (`break-all`, `table-header-sticky`); the geometry they implied
 * lives here. No screenshots.
 */

const HYDRATION_TIMEOUT_MS = 30_000;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(OPS_FIXTURE_NOW_MS));
  await installOpsApiFixtures(page);
});

test("hostile-string request cards wrap without horizontal overflow at 320x568", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 320, 568);
  await page.goto("/admin-api/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1, name: "API Management", exact: true })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(page.getByRole("table", { name: "API key inventory" })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });

  // Each request card renders user-controlled email/project strings that must
  // wrap, not widen the page. Articles are the card wrapper.
  await expect.poll(() => page.locator("article").count()).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page, "article");
  await expectNoHorizontalOverflow(page, "article *");
});

test("inventory table header stays pinned while its viewport scrolls at 320x568", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 320, 568);
  await page.goto("/admin-api/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("table", { name: "API key inventory" })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });

  await expectStickyHeaderInvariant(
    page,
    '[data-slot="table-viewport"]:has(table[aria-label="API key inventory"])',
    "thead",
  );
});
