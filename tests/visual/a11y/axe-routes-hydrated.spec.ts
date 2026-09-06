import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAGS, summarizeViolations } from "./axe-shared";
import { installHydratedApiFixtures } from "./hydrated-api-fixtures";

test.beforeEach(async ({ page }) => {
  const { blockAnalyticsCollection } = await import("../../../scripts/maintenance/audit-seo-render-budget.mjs");
  await blockAnalyticsCollection(page, { blockedAnalyticsRequests: 0 });
});

/**
 * Mythos P1-14 (second half): hydrated-state axe scans.
 *
 * The default `axe-routes.spec.ts` floor scans the unhydrated export — the
 * state crawlers see — which misses everything that only renders with live
 * data (populated tables, score gauges, chart toolbars). This companion
 * drives the routes whose hydrated DOM differs most, against an API-backed
 * static-export server (the deploy pipeline reuses the 4173 smoke server;
 * a standalone run boots its own server, proxying the production API).
 *
 * Each route declares an explicit hydration-readiness wait and the test
 * FAILS if it never materializes: scanning a skeleton here would silently
 * recreate the exact blind spot this file closes.
 *
 * Waivers live in `axe-shared.ts` under the `<path>#hydrated` convention.
 */
const HYDRATION_TIMEOUT_MS = 45_000;

// Hydration (multi-endpoint fan-outs on /yield) plus the axe pass can
// exceed Playwright's 30s default comfortably on a throttled API.
test.describe.configure({ timeout: 90_000 });

// A populated data table renders at least one tbody row with no skeleton
// placeholder inside (loading rows are real <tr>s built from
// `[data-slot="skeleton"]` cells — the same signal the mobile smoke uses).
async function waitForHydratedTableRows(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator("tbody tr:visible", { hasNot: page.locator('[data-slot="skeleton"]') }).count(), {
      timeout: HYDRATION_TIMEOUT_MS,
      message: "hydrated table rows never appeared",
    })
    .toBeGreaterThan(0);
}

async function waitForHydratedDepegBoardRows(page: Page): Promise<void> {
  const board = page.getByRole("region", { name: "Depeg control board" });
  await expect(board).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await expect
    .poll(
      async () =>
        (await board.getByRole("button", { name: /^Open .+ depeg detail$/ }).count()) +
        (await board.getByRole("link", { name: /^Open .+ depeg detail$/ }).count()),
      { timeout: HYDRATION_TIMEOUT_MS, message: "hydrated depeg board rows never appeared" },
    )
    .toBeGreaterThan(0);
}

const ROUTES: ReadonlyArray<{
  path: string;
  tier: string;
  fixtureSet?: "depeg" | "yield";
  ready: (page: Page) => Promise<void>;
}> = [
  { path: "/depeg", tier: "analytics", fixtureSet: "depeg", ready: waitForHydratedDepegBoardRows },
  { path: "/screener", tier: "power-user", ready: waitForHydratedTableRows },
  { path: "/yield", tier: "analytics", fixtureSet: "yield", ready: waitForHydratedTableRows },
  {
    path: "/stablecoin/usdt-tether",
    tier: "detail",
    ready: async (page) => {
      // The crawl fallback shows the loading shell; hydration replaces it
      // with the dossier (hero metrics render a real $ figure).
      await expect(page.getByText("Loading research dossier", { exact: false })).toBeHidden({
        timeout: HYDRATION_TIMEOUT_MS,
      });
    },
  },
];

for (const route of ROUTES) {
  test(`a11y hydrated: ${route.path} (${route.tier})`, async ({ page }) => {
    if (route.fixtureSet) await installHydratedApiFixtures(page, route.fixtureSet);
    await page.goto(route.path);
    await page.waitForLoadState("domcontentloaded");
    await route.ready(page);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(summarizeViolations(`${route.path}#hydrated`, results.violations), "axe-core violations (hydrated)").toEqual(
      [],
    );
  });
}
