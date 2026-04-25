import { test, expect } from "@playwright/test";

test.use({ reducedMotion: "reduce" });

test("lighthouse renders deterministic frozen scene", async ({ page }) => {
  await page.goto("/lighthouse/");
  await page.waitForSelector('[data-testid="harbor-scene"] canvas', { state: "visible" });
  // Allow scene-application effect + lamp population RAF deferral to settle
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot("lighthouse-reduced.png");
});
