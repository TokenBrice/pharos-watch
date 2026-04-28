import { test, expect, type Page } from "@playwright/test";
import {
  fixtureChains,
  fixturePegSummary,
  fixtureReportCards,
  fixtureStability,
  fixtureStablecoins,
  fixtureStress,
  makePegCoin,
} from "../../src/app/lighthouse/__fixtures__/pharosville-world";
import { MAX_MAIN_CANVAS_PIXELS, MAX_TOTAL_BACKING_PIXELS } from "../../src/app/lighthouse/systems/canvas-budget";
import type { PegSummaryResponse, StressSignalsAllResponse } from "@shared/types";

test.use({ reducedMotion: "reduce" });

const meta = { updatedAt: 1_700_000_000, ageSeconds: 60, status: "fresh" };
async function mockPharosVilleData(page: Page) {
  await mockPharosVillePayloads(page, {
    stablecoins: fixtureStablecoins,
    chains: fixtureChains,
    stability: fixtureStability,
    pegSummary: fixturePegSummary,
    stress: fixtureStress,
    reportCards: fixtureReportCards,
  });
}

async function mockPharosVillePayloads(page: Page, payload: {
  chains: unknown;
  pegSummary: unknown;
  reportCards: unknown;
  stability: unknown;
  stablecoins: unknown;
  stress: unknown;
}) {
  const payloads: Array<{ path: string; body: unknown }> = [
    { path: "stablecoins", body: payload.stablecoins },
    { path: "chains", body: payload.chains },
    { path: "stability-index", body: payload.stability },
    { path: "peg-summary", body: payload.pegSummary },
    { path: "stress-signals", body: payload.stress },
    { path: "report-cards", body: payload.reportCards },
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

async function clickMapTarget(page: Page, kind: string, detailId?: string) {
  const target = await page.waitForFunction(({ targetKind, targetDetailId }) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        targets: Array<{
          detailId: string;
          kind: string;
          rect: { height: number; width: number; x: number; y: number };
        }>;
      };
    }).__pharosVilleDebug;
    return debug?.targets.find((entry) => entry.kind === targetKind && (!targetDetailId || entry.detailId === targetDetailId)) ?? null;
  }, { targetDetailId: detailId, targetKind: kind });
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/lighthouse/");
  const canvas = page.getByTestId("pharosville-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByLabel("Map entity count")).toHaveText("94 entities");
  await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("85.7% water");
  await page.waitForFunction(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { assetsLoaded?: boolean; camera: unknown; targets: unknown[] };
    }).__pharosVilleDebug;
    return Boolean(debug?.assetsLoaded && debug.camera && debug.targets.length > 0);
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
  const pixelStats = await canvasPixelStats(page);
  expect(pixelStats.backingPixels).toBeLessThanOrEqual(1440 * 1000 * 4);
  expect(pixelStats.landPixels).toBeGreaterThan(6_000);
  expect(pixelStats.waterPixels).toBeGreaterThan(25_000);
  expect(pixelStats.waterPixels).toBeGreaterThan(pixelStats.landPixels * 2);
  await expect(page).toHaveScreenshot("pharosville-desktop-shell.png");
});

test("pharosville renders a stressed ship in storm-shelf detail", async ({ page }) => {
  const stressedPegSummary: PegSummaryResponse = {
    ...fixturePegSummary,
    coins: [
      makePegCoin({
        id: "usdt-tether",
        symbol: "USDT",
        activeDepeg: true,
        currentDeviationBps: 650,
        pegScore: 24,
        severityScore: 80,
      }),
      ...fixturePegSummary.coins.filter((coin) => coin.id !== "usdt-tether"),
    ],
  };
  const stressedSignals: StressSignalsAllResponse = {
    ...fixtureStress,
    signals: {
      "usdt-tether": {
        score: 92,
        band: "DANGER",
        signals: {
          peg: { available: true, value: 92 },
        },
        computedAt: 1_700_000_000,
        methodologyVersion: "fixture",
      },
    },
  };
  await mockPharosVillePayloads(page, {
    stablecoins: fixtureStablecoins,
    chains: fixtureChains,
    stability: {
      ...fixtureStability,
      current: {
        ...fixtureStability.current,
        band: "ELEVATED",
        components: { breadth: 16, severity: 42, trend: 8 },
        score: 66,
      },
    },
    pegSummary: stressedPegSummary,
    stress: stressedSignals,
    reportCards: fixtureReportCards,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/lighthouse/");

  const clickedDetailId = await clickMapTarget(page, "ship", "ship.usdt-tether");
  expect(clickedDetailId).toBe("ship.usdt-tether");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Tether");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Active depeg event");
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("storm-shelf");
});

async function captureWorldRequests(page: Page) {
  const worldRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      isPharosVilleWorldRequest(url) ||
      url.pathname.startsWith("/pharosville/assets/")
    ) {
      worldRequests.push(`${url.pathname}${url.search}`);
    }
  });
  return worldRequests;
}

function isPharosVilleWorldRequest(url: URL) {
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/_site-data/")) return false;
  const globalShellPaths = new Set([
    "/api/blacklist-summary",
    "/api/daily-digest",
    "/api/health",
    "/api/peg-summary",
    "/api/stability-index",
    "/_site-data/blacklist-summary",
    "/_site-data/daily-digest",
    "/_site-data/health",
    "/_site-data/peg-summary",
    "/_site-data/stability-index",
  ]);
  if (globalShellPaths.has(url.pathname) && url.search === "") return false;
  const worldDataPaths = [
    "/stablecoins",
    "/chains",
    "/stress-signals",
    "/report-cards",
    "/peg-summary",
  ];
  return worldDataPaths.some((path) => url.pathname.endsWith(path))
    || (url.pathname.endsWith("/stability-index") && url.searchParams.get("detail") === "true");
}

test("pharosville narrow fallback avoids world runtime requests", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  const worldRequests = await captureWorldRequests(page);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/lighthouse/");

  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  expect(worldRequests).toEqual([]);
});

test("pharosville ultrawide canvas keeps DPR backing store capped", async ({ baseURL, browser }) => {
  const context = await browser.newContext({
    deviceScaleFactor: 3,
    reducedMotion: "reduce",
    viewport: { width: 2560, height: 1440 },
  });
  const page = await context.newPage();
  await mockPharosVilleData(page);
  try {
    await page.goto(new URL("/lighthouse/", baseURL ?? "http://127.0.0.1:3000").toString());
    await page.waitForFunction(() => {
      const debug = (window as typeof window & {
        __pharosVilleDebug?: { assetsLoaded?: boolean; camera: unknown; canvasBudget: unknown };
      }).__pharosVilleDebug;
      return Boolean(debug?.assetsLoaded && debug.camera && debug.canvasBudget);
    });

    const metrics = await page.getByTestId("pharosville-canvas").evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const debug = (window as typeof window & {
        __pharosVilleDebug?: {
          canvasBudget?: {
            backingPixels: number;
            effectiveDpr: number;
            maxMainCanvasPixels: number;
            maxTotalBackingPixels: number;
            requestedDpr: number;
          } | null;
        };
      }).__pharosVilleDebug;
      return {
        backingPixels: canvas.width * canvas.height,
        budget: debug?.canvasBudget ?? null,
        cssHeight: Math.floor(rect.height),
        cssWidth: Math.floor(rect.width),
        heightRatio: canvas.height / Math.max(1, rect.height),
        widthRatio: canvas.width / Math.max(1, rect.width),
      };
    });

    expect(metrics.budget?.requestedDpr).toBeGreaterThanOrEqual(3);
    expect(metrics.budget?.effectiveDpr).toBeLessThan(2);
    expect(metrics.budget?.maxMainCanvasPixels).toBe(MAX_MAIN_CANVAS_PIXELS);
    expect(metrics.budget?.maxTotalBackingPixels).toBe(MAX_TOTAL_BACKING_PIXELS);
    expect(metrics.widthRatio).toBeLessThan(2);
    expect(metrics.heightRatio).toBeLessThan(2);
    expect(metrics.backingPixels).toBeLessThanOrEqual(MAX_MAIN_CANVAS_PIXELS);
    expect(metrics.backingPixels).toBeLessThanOrEqual(MAX_TOTAL_BACKING_PIXELS);
  } finally {
    await context.close();
  }
});

test("pharosville canvas interactions update details and camera", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
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

  const fullscreenButton = page.getByRole("button", { name: "Enter fullscreen" });
  await expect(fullscreenButton).toBeVisible();
  await fullscreenButton.click();
  await expect(page.getByTestId("pharosville-world")).toHaveClass(/pharosville-shell--fullscreen/);
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(page.getByTestId("pharosville-world")).not.toHaveClass(/pharosville-shell--fullscreen/);

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
        animationFramePending?: boolean;
        camera: { offsetX: number; offsetY: number; zoom: number } | null;
        cameraWithinBounds?: boolean;
        canvasSize: { x: number; y: number };
      };
    }).__pharosVilleDebug;
    return Boolean(
      debug?.camera
      && debug.canvasSize.x <= 1280
      && debug.canvasSize.y <= 760
      && Object.prototype.hasOwnProperty.call(debug, "animationFramePending"),
    );
  });
  const resizedDebug = await page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        cameraWithinBounds?: boolean;
        animationFramePending?: boolean;
        motionFrameCount?: number;
        reducedMotion?: boolean;
      };
    }).__pharosVilleDebug;
    return debug ?? null;
  });
  expect(resizedDebug?.cameraWithinBounds).toBe(true);
  expect(resizedDebug?.reducedMotion).toBe(true);
  expect(resizedDebug?.animationFramePending).toBe(false);
  expect(resizedDebug?.motionFrameCount ?? 0).toBe(0);
});

test.describe("pharosville normal motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("starts bounded world animation only on eligible desktop", async ({ page }) => {
    await mockPharosVilleData(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/lighthouse/");

    await page.waitForFunction(() => {
      const debug = (window as typeof window & {
        __pharosVilleDebug?: {
          motionFrameCount?: number;
          reducedMotion?: boolean;
        };
      }).__pharosVilleDebug;
      return Boolean(debug && debug.reducedMotion === false && (debug.motionFrameCount ?? 0) >= 2);
    });
  });
});

async function canvasPixelStats(page: Page) {
  return page.getByTestId("pharosville-canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return { backingPixels: 0, landPixels: 0, waterPixels: 0 };
    const sampleWidth = canvas.width;
    const sampleHeight = canvas.height;
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
    let landPixels = 0;
    let waterPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      if (red > 150 && green > 135 && blue > 85) landPixels += 1;
      if (blue > red + 15 && green > red + 8 && blue > 35) waterPixels += 1;
    }
    return {
      backingPixels: canvas.width * canvas.height,
      landPixels,
      waterPixels,
    };
  });
}
