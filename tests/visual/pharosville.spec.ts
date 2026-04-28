import { test, expect, type Page } from "@playwright/test";
import {
  fixtureChains,
  fixturePegSummary,
  fixtureReportCards,
  fixtureStability,
  fixtureStablecoins,
  fixtureStress,
  makePegCoin,
} from "../../src/app/pharosville/__fixtures__/pharosville-world";
import { MAX_MAIN_CANVAS_PIXELS, MAX_TOTAL_BACKING_PIXELS } from "../../src/app/pharosville/systems/canvas-budget";
import type { PegSummaryResponse, StressSignalsAllResponse } from "@shared/types";

test.use({ reducedMotion: "reduce" });

type DebugShipMotionSample = {
  id: string;
  state: string;
  x: number;
  y: number;
  zone: string;
};

type DebugTarget = {
  detailId: string;
  kind: string;
  priority: number;
  rect: { height: number; width: number; x: number; y: number };
};

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
  return (await clickMapTargetWithPoint(page, kind, detailId)).detailId;
}

async function clickMapTargetWithPoint(page: Page, kind: string, detailId?: string) {
  const target = await page.waitForFunction(({ targetKind, targetDetailId }) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        targets: DebugTarget[];
      };
    }).__pharosVilleDebug;
    const candidates = debug?.targets.filter((entry) => entry.kind === targetKind && (!targetDetailId || entry.detailId === targetDetailId)) ?? [];
    for (const candidate of candidates) {
      const points = [
        [0.5, 0.5],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ].map(([x, y]) => ({
        x: candidate.rect.x + candidate.rect.width * x,
        y: candidate.rect.y + candidate.rect.height * y,
      }));
      const point = points.find((candidatePoint) => {
        const topTarget = debug?.targets
          .filter((entry) => (
            candidatePoint.x >= entry.rect.x
            && candidatePoint.x <= entry.rect.x + entry.rect.width
            && candidatePoint.y >= entry.rect.y
            && candidatePoint.y <= entry.rect.y + entry.rect.height
          ))
          .toSorted((a, b) => b.priority - a.priority)[0] ?? null;
        return topTarget?.detailId === candidate.detailId;
      });
      if (point) return { ...candidate, point };
    }
    return null;
  }, { targetDetailId: detailId, targetKind: kind });
  const value = await target.jsonValue() as {
    detailId: string;
    point: { x: number; y: number };
    rect: { height: number; width: number; x: number; y: number };
  };
  await page.getByTestId("pharosville-canvas").click({
    force: true,
    position: value.point,
  });
  return { detailId: value.detailId, point: value.point };
}

test("pharosville renders desktop canvas shell", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  const canvas = page.getByTestId("pharosville-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("pharosville-world-toolbar")).toBeVisible();
  await expect(page.getByTestId("pharosville-query-status-banner")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-detail-panel")).toBeVisible();
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Pharos lighthouse");
  await expect(page.getByTestId("pharosville-map-key")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-keyboard-entity-browser")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-minimap")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("86.3% water");
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
  await page.goto("/pharosville/");

  const clickedDetailId = await clickMapTarget(page, "ship", "ship.usdt-tether");
  expect(clickedDetailId).toBe("ship.usdt-tether");
  await waitForSelectedDetail(page, "ship.usdt-tether");
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
  await page.goto("/pharosville/");

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
  await page.goto("/pharosville/");

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
    await page.goto(new URL("/pharosville/", baseURL ?? "http://127.0.0.1:3000").toString());
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
  test.setTimeout(45_000);
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await expect(page.getByTestId("pharosville-world-toolbar")).toBeVisible();
  await expect(page.getByTestId("pharosville-query-status-banner")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-detail-panel")).toBeVisible();
  await expect(page.getByTestId("pharosville-map-key")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-keyboard-entity-browser")).toHaveCount(0);
  await expect(page.getByTestId("pharosville-minimap")).toHaveCount(0);
  await expectDetailPanelClearOfFullscreenButton(page);

  await clickMapTarget(page, "lighthouse");
  await waitForSelectedDetail(page, "lighthouse");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await waitForSelectedDetail(page, null);
  await expect(page.getByTestId("pharosville-detail-panel")).toHaveCount(0);

  const dockDetailId = await clickMapTarget(page, "dock");
  await waitForSelectedDetail(page, dockDetailId);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await waitForSelectedDetail(page, null);

  const shipSelection = await clickMapTargetWithPoint(page, "ship");
  await waitForSelectedDetail(page, shipSelection.detailId);
  const shipAnchor = await selectedDetailAnchor(page);
  expect(shipAnchor?.x).toBeCloseTo(shipSelection.point.x, 0);
  expect(shipAnchor?.y).toBeCloseTo(shipSelection.point.y, 0);
  await clickBlankMap(page);
  await waitForSelectedDetail(page, null);
  await expect(page.getByTestId("pharosville-detail-panel")).toHaveCount(0);

  await page.getByTestId("pharosville-world").focus();
  await page.keyboard.press("Escape");
  await waitForSelectedDetail(page, null);

  const canvasBoxForZoom = await page.getByTestId("pharosville-canvas").boundingBox();
  expect(canvasBoxForZoom).not.toBeNull();
  const cameraBeforeZoom = await page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return debug?.camera ?? null;
  });
  await page.mouse.move(canvasBoxForZoom!.x + canvasBoxForZoom!.width / 2, canvasBoxForZoom!.y + canvasBoxForZoom!.height / 2);
  await page.mouse.wheel(0, -320);
  await page.waitForFunction((previous) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { camera: { offsetX: number; offsetY: number; zoom: number } | null };
    }).__pharosVilleDebug;
    return Boolean(debug?.camera && previous && debug.camera.zoom !== previous.zoom);
  }, cameraBeforeZoom);

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

test("pharosville reduced motion keeps ship samples static without RAF", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await waitForRuntimeDebug(page, true);

  const first = await readRuntimeSnapshot(page);
  await page.waitForTimeout(250);
  const second = await readRuntimeSnapshot(page);

  expect(first.reducedMotion).toBe(true);
  expect(second.reducedMotion).toBe(true);
  expect(first.motionFrameCount).toBe(0);
  expect(second.motionFrameCount).toBe(0);
  expect(first.animationFramePending).toBe(false);
  expect(second.animationFramePending).toBe(false);
  expect(first.timeSeconds).toBe(0);
  expect(second.timeSeconds).toBe(0);
  expect(first.shipMotionSamples.length).toBeGreaterThan(0);
  expect(second.shipMotionSamples).toEqual(first.shipMotionSamples);
});

async function waitForSelectedDetail(page: Page, detailId: string | null) {
  await page.waitForFunction((expectedDetailId) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { selectedDetailId?: string | null };
    }).__pharosVilleDebug;
    return debug?.selectedDetailId === expectedDetailId;
  }, detailId);
}

async function clickBlankMap(page: Page) {
  const box = await page.getByTestId("pharosville-canvas").boundingBox();
  expect(box).not.toBeNull();
  await page.getByTestId("pharosville-canvas").click({
    position: {
      x: Math.min(44, box!.width - 4),
      y: Math.max(4, box!.height - 44),
    },
  });
}

async function selectedDetailAnchor(page: Page) {
  return page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: { selectedDetailAnchor?: { side: "left" | "right"; x: number; y: number } | null };
    }).__pharosVilleDebug;
    return debug?.selectedDetailAnchor ?? null;
  });
}

async function expectDetailPanelClearOfFullscreenButton(page: Page) {
  const detailBox = await page.locator(".pharosville-detail-dock").boundingBox();
  const fullscreenBox = await page.getByRole("button", { name: "Enter fullscreen" }).boundingBox();
  expect(detailBox).not.toBeNull();
  expect(fullscreenBox).not.toBeNull();
  expect(detailBox!.y).toBeGreaterThanOrEqual(fullscreenBox!.y + fullscreenBox!.height + 8);
}

test.describe("pharosville normal motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("starts bounded world animation and keeps moving ship targets selectable", async ({ page }) => {
    await mockPharosVilleData(page);
    await page.clock.install({ time: new Date("2026-04-28T00:00:00Z") });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/pharosville/");
    await waitForRuntimeDebug(page, false);

    const movedSample = await waitForMovingShipSample(page);
    const movingDetailId = `ship.${movedSample.id}`;
    const selection = await clickMapTargetWithPoint(page, "ship", movingDetailId);
    expect(selection.detailId).toBe(movingDetailId);
    await waitForSelectedDetail(page, movingDetailId);
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Risk water");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Home dock");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Chains present");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Docking cadence");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Route source");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("stablecoins.chainCirculating, pegSummary.coins[], stress.signals[]");
    await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("route summary:");
    await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("risk zone");
  });
});

async function waitForRuntimeDebug(page: Page, reducedMotion: boolean) {
  await page.waitForFunction((expectedReducedMotion) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        assetsLoaded?: boolean;
        camera?: unknown;
        motionFrameCount?: number;
        reducedMotion?: boolean;
        shipMotionSamples?: DebugShipMotionSample[];
        targets?: DebugTarget[];
      };
    }).__pharosVilleDebug;
    return Boolean(
      debug?.assetsLoaded
      && debug.camera
      && debug.reducedMotion === expectedReducedMotion
      && (debug.shipMotionSamples?.length ?? 0) > 0
      && (debug.targets?.some((target) => target.kind === "ship") ?? false)
      && (expectedReducedMotion || (debug.motionFrameCount ?? 0) >= 2),
    );
  }, reducedMotion);
}

async function readRuntimeSnapshot(page: Page) {
  return page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: {
        animationFramePending?: boolean;
        motionFrameCount?: number;
        reducedMotion?: boolean;
        shipMotionSamples?: DebugShipMotionSample[];
        timeSeconds?: number;
      };
    }).__pharosVilleDebug;
    return {
      animationFramePending: debug?.animationFramePending ?? true,
      motionFrameCount: debug?.motionFrameCount ?? -1,
      reducedMotion: debug?.reducedMotion ?? null,
      shipMotionSamples: debug?.shipMotionSamples ?? [],
      timeSeconds: debug?.timeSeconds ?? -1,
    };
  });
}

async function waitForMovingShipSample(page: Page) {
  const first = await readRuntimeSnapshot(page);
  expect(first.reducedMotion).toBe(false);
  expect(first.shipMotionSamples.length).toBeGreaterThan(0);
  await page.clock.fastForward(30_000);
  const second = await readRuntimeSnapshot(page);
  expect(second.motionFrameCount).toBeGreaterThan(first.motionFrameCount);

  const firstById = new Map(first.shipMotionSamples.map((sample) => [sample.id, sample]));
  const movedSample = second.shipMotionSamples.find((sample) => {
    const previous = firstById.get(sample.id);
    return Boolean(previous && sample.state !== "moored" && Math.hypot(sample.x - previous.x, sample.y - previous.y) > 0.001);
  });
  expect(movedSample).toBeDefined();
  return movedSample!;
}

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
