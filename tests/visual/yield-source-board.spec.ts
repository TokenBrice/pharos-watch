import { test, expect, type Page } from "@playwright/test";
import { installHydratedApiFixtures } from "./a11y/hydrated-api-fixtures";

// Source-board quality bars are the only place the deleted Tailwind target-floor
// and composited `text-background/75` tooltip oracles could be observed: jsdom
// has neither layout nor painted color. Each filter control is a stack-bar
// segment rendered as an `aria-pressed` button with `min-w-6 h-6`; the tooltip
// description is `--background` text at 75% opacity over the `--foreground`
// tooltip surface. We assert the geometry floor and the measured composited
// contrast, never a class string or a screenshot baseline.
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

  test(`source-board tooltip text is readable against its surface (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installHydratedApiFixtures(page, "yield");
    await page.goto("/yield");
    await waitForFilterControls(page);

    await page.locator(`${FILTER_CONTROL_SELECTOR}:visible`).first().hover();
    const tooltip = page.locator('[role="tooltip"]');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    const minRatio = await tooltip.evaluate((tip) => {
      // Resolve any CSS color (oklch/rgba/color-mix) to sRGB through a scratch
      // canvas so the measured ratio reflects painted pixels, not authored strings.
      const resolve = (color: string): [number, number, number, number] => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const luminance = ([r, g, b]: [number, number, number]): number => {
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const bg = resolve(getComputedStyle(tip).backgroundColor);
      const bgRgb: [number, number, number] = [bg[0], bg[1], bg[2]];

      let min = Infinity;
      for (const span of tip.querySelectorAll("span")) {
        const fg = resolve(getComputedStyle(span).color);
        const alpha = fg[3];
        const composite: [number, number, number] = [
          fg[0] * alpha + bgRgb[0] * (1 - alpha),
          fg[1] * alpha + bgRgb[1] * (1 - alpha),
          fg[2] * alpha + bgRgb[2] * (1 - alpha),
        ];
        const l1 = luminance(composite);
        const l2 = luminance(bgRgb);
        const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
        min = Math.min(min, (hi + 0.05) / (lo + 0.05));
      }
      return min;
    });

    expect(minRatio, "composited tooltip text contrast (WCAG AA small text)").toBeGreaterThanOrEqual(4.5);
  });
}
