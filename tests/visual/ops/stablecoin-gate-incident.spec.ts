import { expect, test, type Page } from "@playwright/test";
import { installOpsApiFixtures, OPS_FIXTURE_NOW_MS } from "./ops-api-fixtures";
import { sizeViewport } from "./ops-geometry-support";

/**
 * B6 — gate and incident surfaces on the stablecoin detail page (s080-src.md
 * B3). The jsdom suites deleted gate color/border pins and the
 * `border-red-500/25` negation; the browser reasserts the drawn geometry:
 * open (dashed) vs closed (solid) gates, restricted vs permissionless routes,
 * and the calm folded emphasis of a resolved mint incident. No screenshots.
 */

const HYDRATION_TIMEOUT_MS = 30_000;

// A valid RedemptionBackstopsResponse body for one coin; only `accessModel`
// varies between the two gate states.
function redemptionBody(accessModel: "permissionless-onchain" | "issuer-api"): Record<string, unknown> {
  return {
    coins: {
      "usdt-tether": {
        stablecoinId: "usdt-tether",
        score: 65,
        dexLiquidityScore: 44,
        accessScore: 40,
        settlementScore: 65,
        executionCertaintyScore: 60,
        capacityScore: 100,
        outputAssetQualityScore: 100,
        costScore: 40,
        routeFamily: "offchain-issuer",
        accessModel,
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        provider: "supply-full-model",
        sourceMode: "estimated",
        resolutionState: "resolved",
        routeStatus: "open",
        routeStatusSource: "static-config",
        holderEligibility: "verified-customer",
        capacityConfidence: "heuristic",
        capacitySemantics: "eventual-only",
        feeConfidence: "undisclosed-reviewed",
        feeModelKind: "undisclosed-reviewed",
        modelConfidence: "low",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        feeBps: null,
        queueEnabled: false,
        methodologyVersion: "1.1",
        updatedAt: 1_700_000_000,
        capsApplied: [],
      },
    },
    methodology: {
      version: "1.1",
      versionLabel: "v1.1",
      currentVersion: "1.1",
      currentVersionLabel: "v1.1",
      changelogPath: "/methodology/redemption-backstops",
      asOf: 1_700_000_000,
      isCurrent: true,
      componentWeights: {
        access: 0.15,
        settlement: 0.15,
        executionCertainty: 0.2,
        capacity: 0.25,
        outputAssetQuality: 0.15,
        cost: 0.1,
      },
      routeFamilyCaps: { queueRedeem: 80, offchainIssuer: 65 },
    },
    updatedAt: 1_700_000_000,
  };
}

async function installRedemptionOverride(page: Page, accessModel: "permissionless-onchain" | "issuer-api"): Promise<void> {
  const body = redemptionBody(accessModel);
  await page.route(/\/_site-data\/redemption-backstops|\/api\/redemption-backstops/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function openGateCard(page: Page, title: string): Promise<void> {
  await page.locator("#overview").scrollIntoViewIfNeeded();
  await expect(page.locator(`[role="img"][aria-label^="Redemption route:"]`)).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(page.locator(`[title="${title}"]`).first()).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
}

function gateBarStyles(page: Page, title: string) {
  return page.evaluate((gateTitle) => {
    const gate = Array.from(document.querySelectorAll<HTMLElement>("span[title]")).find((el) => el.title === gateTitle);
    if (!gate) return [];
    const bars = Array.from(gate.querySelectorAll<HTMLElement>("span[aria-hidden] span"));
    return bars.map((bar) => {
      const style = getComputedStyle(bar);
      return { borderLeftStyle: style.borderLeftStyle, backgroundColor: style.backgroundColor, width: bar.offsetWidth };
    });
  }, title);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(OPS_FIXTURE_NOW_MS));
  await installOpsApiFixtures(page);
});

test("permissionless route draws an open dashed gate at 768x1024", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 768, 1024);
  await installRedemptionOverride(page, "permissionless-onchain");
  await page.goto("/stablecoin/usdt-tether/", { waitUntil: "domcontentloaded" });
  await openGateCard(page, "Permissionless onchain");

  const bars = await gateBarStyles(page, "Permissionless onchain");
  expect(bars.length, "open gate renders two bars").toBe(2);
  for (const bar of bars) expect(bar.borderLeftStyle, "open gate bars must be dashed").toBe("dashed");
});

test("restricted route draws a closed solid gate at 768x1024", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 768, 1024);
  await installRedemptionOverride(page, "issuer-api");
  await page.goto("/stablecoin/usdt-tether/", { waitUntil: "domcontentloaded" });
  await openGateCard(page, "Issuer / institutional");

  const bars = await gateBarStyles(page, "Issuer / institutional");
  expect(bars.length, "closed gate renders two bars").toBe(2);
  for (const bar of bars) expect(bar.borderLeftStyle, "closed gate bars must not be dashed").not.toBe("dashed");
});

test("resolved mint incident folds into a calm ledger, not a red alert banner", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 375, 667);
  await page.goto("/stablecoin/usdt-tether/", { waitUntil: "domcontentloaded" });

  // Active incidents render a red alert banner; a resolved one does not.
  await expect(page.getByText("Active mint incidents", { exact: false })).toHaveCount(0);

  const summary = page.locator("#mint-authority summary").filter({ hasText: "Incident history" });
  await expect(summary).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await summary.scrollIntoViewIfNeeded();
  // This static-export route hydrates and fetches lazy sections after scroll.
  // All requests are locally fulfilled; settle them before toggling SSR details
  // so hydration cannot replace the just-opened native disclosure.
  await page.waitForLoadState("networkidle");
  const ledger = page.locator("#mint-authority details").filter({ hasText: "Incident history" });
  await expect(ledger).not.toHaveAttribute("open", "");
  const resolved = ledger.getByText("Resolved", { exact: true });
  await expect(resolved).toHaveCount(1);
  await expect(resolved).toBeHidden();
  await summary.focus();
  await summary.press("Enter");
  await expect(ledger).toHaveAttribute("open", "");

  await expect(resolved).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  await summary.press("Enter");
  await expect(resolved).toBeHidden();
});
