import { test, expect, type Page, type Route } from "@playwright/test";

// The homepage event ticker pauses its scroll animation on hover and resumes on
// unhover via a CSS `:hover` rule (`globals.css`: `.pharos-tape-shell:hover
// .pharos-tape-track { animation-play-state: paused }`). jsdom cannot establish
// hover or animation state, so this asserts the computed play-state transition
// on the real hydrated tape.
const TAPE_EVENTS = {
  events: [
    {
      id: "b2-fixture-depeg-1",
      type: "depeg.opened",
      severity: "warning",
      ts: Date.now() - 120_000,
      endsAt: null,
      coinId: "usdc-circle",
      issuerId: null,
      pegCurrency: "USD",
      chain: null,
      title: "USDC depeg opened (-500 bps)",
      summary: "USDC drifted to -500 bps versus its USD peg.",
      payload: {},
      sourceTable: "depeg_events",
      sourceRowId: "1",
      transition: "opened",
      sourceUrl: "/stablecoin/usdc-circle/#peg-history",
      methodologyVersion: null,
    },
    {
      id: "b2-fixture-freeze-1",
      type: "freeze.address.blocked",
      severity: "severe",
      ts: Date.now() - 300_000,
      endsAt: null,
      coinId: "usdt-tether",
      issuerId: null,
      pegCurrency: "USD",
      chain: null,
      title: "USDT freeze blocked",
      summary: "A USDT address was blocked by the issuer.",
      payload: {},
      sourceTable: "blacklist_events",
      sourceRowId: "2",
      transition: "opened",
      sourceUrl: "/stablecoin/usdt-tether/#blacklist-history",
      methodologyVersion: null,
    },
  ],
  nextCursor: null,
  total: 2,
  totalExact: false,
};

async function installTapeEvents(page: Page): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Data-Age": "0", "Cache-Control": "no-store" },
      body: JSON.stringify(TAPE_EVENTS),
    });
  await page.route("**/api/events**", handler);
  await page.route("**/_site-data/events**", handler);
}

test.describe.configure({ timeout: 90_000 });

test("homepage tape pauses its scroll on hover and resumes on unhover", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installTapeEvents(page);
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  const track = page.locator(".pharos-tape-track");
  await expect(track, "populated tape track never appeared").toBeVisible({ timeout: 45_000 });
  await expect(track.locator("a").first()).toBeVisible();

  const playState = () => track.evaluate((el) => getComputedStyle(el).animationPlayState);

  // Default: the ticker runs (no reduced-motion preference is emulated here).
  await expect.poll(playState, { message: "tape should start running" }).toBe("running");

  await page.locator(".pharos-tape-shell").hover();
  await expect.poll(playState, { message: "tape should pause on hover" }).toBe("paused");

  await page.mouse.move(0, 0);
  await expect.poll(playState, { message: "tape should resume after unhover" }).toBe("running");
});
