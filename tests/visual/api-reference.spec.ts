import { test, expect } from "@playwright/test";

// The mobile nav drawer's last item stays reachable in the viewport when tabbed through.

test.describe.configure({ timeout: 60_000 });

test("mobile nav drawer's last item is reachable via keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/api/#reference");
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
