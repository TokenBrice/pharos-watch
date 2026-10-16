import { expect, test } from "@playwright/test";
import { installOpsApiFixtures, OPS_FIXTURE_NOW_MS } from "./ops-api-fixtures";
import { sizeViewport } from "./ops-geometry-support";

/**
 * B6 — resolved mint incident presentation on the stablecoin detail page
 * (s080-src.md B3). The browser checks folded emphasis and keyboard disclosure.
 * No screenshots.
 */

const HYDRATION_TIMEOUT_MS = 30_000;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(OPS_FIXTURE_NOW_MS));
  await installOpsApiFixtures(page);
});

test("resolved mint incident folds into a calm ledger, not a red alert banner", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 375, 667);
  await page.goto("/stablecoin/usdt-tether/", { waitUntil: "domcontentloaded" });

  // Active incidents render a red alert banner; a resolved one does not.
  await expect(page.getByText("Active mint incidents", { exact: false })).toHaveCount(0);

  const summary = page.locator("#mint-authority summary").filter({ hasText: "Incident history" });
  await expect(summary).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await summary.scrollIntoViewIfNeeded();
  // This static-export route hydrates and fetches lazy sections after scroll.
  // All requests are locally fulfilled; settle them before toggling SSR details
  // so hydration cannot replace the just-opened native disclosure.
  await page.waitForLoadState("networkidle");
  const ledger = page.locator("#mint-authority details").filter({ hasText: "Incident history" });
  await expect(ledger).not.toHaveAttribute("open", "");
  const resolved = ledger.getByText("Resolved", { exact: true });
  await expect(resolved).toHaveCount(1);
  await expect(resolved).toBeHidden();
  await summary.focus();
  await summary.press("Enter");
  await expect(ledger).toHaveAttribute("open", "");

  await expect(resolved).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  await summary.press("Enter");
  await expect(resolved).toBeHidden();
});
