import { afterEach, describe, expect, it, vi } from "vitest";
import type { PharosVilleAssetManifest, PharosVilleAssetManifestEntry } from "../systems/asset-manifest";
import { PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY, PharosVilleAssetManager } from "./asset-manager";

const baseEntry: PharosVilleAssetManifestEntry = {
  anchor: [24, 24],
  category: "ship",
  displayScale: 1,
  footprint: [1, 1],
  height: 48,
  hitbox: [0, 0, 48, 48],
  id: "ship.base",
  layer: "ships",
  loadPriority: "deferred",
  path: "ships/base.png",
  width: 48,
};

describe("PharosVilleAssetManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads deferred assets with a bounded decode queue and stable semantic ordering", async () => {
    const manifest = makeManifest([
      makeEntry("ship.sixth", "ship", 0),
      makeEntry("ship.seventh", "ship", 1),
      makeEntry("terrain.harbor", "terrain", 2),
      makeEntry("terrain.deep", "terrain", 3),
      makeEntry("overlay.central", "overlay", 4),
      makeEntry("dock.grand", "dock", 5),
      makeEntry("landmark.lighthouse", "landmark", 6),
      makeEntry("prop.crate", "prop", 7),
    ]);
    stubManifestFetch(manifest);
    const starts: string[] = [];
    let activeLoads = 0;
    let peakLoads = 0;
    stubImageLoader((src) => {
      starts.push(src);
      activeLoads += 1;
      peakLoads = Math.max(peakLoads, activeLoads);
      return new Promise((resolve) => {
        setTimeout(() => {
          activeLoads -= 1;
          resolve();
        }, 1);
      });
    });

    const manager = new PharosVilleAssetManager();
    const result = await manager.loadDeferred();

    expect(result.errors).toEqual([]);
    expect(result.loaded).toHaveLength(8);
    expect(peakLoads).toBe(PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY);
    expect(result.stats.peakDeferredConcurrency).toBe(PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY);
    expect(result.stats.deferredBatchesStarted).toBe(1);
    expect(result.stats.activeDeferredLoads).toBe(0);
    expect(result.stats.deferredLoadedCount).toBe(8);
    expect(manager.areDeferredAssetsSettled()).toBe(true);
    expect(starts.slice(0, PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY)).toEqual([
      "/pharosville/assets/terrain/harbor.png?v=test-cache",
      "/pharosville/assets/terrain/deep.png?v=test-cache",
      "/pharosville/assets/overlay/central.png?v=test-cache",
      "/pharosville/assets/docks/grand.png?v=test-cache",
      "/pharosville/assets/landmarks/lighthouse.png?v=test-cache",
      "/pharosville/assets/ships/sixth.png?v=test-cache",
    ]);
  });

  it("reports manifest and readiness stats for critical and deferred assets", async () => {
    const critical = makeEntry("dock.critical", "dock", 0, "critical");
    const requiredDeferred = makeEntry("ship.required", "ship", 1, "deferred");
    const deferred = makeEntry("terrain.deep", "terrain", 2, "deferred");
    const manifest = makeManifest([critical, requiredDeferred, deferred], [critical.id, requiredDeferred.id]);
    stubManifestFetch(manifest);
    stubImageLoader(() => Promise.resolve());

    const manager = new PharosVilleAssetManager();
    await manager.loadManifest();
    expect(manager.getLoadStats()).toMatchObject({
      criticalAssetCount: 2,
      deferredAssetCount: 2,
      loadedAssetCount: 0,
      requiredForFirstRenderCount: 2,
      totalAssetCount: 3,
    });

    const criticalResult = await manager.loadCritical();
    expect(criticalResult.stats).toMatchObject({
      criticalAssetCount: 2,
      criticalLoadedCount: 2,
      deferredLoadedCount: 1,
      loadedAssetCount: 2,
    });
    expect(manager.areCriticalAssetsLoaded()).toBe(true);

    const deferredResult = await manager.loadDeferred();
    expect(deferredResult.stats).toMatchObject({
      deferredAssetCount: 2,
      deferredLoadedCount: 2,
      deferredQueuedCount: 0,
      loadedAssetCount: 3,
      maxDeferredConcurrency: PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY,
    });
    expect(manager.getLoadStats().deferredCompletedAt).toEqual(expect.any(Number));
  });
});

function makeManifest(
  assets: PharosVilleAssetManifestEntry[],
  requiredForFirstRender: string[] = [],
): PharosVilleAssetManifest {
  return {
    assets,
    requiredForFirstRender,
    schemaVersion: 2,
    style: {
      anchor: "test style",
      cacheVersion: "test-cache",
      generationDefaults: {
        detail: "test",
        outline: "test",
        shading: "test",
        transparentBackground: true,
        view: "test",
      },
      palette: ["#000000", "#111111", "#222222", "#333333"],
      styleAnchorVersion: "test-style",
    },
  };
}

function makeEntry(
  id: string,
  category: PharosVilleAssetManifestEntry["category"],
  index: number,
  loadPriority: PharosVilleAssetManifestEntry["loadPriority"] = "deferred",
): PharosVilleAssetManifestEntry {
  const folderByCategory: Record<PharosVilleAssetManifestEntry["category"], string> = {
    dock: "docks",
    landmark: "landmarks",
    overlay: "overlay",
    prop: "props",
    ship: "ships",
    terrain: "terrain",
  };
  return {
    ...baseEntry,
    category,
    id,
    layer: category,
    loadPriority,
    path: `${folderByCategory[category]}/${id.split(".")[1] ?? `asset-${index}`}.png`,
  };
}

function stubManifestFetch(manifest: PharosVilleAssetManifest) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })));
}

function stubImageLoader(onStart: (src: string) => Promise<void>) {
  class MockImage {
    decoding: "async" | "auto" | "sync" = "auto";
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;

    set src(value: string) {
      void onStart(value)
        .then(() => this.onload?.())
        .catch(() => this.onerror?.());
    }
  }
  vi.stubGlobal("Image", MockImage);
}
