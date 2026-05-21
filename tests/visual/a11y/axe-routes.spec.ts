import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Wave 6 IDEA-16: automated axe-core regression floor.
 *
 * Boots the static export (served by `playwright.config.ts` via
 * `npm run serve:static-export` on http://localhost:4173) and asserts that
 * one canonical route per product tier has zero WCAG 2.0 AA / 2.2 AA
 * violations under @axe-core/playwright.
 *
 * The goal is to prevent regressions on rules Pharos already passes; not to
 * exhaustively cover every component. As subsequent waves close existing
 * violations, this floor ratchets upward automatically.
 *
 * `ALLOWED_VIOLATIONS` is deliberately conservative. Every entry should be
 * accompanied by a short comment naming the future fix that would let it be
 * removed.
 */
const ROUTES: ReadonlyArray<{ path: string; tier: string }> = [
  { path: "/about", tier: "discovery" },
  { path: "/depeg", tier: "analytics" },
  { path: "/screener", tier: "power-user" },
  // The detail-page slug follows the `<symbol>-<issuer>` convention; see
  // `out/stablecoin/` listing. The council brief named `/stablecoin/usdt`
  // but the routed slug is `usdt-tether`.
  { path: "/stablecoin/usdt-tether", tier: "detail" },
];

const TAGS = ["wcag2a", "wcag2aa", "wcag22a", "wcag22aa"];

const ALLOWED_VIOLATIONS: string[] = [
  // `color-contrast`: the sidebar nav-group toggle and a handful of other
  // semantic-amber surfaces still fail AA against their light-mode card
  // background. Council IDEA-3 (severity / threat-band tokens to AA on both
  // themes) is the planned fix; remove this allowlist entry when that ships.
  "color-contrast",
  // `target-size` (WCAG 2.2 AA, 2.5.8): the sidebar nav-group toggle and a
  // few dense control pills resolve below the 24x24 CSS-px minimum on
  // desktop. Council IDEA-14 (sweep desktop targets to ≥24x24 or 24px
  // spacing) is the planned fix; remove this entry when that ships.
  "target-size",
];

for (const route of ROUTES) {
  test(`a11y: ${route.path} (${route.tier})`, async ({ page }) => {
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");

    const builder = new AxeBuilder({ page }).withTags(TAGS);
    if (ALLOWED_VIOLATIONS.length > 0) {
      builder.disableRules(ALLOWED_VIOLATIONS);
    }
    const results = await builder.analyze();

    // Surface a readable failure: rule id + node count + first selector per
    // violation. This is the most useful signal when triaging which a11y
    // fix to ship next.
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodeCount: violation.nodes.length,
      firstTarget: violation.nodes[0]?.target?.[0],
    }));

    expect(summary, "axe-core violations").toEqual([]);
  });
}
