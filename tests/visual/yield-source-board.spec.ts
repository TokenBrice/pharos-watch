import { test, expect, type Page } from "@playwright/test";
import { installHydratedApiFixtures } from "./a11y/hydrated-api-fixtures";

// Source-board quality bars render each filter control as a stack-bar segment.
// Assert the measured target floor, not class strings or screenshot baselines.
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 720 },
] as const;

test.describe.configure({ timeout: 90_000 });

// The source-quality stack bars are `role="group"` elements whose aria-label
// names the mix ("Confidence tier mix: …"); their interactive segments are the
// `aria-pressed` buttons. Scoping here excludes the yield page's unrelated
// toggle pills that also carry `aria-pressed`.
const FILTER_CONTROL_SELECTOR = '[role="group"][aria-label*=" mix:"] button[aria-pressed]';

async function waitForFilterControls(page: Page): Promise<void> {
  await expect(page.locator(FILTER_CONTROL_SELECTOR).first(), "filter controls never appeared").toBeVisible({
    timeout: 45_000,
  });
}

for (const viewport of VIEWPORTS) {
  test(`source-board filter controls meet a 24x24 target floor (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installHydratedApiFixtures(page, "yield");
    await page.goto("/yield");
    await waitForFilterControls(page);

    const controls = page.locator(`${FILTER_CONTROL_SELECTOR}:visible`);
    const count = await controls.count();
    expect(count, "expected at least one stack-bar filter segment").toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(box, `filter control ${i} should have a layout box`).not.toBeNull();
      expect(box!.width, `filter control ${i} width`).toBeGreaterThanOrEqual(24);
      expect(box!.height, `filter control ${i} height`).toBeGreaterThanOrEqual(24);
    }
  });

}
