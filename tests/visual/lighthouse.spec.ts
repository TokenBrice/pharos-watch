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

async function clickMapTarget(page: Page, kind: string) {
  const target = await page.waitForFunction((targetKind) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        targets: Array<{
          detailId: string;
          kind: string;
          rect: { height: number; width: number; x: number; y: number };
        }>;
      };
    }).__pharosVilleDebug;
    return debug?.targets.find((entry) => entry.kind === targetKind) ?? null;
  }, kind);
  const value = await target.jsonValue() as {
    detailId: string;
    rect: { height: number; width: number; x: number; y: number };
  };
  await page.getByTestId("pharosville-canvas").click({
    position: {
      x: value.rect.x + value.rect.width / 2,
      y: value.rect.y + value.rect.height / 2,
    },
  });
  return value.detailId;
}

test("pharosville renders desktop canvas shell", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/lighthouse/");
  const canvas = page.getByTestId("pharosville-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByLabel("Map entity count")).toHaveText("94 entities");
  await page.waitForFunction(() => {
    const debug = (window as typeof window & { __pharosVilleDebug?: { camera: unknown; targets: unknown[] } }).__pharosVilleDebug;
    return Boolean(debug?.camera && debug.targets.length > 0);
  });

  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(1000);
  expect(box?.height).toBeGreaterThan(700);

  const nonBlankPixels = await page.waitForFunction(() => {
    const canvasNode = document.querySelector('[data-testid="pharosville-canvas"]') as HTMLCanvasElement | null;
    const context = canvasNode?.getContext("2d");
    if (!canvasNode || !context) return 0;
    const { data } = context.getImageData(0, 0, canvasNode.width, canvasNode.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) count += 1;
    }
    return count > 10_000 ? count : 0;
  });

  expect(await nonBlankPixels.jsonValue()).toBeGreaterThan(10_000);
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
    const isWorldStabilityDetail = (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_site-data/"))
      && url.pathname.endsWith("/stability-index")
      && url.searchParams.get("detail") === "true";
    if (
      isWorldData ||
      isWorldStabilityDetail ||
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

test("pharosville canvas interactions update details and camera", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/lighthouse/");
  await expect(page.getByLabel("Map entity count")).toHaveText("94 entities");

  await clickMapTarget(page, "lighthouse");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Pharos lighthouse");

  await clickMapTarget(page, "dock");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Dock footprint");

  await clickMapTarget(page, "ship");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Market cap");

  await page.getByTestId("pharosville-world").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("No map entity selected");

  const zoom = page.getByLabel("Current zoom");
  const beforeZoom = await zoom.textContent();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom).not.toHaveText(beforeZoom ?? "");

  const cameraBeforeDrag = await page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return debug?.camera ?? null;
  });
  const canvasBox = await page.getByTestId("pharosville-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + 520, canvasBox!.y + 520);
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + 620, canvasBox!.y + 580);
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return Boolean(debug?.camera && previous && (
      debug.camera.offsetX !== previous.offsetX || debug.camera.offsetY !== previous.offsetY
    ));
  }, cameraBeforeDrag);

  const cameraBeforeMinimap = await page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return debug?.camera ?? null;
  });

  await page.getByTestId("pharosville-minimap").click({ position: { x: 96, y: 96 } });
  await page.waitForFunction((previous) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return Boolean(debug?.camera && previous && (
      debug.camera.offsetX !== previous.offsetX || debug.camera.offsetY !== previous.offsetY
    ));
  }, cameraBeforeMinimap);
  await expect(page.getByTestId("pharosville-canvas")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForFunction(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        camera: { offsetX: number; offsetY: number; zoom: number } | null;
        canvasSize: { x: number; y: number };
      };
    }).__pharosVilleDebug;
    return Boolean(debug?.camera && debug.canvasSize.x === 1060 && debug.canvasSize.y === 736 && debug.camera.offsetY <= 124);
  });
});
