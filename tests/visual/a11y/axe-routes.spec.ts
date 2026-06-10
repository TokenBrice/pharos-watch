import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Result } from "axe-core";

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
 * Known debt is waived at the node level. Do not disable whole axe rules here:
 * that hides broad regressions on routes that already pass the same rule.
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
  { path: "/pharoswatchbot/app", tier: "mini-app" },
];

const TAGS = ["wcag2a", "wcag2aa", "wcag22a", "wcag22aa"];

interface AxeNodeWaiver {
  routePath: string;
  ruleId: string;
  target: string;
  note: string;
}

const KNOWN_NODE_WAIVERS: readonly AxeNodeWaiver[] = [];

function isWaivedNode(routePath: string, violation: Result, target: string): boolean {
  return KNOWN_NODE_WAIVERS.some(
    (waiver) =>
      waiver.routePath === routePath &&
      waiver.ruleId === violation.id &&
      waiver.target === target,
  );
}

function summarizeViolations(routePath: string, violations: Result[]) {
  return violations
    .map((violation) => {
      const nodes = violation.nodes.filter(
        (node) => !node.target.some((target) => isWaivedNode(routePath, violation, target)),
      );
      return {
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodeCount: nodes.length,
        firstTarget: nodes[0]?.target?.[0],
      };
    })
    .filter((violation) => violation.nodeCount > 0);
}

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
    const summary = results.violations
      .map((violation) => {
        const nodes = violation.nodes.filter((node) =>
          !node.target.some((target) => isWaivedNode(route.path, violation, target)),
        );
        return {
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodeCount: nodes.length,
          firstTarget: nodes[0]?.target?.[0],
        };
      })
      .filter((violation) => violation.nodeCount > 0);

    expect(summary, "axe-core violations").toEqual([]);
  });
}
