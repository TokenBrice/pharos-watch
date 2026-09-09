import { test, expect, type Page, type Route } from "@playwright/test";

// The hero "passport" strip stacks each verification fact as a field name above
// its mono value, docked at the bottom of the hero card; the supply-creation
// rail draws multisig signer dots beside the threshold. jsdom cannot measure
// layout, so these are bounding-box assertions on the hydrated detail page.
const STABLECOINS = {
  peggedAssets: [
    {
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1,
      priceSource: "fixture",
      circulating: { peggedUSD: 100_000_000_000 },
      circulatingPrevDay: { peggedUSD: 100_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 99_000_000_000 },
      circulatingPrevMonth: { peggedUSD: 98_000_000_000 },
      chainCirculating: {},
      chains: [],
    },
  ],
};

async function installStablecoins(page: Page): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Data-Age": "0", "Cache-Control": "no-store" },
      body: JSON.stringify(STABLECOINS),
    });
  await page.route("**/api/stablecoins", handler);
  await page.route("**/_site-data/stablecoins", handler);
}

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 720 },
] as const;

test.describe.configure({ timeout: 90_000 });

for (const viewport of VIEWPORTS) {
  test(`passport fields stack name-above-value and dock to the hero card (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installStablecoins(page);
    await page.goto("/stablecoin/usdt-tether");
    await page.waitForLoadState("domcontentloaded");

    const strip = page.locator('[aria-label="Verification passport"]');
    await expect(strip, "passport strip never appeared").toBeVisible({ timeout: 45_000 });

    // Stacking: each field's category label sits entirely above its value. The
    // strip renders a mobile scroll row and a desktop grid side by side; only
    // one is display-visible per breakpoint, so measure the visible links.
    // Hydration and font swaps can move boxes mid-measurement, so the whole
    // pass retries until every box is stable.
    await page.evaluate(() => document.fonts.ready);
    await expect(async () => {
      const links = strip.locator("a:visible");
      const linkCount = await links.count();
      expect(linkCount, "expected passport facts").toBeGreaterThan(0);
      for (let i = 0; i < linkCount; i++) {
        const spans = links.nth(i).locator(":scope > span");
        const category = await spans.first().boundingBox();
        const value = await spans.nth(1).boundingBox();
        expect(category, `fact ${i} category box`).not.toBeNull();
        expect(value, `fact ${i} value box`).not.toBeNull();
        expect(
          category!.y + category!.height,
          `fact ${i}: category should sit above its value`,
        ).toBeLessThanOrEqual(value!.y + 0.5);
      }
    }).toPass({ timeout: 15_000 });

    // Docking: the strip is the bottom band of the hero card (no callout below
    // usdt-tether), so its bottom edge aligns with the card's bottom edge.
    const stripBox = await strip.boundingBox();
    const cardBox = await strip.locator("xpath=..").boundingBox();
    expect(stripBox, "strip box").not.toBeNull();
    expect(cardBox, "hero card box").not.toBeNull();
    expect(
      Math.abs(stripBox!.y + stripBox!.height - (cardBox!.y + cardBox!.height)),
      "strip should dock to the hero card bottom",
    ).toBeLessThanOrEqual(2);
  });

  test(`supply-creation rail draws non-overlapping signer dots in order (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installStablecoins(page);
    await page.goto("/stablecoin/usdt-tether");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator('[aria-label="Verification passport"]')).toBeVisible({ timeout: 45_000 });

    // The mint-authority section sits far below the fold and is lazily mounted.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const signerRow = page.locator('span[title*="signers required"]').first();
    await expect(signerRow, "signer-dot row never appeared").toBeAttached({ timeout: 45_000 });
    await signerRow.scrollIntoViewIfNeeded();

    const dots = await signerRow.locator("span").evaluateAll((spans) =>
      spans
        .map((s) => {
          const r = s.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })
        // The numeric "3/6" caption is text-width; the dots are the small 6px circles.
        .filter((r) => r.w < 10 && r.h < 10),
    );

    expect(dots.length, "expected one dot per signer").toBeGreaterThan(0);
    for (let i = 0; i < dots.length; i++) {
      expect(dots[i].w, `dot ${i} width`).toBeGreaterThanOrEqual(4);
      expect(dots[i].h, `dot ${i} height`).toBeGreaterThanOrEqual(4);
      // Same row (horizontal stacking), left-to-right, no bounding-box overlap.
      expect(Math.abs(dots[i].y - dots[0].y), `dot ${i} stays in the dot row`).toBeLessThan(1);
      if (i > 0) {
        expect(dots[i].x, `dot ${i} does not overlap dot ${i - 1}`).toBeGreaterThanOrEqual(
          dots[i - 1].x + dots[i - 1].w - 0.5,
        );
      }
    }
  });
}
