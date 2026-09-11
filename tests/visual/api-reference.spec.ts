import { test, expect } from "@playwright/test";

// Two API-reference contracts that jsdom cannot observe:
//  - B9: the global nav menu descriptions are authored to render on a single
//    line at the narrow supported desktop width; a character-count oracle was
//    deleted, so the observable contract is measured line geometry with fonts
//    ready.
//  - B10: the mobile nav drawer's last item stays reachable (in the viewport)
//    when tabbed through.
const SECTION_MENU_LABELS = ["Markets", "Risk", "Tools"] as const;

test.describe.configure({ timeout: 60_000 });

test("nav menu descriptions stay on one line at narrow desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/about/api/");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => document.fonts.ready);

  for (const label of SECTION_MENU_LABELS) {
    const trigger = page.getByRole("button", { name: label, exact: true });
    await trigger.click();
    const panelId = await trigger.getAttribute("aria-controls");
    expect(panelId, `${label} panel id`).toBeTruthy();
    const panel = page.locator(`#${panelId}`);

    const descriptions = panel.locator('a[aria-describedby] span[aria-hidden="true"]');
    const count = await descriptions.count();
    expect(count, `${label} menu should list descriptions`).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const lines = await descriptions.nth(i).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      });
      expect(lines, `${label} description ${i} should render on one line`).toBe(1);
    }

    await trigger.click(); // close before opening the next menu
  }
});

test("mobile nav drawer's last item is reachable via keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about/api/");
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: "Open API navigation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const focusables = dialog.locator('a[href], button');
  const count = await focusables.count();
  expect(count, "drawer should contain navigable items").toBeGreaterThan(0);

  // Tab from the first focusable through to the last item in the drawer.
  for (let i = 0; i < count - 1; i++) {
    await page.keyboard.press("Tab");
  }
  const last = focusables.nth(count - 1);
  await expect(last).toBeFocused();
  await expect(last, "last drawer item should remain in the viewport").toBeInViewport();
});
