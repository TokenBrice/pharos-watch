import { test, expect, type Page } from "@playwright/test";
import {
  fixtureChains,
  denseFixtureChains,
  denseFixturePegSummary,
  denseFixtureReportCards,
  denseFixtureStablecoins,
  denseFixtureStress,
  fixturePegSummary,
  fixtureReportCards,
  fixtureStability,
  fixtureStablecoins,
  fixtureStress,
  makePegCoin,
} from "../../src/app/pharosville/__fixtures__/pharosville-world";
import { MAX_MAIN_CANVAS_PIXELS, MAX_TOTAL_BACKING_PIXELS } from "../../src/app/pharosville/systems/canvas-budget";
import { tileToScreen } from "../../src/app/pharosville/systems/projection";
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

type DebugCamera = {
  offsetX: number;
  offsetY: number;
  zoom: number;
};

type DebugRenderMetrics = {
  drawableCount: number;
  drawableCounts: {
    body: number;
    overlay: number;
    selection: number;
    underlay: number;
  };
  drawDurationMs: number;
  movingShipCount: number;
  visibleTileCount: number;
};

type PharosVilleVisualDebug = {
  activeMotionLoopCount?: number;
  animationFramePending?: boolean;
  assetLoadErrors?: unknown[];
  assetsLoaded?: boolean;
  camera?: DebugCamera | null;
  canvasBudget?: unknown;
  canvasSize?: { x: number; y: number };
  criticalAssetsLoaded?: boolean;
  deferredAssetsLoaded?: boolean;
  motionClockSource?: "requestAnimationFrame" | "reduced-motion-static-frame";
  motionCueCounts?: {
    ambientBirds: number;
    animatedShips: number;
    effectShips: number;
    harborLights: number;
    moverShips: number;
    selectedRelationshipOverlays: number;
  };
  motionFrameCount?: number;
  reducedMotion?: boolean;
  renderMetrics?: DebugRenderMetrics;
  shipMotionSamples?: DebugShipMotionSample[];
  targets?: DebugTarget[];
  timeSeconds?: number;
};

const meta = { updatedAt: 1_700_000_000, ageSeconds: 60, status: "fresh" };
const PHAROSVILLE_DESKTOP_DATA_ENDPOINTS = [
  "/stablecoins",
  "/chains",
  "/stability-index",
  "/peg-summary",
  "/stress-signals",
  "/report-cards",
] as const;
const PHAROSVILLE_SHARED_SHELL_ENDPOINTS = new Set([
  "/api/peg-summary",
  "/api/stability-index",
  "/_site-data/peg-summary",
  "/_site-data/stability-index",
]);
const RISK_WATER_AREA_DETAILS = [
  { detailId: "area.dews.calm", label: "Calm Anchorage", zone: "calm" },
  { detailId: "area.dews.watch", label: "Watch Breakwater", zone: "watch" },
  { detailId: "area.dews.alert", label: "Alert Channel", zone: "alert" },
  { detailId: "area.dews.warning", label: "Warning Shoals", zone: "warning" },
  { detailId: "area.dews.danger", label: "Danger Strait", zone: "danger" },
  { detailId: "area.risk-water.ledger-mooring", label: "Ledger Mooring", zone: "ledger" },
] as const;
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

async function mockDensePharosVilleData(page: Page) {
  await mockPharosVillePayloads(page, {
    stablecoins: denseFixtureStablecoins,
    chains: denseFixtureChains,
    stability: {
      ...fixtureStability,
      current: {
        ...fixtureStability.current,
        band: "ELEVATED",
        components: { breadth: 26, severity: 54, trend: 12 },
        score: 72,
      },
    },
    pegSummary: denseFixturePegSummary,
    stress: denseFixtureStress,
    reportCards: denseFixtureReportCards,
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
    const candidates = debug?.targets?.filter((entry) => entry.kind === targetKind && (!targetDetailId || entry.detailId === targetDetailId)) ?? [];
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
          ?.filter((entry) => (
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

async function expectNoAssetLoadErrors(page: Page) {
  const statusHandle = await page.waitForFunction(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    if (!debug) return null;
    const assetLoadErrors = debug.assetLoadErrors ?? [];
    if (assetLoadErrors.length > 0 || (debug.criticalAssetsLoaded && debug.deferredAssetsLoaded)) {
      return {
        assetLoadErrors,
        criticalAssetsLoaded: debug.criticalAssetsLoaded ?? false,
        deferredAssetsLoaded: debug.deferredAssetsLoaded ?? false,
      };
    }
    return null;
  });
  const status = await statusHandle.jsonValue();
  expect(status.assetLoadErrors).toEqual([]);
  expect(status.criticalAssetsLoaded).toBe(true);
  expect(status.deferredAssetsLoaded).toBe(true);
}

async function expectNoBuildingTargets(page: Page) {
  const buildingTargets = await page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    return (debug?.targets ?? [])
      .filter((target) => target.kind === "building" || target.detailId.startsWith("building."))
      .map((target) => target.detailId);
  });

  expect(buildingTargets).toEqual([]);
}

test("pharosville renders desktop canvas shell", async ({ page }) => {
  await mockPharosVilleData(page);
  const retiredSummaryRequests = collectRetiredSummaryRequests(page);
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
  await expect(page.locator('aside[aria-label="Main navigation"]')).toHaveCount(0);
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to Pharos homepage" })).toBeVisible();
  const ledgerText = await page.getByTestId("pharosville-accessibility-ledger").textContent();
  expect(ledgerText).toContain("56 by 56 tiles");
  const waterRatioText = ledgerText?.split(" tiles, ")[1]?.split("% water.")[0];
  expect(waterRatioText).toBeDefined();
  const waterPercent = Number(waterRatioText);
  expect(waterPercent).toBeGreaterThanOrEqual(78);
  expect(waterPercent).toBeLessThanOrEqual(82);
  await page.waitForFunction(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    return Boolean(debug?.criticalAssetsLoaded && debug.camera && (debug.targets?.length ?? 0) > 0);
  });
  await expectNoAssetLoadErrors(page);
  await expectNoBuildingTargets(page);

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
  expect(pixelStats.waterPixels).toBeGreaterThan(pixelStats.landPixels * 1.5);
  expect(pixelStats.landPixels / pixelStats.backingPixels).toBeLessThan(0.45);
  expect(pixelStats.waterPixels / pixelStats.backingPixels).toBeLessThan(0.86);
  expect(retiredSummaryRequests).toEqual([]);
  await expect(page).toHaveScreenshot("pharosville-desktop-shell.png");
});

test("pharosville dense visual fixture preserves districts, flotillas, and render budget", async ({ page }) => {
  await mockDensePharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await waitForRuntimeDebug(page, false);
  await expectNoAssetLoadErrors(page);

  const debug = await readVisualDebug(page);
  const targets = debug.targets ?? [];
  expect(targets.filter((target) => target.kind === "dock")).toHaveLength(10);
  expect(targets.filter((target) => target.kind === "ship")).toHaveLength(128);
  expect(targets.filter((target) => target.kind === "ship-cluster").length).toBeGreaterThan(0);
  expect(targets.filter((target) => target.kind === "grave").length).toBeGreaterThan(10);

  await expectDrawDurationP95Within(page, 90, 24);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await waitForRuntimeDebug(page, true);
  await clickBlankMap(page);
  await page.mouse.move(8, 8);
  await waitForSelectedDetail(page, null);
  await page.waitForTimeout(250);
  const stillDebug = await readVisualDebug(page);
  const stillTargets = stillDebug.targets ?? [];
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const viewportSize = viewport!;
  await expect(page).toHaveScreenshot("pharosville-dense-lighthouse.png", {
    clip: clipForTargets(stillTargets, (target) => target.detailId === "lighthouse", viewportSize, 92, { height: 280, width: 260 }),
  });
  await expect(page).toHaveScreenshot("pharosville-dense-evm-bay.png", {
    clip: clipForTargets(stillTargets, (target) => (
      target.kind === "dock" && ["dock.ethereum", "dock.base", "dock.arbitrum", "dock.polygon"].includes(target.detailId)
    ), viewportSize, 88, { height: 300, width: 380 }),
  });
  await expect(page).toHaveScreenshot("pharosville-dense-ship-flotillas.png", {
    clip: clipForTargets(stillTargets, (target) => target.kind === "ship-cluster" || target.detailId === "area.dews.watch", viewportSize, 96, { height: 280, width: 420 }),
  });
  await expect(page).toHaveScreenshot("pharosville-dense-cemetery.png", {
    clip: clipForTargets(stillTargets, (target) => target.kind === "grave", viewportSize, 80, { height: 260, width: 360 }),
  });
  expect(stillDebug.camera).not.toBeNull();
  await expect(page).toHaveScreenshot("pharosville-dense-civic-core.png", {
    clip: clipAroundPoint(tileToScreen({ x: 34, y: 30 }, stillDebug.camera!), viewportSize, { height: 300, width: 420 }),
  });
  await expect(page).toHaveScreenshot("pharosville-dense-risk-water.png", {
    clip: clipForTargets(stillTargets, (target) => (
      target.detailId === "area.dews.warning"
      || target.detailId === "area.dews.danger"
      || target.detailId === "area.dews.alert"
    ), viewportSize, 104, { height: 320, width: 460 }),
  });
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
  await expectNoAssetLoadErrors(page);

  await page.getByRole("button", { name: "Clear selection" }).click();
  await waitForSelectedDetail(page, null);

  const clickedDetailId = await clickMapTarget(page, "ship", "ship.usdt-tether");
  expect(clickedDetailId).toBe("ship.usdt-tether");
  await waitForSelectedDetail(page, "ship.usdt-tether");
  const detailPanel = page.getByTestId("pharosville-detail-panel");
  await expect(detailPanel).toContainText("Tether");
  await expect(detailPanel).toContainText("Active depeg event");
  await expect(detailPanel).toContainText("Risk placement key");
  await expect(detailPanel).toContainText("storm-shelf");
  await expect(detailPanel).toContainText("Risk water area");
  await expect(detailPanel).toContainText("Danger Strait");
  await expect(detailPanel).toContainText("Risk water zone");
  await expect(detailPanel).toContainText("danger");
  await expect(detailPanel).toContainText("Evidence");
  await expect(detailPanel).toContainText("pegSummary.coins[].activeDepeg");
});

test("pharosville exposes all named risk water areas in browser details", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await expectNoAssetLoadErrors(page);

  const ledger = page.getByTestId("pharosville-accessibility-ledger");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await waitForSelectedDetail(page, null);
  for (const area of RISK_WATER_AREA_DETAILS) {
    await test.step(area.detailId, async () => {
      await expect(ledger).toContainText(area.label);
      const clickedDetailId = await clickMapTarget(page, "area", area.detailId);
      expect(clickedDetailId).toBe(area.detailId);
      await waitForSelectedDetail(page, area.detailId);
      const detailPanel = page.getByTestId("pharosville-detail-panel");
      await expect(detailPanel).toContainText(area.label);
      await expect(detailPanel).toContainText("Risk water zone");
      await expect(detailPanel).toContainText(area.zone);
      await page.getByRole("button", { name: "Clear selection" }).click();
      await waitForSelectedDetail(page, null);
    });
  }
});

async function denyPharosVilleViewportGatedRequests(page: Page) {
  const deniedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (isPharosVilleViewportGatedRequest(url)) {
      deniedRequests.push(`${url.pathname}${url.search}`);
    }
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (isPharosVilleViewportGatedRequest(url)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return deniedRequests;
}

function collectRetiredSummaryRequests(page: Page): string[] {
  const retiredPath = ["blacklist", "summary"].join("-");
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/${retiredPath}`)) requests.push(`${url.pathname}${url.search}`);
  });
  return requests;
}

function isPharosVilleViewportGatedRequest(url: URL) {
  const retiredPath = ["blacklist", "summary"].join("-");
  if (url.pathname.endsWith(`/${retiredPath}`)) return true;
  if (
    url.pathname.startsWith("/pharosville/assets/")
    || url.pathname.startsWith("/logos/")
  ) {
    return true;
  }
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/_site-data/")) return false;
  // These no-query endpoints are also consumed by the page shell outside PharosVilleDesktopData.
  // The viewport gate can assert the desktop-only stability detail request via ?detail=true.
  if (PHAROSVILLE_SHARED_SHELL_ENDPOINTS.has(url.pathname) && url.search === "") return false;
  return PHAROSVILLE_DESKTOP_DATA_ENDPOINTS.some((path) => url.pathname.endsWith(path));
}

test("pharosville narrow fallback avoids world runtime requests", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const deniedRequests = await denyPharosVilleViewportGatedRequests(page);

  await page.setViewportSize({ width: 1279, height: 900 });
  await page.goto("/pharosville/");

  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "PSI" })).toBeVisible();
  expect(deniedRequests).toEqual([]);
  await expect(page).toHaveScreenshot("pharosville-narrow-fallback.png");
});

test("pharosville short desktop fallback avoids clipped map", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const deniedRequests = await denyPharosVilleViewportGatedRequests(page);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/pharosville/");

  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  expect(deniedRequests).toEqual([]);
});

test("pharosville desktop gate includes threshold viewport and excludes edge-below viewports", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/pharosville/");
  await expect(page.getByTestId("pharosville-canvas")).toBeVisible();
  await waitForRuntimeDebug(page, true);

  await page.setViewportSize({ width: 1279, height: 760 });
  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 759 });
  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
});

test("pharosville resizing below desktop gate unmounts world runtime and stops gated requests", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await waitForRuntimeDebug(page, false);
  const beforeResize = await readRuntimeSnapshot(page);
  expect(beforeResize.activeMotionLoopCount).toBe(1);

  const postResizeGatedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (isPharosVilleViewportGatedRequest(url)) {
      postResizeGatedRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.setViewportSize({ width: 1279, height: 759 });
  await expect(page.getByText("PharosVille needs a wider harbor.")).toBeVisible();
  await expect(page.getByTestId("pharosville-canvas")).toHaveCount(0);
  await page.waitForTimeout(150);

  const debugAfterResize = await page.evaluate(() => {
    const debug = (window as typeof window & { __pharosVilleDebug?: PharosVilleVisualDebug }).__pharosVilleDebug;
    return debug ?? null;
  });
  expect(debugAfterResize).toBeNull();
  expect(postResizeGatedRequests).toEqual([]);
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
        __pharosVilleDebug?: PharosVilleVisualDebug;
      }).__pharosVilleDebug;
      return Boolean(debug?.criticalAssetsLoaded && debug.camera && debug.canvasBudget);
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
        availableWidth: Math.floor(
          window.innerWidth - (document.querySelector("aside")?.getBoundingClientRect().width ?? 0),
        ),
        widthRatio: canvas.width / Math.max(1, rect.width),
      };
    });

    expect(metrics.cssWidth).toBeGreaterThanOrEqual(metrics.availableWidth - 1);
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

  await waitForSelectedDetail(page, "lighthouse");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await waitForSelectedDetail(page, null);
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

  await expectNoBuildingTargets(page);

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
  expect(first.activeMotionLoopCount).toBe(0);
  expect(second.activeMotionLoopCount).toBe(0);
  expect(first.motionClockSource).toBe("reduced-motion-static-frame");
  expect(first.timeSeconds).toBe(0);
  expect(second.timeSeconds).toBe(0);
  expect(first.shipMotionSamples.length).toBeGreaterThan(0);
  expect(second.shipMotionSamples).toEqual(first.shipMotionSamples);
  expect(first.renderMetrics?.drawableCount).toBeGreaterThan(0);
  expect(first.renderMetrics?.visibleTileCount).toBeGreaterThan(0);
  expect(first.renderMetrics?.movingShipCount).toBe(0);
  expect(second.renderMetrics?.drawableCount).toBe(first.renderMetrics?.drawableCount);
  expect(second.renderMetrics?.drawableCounts).toEqual(first.renderMetrics?.drawableCounts);
  expect(second.renderMetrics?.movingShipCount).toBe(0);
  expect(second.renderMetrics?.visibleTileCount).toBe(first.renderMetrics?.visibleTileCount);
});

test("pharosville responds to live reduced-motion preference transitions", async ({ page }) => {
  await mockPharosVilleData(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pharosville/");
  await waitForRuntimeDebug(page, false);

  const beforeReduce = await readRuntimeSnapshot(page);
  expect(beforeReduce.reducedMotion).toBe(false);
  expect(beforeReduce.activeMotionLoopCount).toBe(1);
  expect(beforeReduce.motionFrameCount).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await waitForRuntimeDebug(page, true);
  const reduced = await readRuntimeSnapshot(page);
  expect(reduced.reducedMotion).toBe(true);
  expect(reduced.animationFramePending).toBe(false);
  expect(reduced.activeMotionLoopCount).toBe(0);
  expect(reduced.timeSeconds).toBe(0);

  await page.waitForTimeout(250);
  const reducedLater = await readRuntimeSnapshot(page);
  expect(reducedLater.reducedMotion).toBe(true);
  expect(reducedLater.animationFramePending).toBe(false);
  expect(reducedLater.motionFrameCount).toBe(reduced.motionFrameCount);
  expect(reducedLater.shipMotionSamples).toEqual(reduced.shipMotionSamples);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await waitForRuntimeDebug(page, false);
  const afterRestore = await readRuntimeSnapshot(page);
  expect(afterRestore.reducedMotion).toBe(false);
  expect(afterRestore.animationFramePending).toBe(true);
  expect(afterRestore.activeMotionLoopCount).toBe(1);
  expect(afterRestore.motionFrameCount).toBeGreaterThan(reducedLater.motionFrameCount);
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

async function readVisualDebug(page: Page): Promise<PharosVilleVisualDebug> {
  return page.evaluate(() => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    return debug ?? {};
  });
}

async function expectDrawDurationP95Within(page: Page, budgetMs: number, samples: number) {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    await page.waitForTimeout(50);
    const runtime = await readRuntimeSnapshot(page);
    const duration = runtime.renderMetrics?.drawDurationMs;
    if (typeof duration === "number" && Number.isFinite(duration)) durations.push(duration);
  }

  expect(durations.length).toBeGreaterThanOrEqual(Math.min(8, samples));
  const sorted = durations.toSorted((first, second) => first - second);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
  expect(p95).toBeLessThanOrEqual(budgetMs);
  return p95;
}

function clipForTargets(
  targets: readonly DebugTarget[],
  select: (target: DebugTarget) => boolean,
  viewport: { height: number; width: number },
  padding: number,
  minimum: { height: number; width: number },
) {
  const selected = targets.filter(select);
  expect(selected.length).toBeGreaterThan(0);

  const minX = Math.min(...selected.map((target) => target.rect.x));
  const minY = Math.min(...selected.map((target) => target.rect.y));
  const maxX = Math.max(...selected.map((target) => target.rect.x + target.rect.width));
  const maxY = Math.max(...selected.map((target) => target.rect.y + target.rect.height));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = Math.min(viewport.width, Math.max(minimum.width, maxX - minX + padding * 2));
  const height = Math.min(viewport.height, Math.max(minimum.height, maxY - minY + padding * 2));
  const x = Math.max(0, Math.min(viewport.width - width, centerX - width / 2));
  const y = Math.max(0, Math.min(viewport.height - height, centerY - height / 2));

  return {
    height: Math.round(height),
    width: Math.round(width),
    x: Math.round(x),
    y: Math.round(y),
  };
}

function clipAroundPoint(
  point: { x: number; y: number },
  viewport: { height: number; width: number },
  size: { height: number; width: number },
) {
  const width = Math.min(viewport.width, size.width);
  const height = Math.min(viewport.height, size.height);
  return {
    height: Math.round(height),
    width: Math.round(width),
    x: Math.round(Math.max(0, Math.min(viewport.width - width, point.x - width / 2))),
    y: Math.round(Math.max(0, Math.min(viewport.height - height, point.y - height / 2))),
  };
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
    const runtime = await readRuntimeSnapshot(page);
    expect(runtime.activeMotionLoopCount).toBe(1);
    expect(runtime.motionClockSource).toBe("requestAnimationFrame");
    expect(runtime.motionCueCounts?.selectedRelationshipOverlays).toBeLessThanOrEqual(1);
    expect(runtime.motionCueCounts?.ambientBirds).toBeLessThanOrEqual(9);
    expect(runtime.motionCueCounts?.harborLights).toBeLessThanOrEqual(3);
    expect(runtime.motionCueCounts?.effectShips ?? 0).toBeLessThanOrEqual(runtime.motionCueCounts?.animatedShips ?? 0);
    expect(runtime.renderMetrics?.drawableCount).toBeGreaterThan(0);
    expect(runtime.renderMetrics?.drawableCounts.body).toBeGreaterThan(0);
    expect(runtime.renderMetrics?.drawDurationMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(90);
    expect(runtime.renderMetrics?.movingShipCount).toBeGreaterThan(0);
    expect(runtime.renderMetrics?.visibleTileCount).toBeGreaterThan(0);
    const movingDetailId = `ship.${movedSample.id}`;
    const selection = await clickMapTargetWithPoint(page, "ship", movingDetailId);
    expect(selection.detailId).toBe(movingDetailId);
    await waitForSelectedDetail(page, movingDetailId);
    await page.clock.fastForward(1_000);
    await page.waitForFunction((detailId) => {
      const debug = (window as typeof window & {
        __pharosVilleDebug?: PharosVilleVisualDebug;
      }).__pharosVilleDebug;
      return debug?.selectedDetailId === detailId && (debug.renderMetrics?.drawableCounts.selection ?? 0) > 0;
    }, movingDetailId);
    const selectedRuntime = await readRuntimeSnapshot(page);
    expect(selectedRuntime.renderMetrics?.drawableCounts.selection).toBeGreaterThan(0);
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Risk water area");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Home dock");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Chains present");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Docking cadence");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("Route source");
    await expect(page.getByTestId("pharosville-detail-panel")).toContainText("stablecoins.chainCirculating, pegSummary.coins[], stress.signals[]");
    await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("route summary:");
    await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("risk water Calm Anchorage");
    await expect(page.getByTestId("pharosville-accessibility-ledger")).toContainText("risk zone");
  });
});

async function waitForRuntimeDebug(page: Page, reducedMotion: boolean) {
  await page.waitForFunction((expectedReducedMotion) => {
    const debug = (window as typeof window & {
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    return Boolean(
      debug?.criticalAssetsLoaded
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
      __pharosVilleDebug?: PharosVilleVisualDebug;
    }).__pharosVilleDebug;
    return {
      activeMotionLoopCount: debug?.activeMotionLoopCount ?? -1,
      animationFramePending: debug?.animationFramePending ?? true,
      motionClockSource: debug?.motionClockSource ?? null,
      motionCueCounts: debug?.motionCueCounts ?? null,
      motionFrameCount: debug?.motionFrameCount ?? -1,
      reducedMotion: debug?.reducedMotion ?? null,
      renderMetrics: debug?.renderMetrics ?? null,
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
  const transitStates = new Set(["departing", "arriving", "sailing"]);
  const movedSample = second.shipMotionSamples.find((sample) => {
    const previous = firstById.get(sample.id);
    return Boolean(previous && transitStates.has(sample.state) && Math.hypot(sample.x - previous.x, sample.y - previous.y) > 0.25);
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
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const isDuskSkyBand = (
        red > 120
        && green > 70
        && blue > 45
        && red >= green + 28
        && green >= blue - 8
      );
      const isWaterBand = (
        blue > 40
        && green > 35
        && blue >= red + 6
        && green >= red - 12
      ) || (
        green > 55
        && blue > 45
        && red < 95
        && green >= red + 8
        && blue >= red + 12
        && Math.abs(blue - green) < 45
      );
      const isTerrainBand = !isWaterBand && !isDuskSkyBand && (
        (red > 110 && green > 85 && blue < 145 && red >= blue + 14)
        || (green > 58 && green >= red + 6 && green >= blue - 8 && blue < 145)
        || (red > 70 && green > 60 && blue > 45 && max - min < 55)
      );
      if (isTerrainBand) landPixels += 1;
      if (isWaterBand) waterPixels += 1;
    }
    return {
      backingPixels: canvas.width * canvas.height,
      landPixels,
      waterPixels,
    };
  });
}
