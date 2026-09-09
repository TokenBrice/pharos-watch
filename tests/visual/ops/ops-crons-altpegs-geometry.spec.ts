import { expect, test, type Page } from "@playwright/test";
import {
  makeLongCommsStatusResponse,
  makeMaintenanceDebtStatusResponse,
} from "../../../src/test-utils/status-fixtures";
import { installOpsApiFixtures, OPS_FIXTURE_NOW_MS } from "./ops-api-fixtures";
import { expectStickyHeaderInvariant, sizeViewport } from "./ops-geometry-support";

/**
 * B3 — /admin/crons local-scroll sticky header, /alt-pegs fullscreen dialog
 * sizing, and the emblem hover-card viewport containment (s059-src.md B3).
 * jsdom deleted the geometry/radius/hover-wiring pins; the browser reasserts
 * the observable layout. No screenshots.
 */

const HYDRATION_TIMEOUT_MS = 30_000;

// Real cron job keys (shared/lib/cron-jobs.ts) so the attention view renders
// enough rows to make the cron table viewport actually scroll.
const CRON_JOB_KEYS = [
  "sync-stablecoins",
  "sync-stablecoin-charts",
  "sync-fx-rates",
  "stability-index",
  "compute-dews",
  "project-tape",
  "reserve-recovery",
  "status-self-check",
  "data-invariant-canary",
  "cron-sentinel",
  "dispatch-telegram-alerts",
  "telegram-personalized-recap-planner",
  "telegram-degradation-watchdog",
  "telegram-disambiguation-cleanup",
  "telegram-pulse-snapshot",
  "sync-blacklist",
  "sync-mint-burn",
  "sync-mint-burn-extended",
  "sync-dex-discovery",
  "sync-cl-exit-depth",
  "sync-dex-liquidity-stage",
  "sync-dex-liquidity",
  "sync-yield-data",
  "sync-yield-supplemental",
  "compute-depeg-resolver",
];

function cronHeavyStatus(): Record<string, unknown> {
  const base = makeLongCommsStatusResponse(makeMaintenanceDebtStatusResponse()) as unknown as {
    crons: Record<string, unknown>;
    timestamp: number;
  };
  const crons: Record<string, unknown> = {};
  CRON_JOB_KEYS.forEach((job, index) => {
    crons[job] = {
      lastRun: {
        startedAt: base.timestamp - 300 - index,
        durationMs: 200 + index,
        status: "degraded",
        itemCount: index + 1,
      },
      recentRuns: [{ startedAt: base.timestamp - 300 - index, durationMs: 200 + index, status: "degraded" }],
      expectedIntervalSec: 900,
      healthy: false,
    };
  });
  return { ...base, crons };
}

async function installStatusOverride(page: Page): Promise<void> {
  const body = cronHeavyStatus();
  await page.route(/\/_site-data\/status$|\/api\/status$|\/api\/admin\/status$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

function nonUsdStablecoins(): Record<string, unknown> {
  const coin = (id: string, name: string, symbol: string, capUsd: number) => ({
    id,
    name,
    symbol,
    geckoId: id,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "fixture",
    circulating: { peggedUSD: capUsd },
    circulatingPrevDay: { peggedUSD: capUsd },
    circulatingPrevWeek: { peggedUSD: capUsd },
    circulatingPrevMonth: { peggedUSD: capUsd },
    chainCirculating: {},
    chains: [],
  });
  return {
    peggedAssets: [
      coin("eurc-circle", "EURC", "EURC", 4_000_000_000),
      coin("xaut-tether", "Tether Gold", "XAUT", 600_000_000),
      coin("gbpm-mento", "Mento GBP", "GBPm", 1_000_000),
    ],
  };
}

async function installStablecoinsOverride(page: Page): Promise<void> {
  const body = nonUsdStablecoins();
  await page.route(/\/_site-data\/stablecoins$|\/api\/stablecoins$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(OPS_FIXTURE_NOW_MS));
  await installOpsApiFixtures(page);
});

test("cron table header stays pinned while its viewport scrolls at 390x844", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 390, 844);
  await installStatusOverride(page);
  await page.goto("/admin/crons/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1, name: "Cron Lanes", exact: true })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(page.getByRole("table", { name: "Cron jobs by trigger group" })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });

  await expectStickyHeaderInvariant(
    page,
    '[data-slot="table-viewport"]:has(table[aria-label="Cron jobs by trigger group"])',
    "thead",
  );
});

test("atlas fullscreen dialog fills the viewport at 1280x720", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 1280, 720);
  await installStablecoinsOverride(page);
  await page.goto("/alt-pegs/", { waitUntil: "domcontentloaded" });

  const expand = page.getByRole("button", { name: "Expand atlas", exact: true });
  await expect(expand).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await expand.click();

  const dialog = page.getByRole("dialog", { name: "Peg Diversity Atlas" });
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box, "fullscreen dialog must have a measurable box").not.toBeNull();
  // The content uses inset-2 (<640px) and sm:inset-4 (>=640px): it fills the
  // viewport with a small chrome inset, never a floating partial panel.
  expect(box!.width).toBeGreaterThan(1280 * 0.9);
  expect(box!.height).toBeGreaterThan(720 * 0.9);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280 + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720 + 1);
});

test("emblem hover card stays inside the viewport at 390x844 and 1280x720", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 390, 844);
  await installStablecoinsOverride(page);
  await page.goto("/alt-pegs/", { waitUntil: "domcontentloaded" });

  const emblems = page.locator("a.coin-emblem");
  await expect(emblems.first()).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  const count = await emblems.count();
  expect(count, "the atlas should place non-USD coin emblems").toBeGreaterThan(0);

  // Hover the largest EURC emblem (centrally placed) and measure the revealed
  // hover card against the viewport once its entrance transition settles.
  const emblem = page.locator('a.coin-emblem-hit-target[data-hit-coin-id="eurc-circle"]');
  await expect(emblem).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  const tooltip = page.locator('#coin-emblem-card-eurc-circle');

  for (const [width, height] of [
    [390, 844],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await emblem.scrollIntoViewIfNeeded();
    // Neighboring hit circles overlap: use an exposed point of EURC rather
    // than its center, which can belong to the GBP hit target on mobile.
    const point = await emblem.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      for (let y = rect.top + 2; y < rect.bottom; y += 2) {
        for (let x = rect.left + 2; x < rect.right; x += 2) {
          if (document.elementFromPoint(x, y) === el) return { x, y };
        }
      }
      return null;
    });
    expect(point, "EURC must have a pointer-accessible hit area").not.toBeNull();
    await page.mouse.move(point!.x, point!.y);
    await expect(tooltip).toBeVisible();
    await page.waitForTimeout(350);
    const box = await tooltip.boundingBox();
    expect(box, `hover card must be measurable at ${width}x${height}`).not.toBeNull();
    expect(box!.x, "hover card left edge escapes viewport").toBeGreaterThanOrEqual(-1);
    expect(box!.y, "hover card top edge escapes viewport").toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, "hover card right edge escapes viewport").toBeLessThanOrEqual(width + 1);
    expect(box!.y + box!.height, "hover card bottom edge escapes viewport").toBeLessThanOrEqual(height + 1);
  }
});
