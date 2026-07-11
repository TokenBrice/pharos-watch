import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAGS, summarizeViolations } from "./axe-shared";

/**
 * Wave 6 IDEA-16: automated axe-core regression floor.
 *
 * Boots the static export (served by `playwright.config.ts` via
 * `npm run serve:static-export`) and asserts that
 * one canonical route per product tier has zero WCAG 2.0 AA / 2.2 AA
 * violations under @axe-core/playwright.
 *
 * The goal is to prevent regressions on rules Pharos already passes; not to
 * exhaustively cover every component. As subsequent waves close existing
 * violations, this floor ratchets upward automatically.
 *
 * This file scans the unhydrated export (the state crawlers see); the
 * hydrated-state companion lives in `axe-routes-hydrated.spec.ts`. Shared
 * waivers and the violation summary live in `axe-shared.ts`.
 */
const ROUTES: ReadonlyArray<{ path: string; tier: string }> = [
  { path: "/about", tier: "discovery" },
  { path: "/depeg", tier: "analytics" },
  { path: "/screener", tier: "power-user" },
  // The detail-page slug follows the `<symbol>-<issuer>` convention; see
  // `out/stablecoin/` listing. The council brief named `/stablecoin/usdt`
  // but the routed slug is `usdt-tether`.
  { path: "/stablecoin/usdt-tether", tier: "detail" },
  // Mythos P1-14: the original 4-route floor left ~36 route families
  // unscanned; confirmed violations (the /yield tablist, the mini-app tabs)
  // shipped in exactly that blind spot.
  { path: "/yield", tier: "analytics" },
  { path: "/timeline", tier: "analytics" },
  { path: "/chains", tier: "analytics" },
  { path: "/pharoswatchbot", tier: "discovery" },
  { path: "/pharoswatchbot/app", tier: "mini-app" },
];

// Layered surfaces (drawers, palettes, sheets) never render in the default
// scans above; the mobile nav drawer is the highest-traffic one.
test("a11y: open mobile nav drawer (overlay)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog").waitFor();

  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(summarizeViolations("/about#mobile-drawer", results.violations), "axe-core violations").toEqual([]);
});

for (const route of ROUTES) {
  test(`a11y: ${route.path} (${route.tier})`, async ({ page }) => {
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();

    // Surface a readable failure: rule id + node count + first selector per
    // violation. This is the most useful signal when triaging which a11y
    // fix to ship next.
    expect(summarizeViolations(route.path, results.violations), "axe-core violations").toEqual([]);
  });
}
