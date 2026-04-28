import { test, expect, type Page } from "@playwright/test";
import {
  fixtureChains,
  fixturePegSummary,
  fixtureReportCards,
  fixtureStability,
  fixtureStablecoins,
  fixtureStress,
} from "../../src/app/lighthouse/__fixtures__/pharosville-world";

test.use({ reducedMotion: "reduce" });

const meta = { updatedAt: 1_700_000_000, ageSeconds: 60, status: "fresh" };
async function mockPharosVilleData(page: Page) {
  const payloads: Array<{ path: string; body: unknown }> = [
    { path: "stablecoins", body: fixtureStablecoins },
    { path: "chains", body: fixtureChains },
    { path: "stability-index", body: fixtureStability },
    { path: "peg-summary", body: fixturePegSummary },
    { path: "stress-signals", body: fixtureStress },
    { path: "report-cards", body: fixtureReportCards },
  ];

  for (const { path, body } of payloads) {
    for (const prefix of ["api", "_site-data"]) {
      await page.route(`**/${prefix}/${path}**`, async (route) => {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...(body as Record<string, unknown>), _meta: meta }),
        });
      });
    }
  }
}

test("pharosville renders desktop canvas shell", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/lighthouse/");
  const canvas = page.getByTestId("pharosville-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByLabel("Map entity count")).toHaveText("94 entities");

  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(1000);
  expect(box?.height).toBeGreaterThan(700);

  const nonBlankPixels = await canvas.evaluate((node) => {
    const canvasNode = node as HTMLCanvasElement;
    const context = canvasNode.getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvasNode.width, canvasNode.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) count += 1;
    }
    return count;
  });

  expect(nonBlankPixels).toBeGreaterThan(10_000);
  await expect(page).toHaveScreenshot("pharosville-desktop-shell.png");
});

async function captureWorldRequests(page: Page) {
  const worldRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const worldDataPaths = [
      "/stablecoins",
      "/chains",
      "/stress-signals",
      "/report-cards",
    ];
    const isWorldData = (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_site-data/"))
      && worldDataPaths.some((path) => url.pathname.endsWith(path));
    if (
      isWorldData ||
      url.pathname.startsWith("/pharosville/assets/")
    ) {
      worldRequests.push(url.pathname);
    }
  });
  return worldRequests;
}

test("pharosville narrow fallback avoids world runtime requests", async ({ page }) => {
  const worldRequests = await captureWorldRequests(page);

  await page.setViewportSize({ width: 1279, height: 900 });
  await page.goto("/lighthouse/");

  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "PSI" })).toBeVisible();
  expect(worldRequests).toEqual([]);
  await expect(page).toHaveScreenshot("pharosville-narrow-fallback.png");
});

test("pharosville short desktop fallback avoids clipped map", async ({ page }) => {
  const worldRequests = await captureWorldRequests(page);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/lighthouse/");

  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  expect(worldRequests).toEqual([]);
});
