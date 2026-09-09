import { expect, test, type Page } from "@playwright/test";
import {
  makeLongCommsStatusResponse,
  makeMaintenanceDebtStatusResponse,
} from "../../../src/test-utils/status-fixtures";
import { installOpsApiFixtures, OPS_FIXTURE_NOW_MS } from "./ops-api-fixtures";
import { expectChildrenContained, sizeViewport } from "./ops-geometry-support";

/**
 * B8 — TelegramBotStats and D1UsageCard containment plus the responsive
 * per-alert delivery toggle (s083-src.md B4). The deleted `sm:hidden` /
 * `sm:block` / `grid-cols-1` spelling pins are replaced by measured
 * visibility and containment. No screenshots.
 */

const HYDRATION_TIMEOUT_MS = 30_000;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(OPS_FIXTURE_NOW_MS));
  await installOpsApiFixtures(page);
});

async function installD1StatusOverride(page: Page): Promise<void> {
  const base = makeLongCommsStatusResponse(makeMaintenanceDebtStatusResponse()) as unknown as Record<string, unknown>;
  const body = {
    ...base,
    d1Usage: {
      checkedAt: 1_712_600_000,
      windowStart: 1_712_513_600,
      windowEnd: 1_712_600_000,
      databaseId: "8f3f54ca-e035-4cdf-9ec5-a4fbde48b27a",
      databaseName: "stablecoin-db",
      databaseSizeBytes: 1_601_986_150,
      numTables: 63,
      region: "WEUR",
      readReplicationMode: "disabled",
      readQueries24h: 170_069,
      writeQueries24h: 543_307,
      rowsRead24h: 3_639_492,
      rowsWritten24h: 98_367_892,
      capacity: {
        observedAt: 1_712_600_000,
        databaseSizeBytes: 6_000_000_000,
        maximumSizeBytes: 10_000_000_000,
        utilizationRatio: 0.6,
        utilizationPercent: 60,
        thresholdState: "watch",
        crossedThresholdPercent: 60,
        nextThresholdPercent: 75,
        sampleCount: 72,
        forecastBasis: "linear-30d",
        forecastSpanHours: 71,
        growthBytesPerDay: 100_000_000,
        nextThresholdAt: 1_713_896_000,
        exhaustionAt: 1_716_056_000,
        daysUntilExhaustion: 40,
      },
    },
  };
  await page.route(/\/_site-data\/status$|\/api\/status$|\/api\/admin\/status$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

test("telegram bot stats per-alert layouts stay contained and toggle at their breakpoint", async ({
  page,
}, testInfo) => {
  await sizeViewport(page, testInfo, 320, 568);
  await page.goto("/admin/comms/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1, name: "Comms", exact: true })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(page.getByText("Per-alert delivery", { exact: true })).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

  // Mobile breakpoint: the stacked rows render, the desktop table stays hidden.
  await expect(page.getByTestId("telegram-delivery-mobile")).toBeVisible();
  await expect(page.getByTestId("telegram-delivery-desktop")).toBeHidden();
  await expectChildrenContained(page, '[data-testid="telegram-delivery-mobile"]');
  await expectChildrenContained(page, 'section[aria-labelledby="comms-per-alert-title"]');

  // Desktop breakpoint: the table renders, the stacked rows hide.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByTestId("telegram-delivery-desktop")).toBeVisible();
  await expect(page.getByTestId("telegram-delivery-mobile")).toBeHidden();
  await expectChildrenContained(page, '[data-testid="telegram-delivery-desktop"]');
});

test("d1 usage card children stay contained within the storage panel at 320x568", async ({ page }, testInfo) => {
  await sizeViewport(page, testInfo, 320, 568);
  await installD1StatusOverride(page);
  await page.goto("/admin/pipeline/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1, name: "Pipeline Health", exact: true })).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await page.getByRole("tab", { name: /^Storage/ }).click();
  await expect(page.getByRole("heading", { name: "D1 Usage" })).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

  await expectChildrenContained(page, '[role="tabpanel"]');
});
