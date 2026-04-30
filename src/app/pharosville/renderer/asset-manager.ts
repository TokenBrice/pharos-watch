import type { PharosVilleAssetManifest, PharosVilleAssetManifestEntry } from "../systems/asset-manifest";
import { assetUrl, PHAROSVILLE_ASSET_MANIFEST_PATH } from "../systems/asset-manifest";

export interface LoadedPharosVilleAsset {
  entry: PharosVilleAssetManifestEntry;
  image: HTMLImageElement;
}

export interface LoadedPharosVilleLogo {
  image: HTMLImageElement;
  src: string;
}

export interface PharosVilleAssetLoadError {
  id: string;
  message: string;
  path: string;
  priority: PharosVilleAssetManifestEntry["loadPriority"];
}

export interface PharosVilleAssetLoadResult {
  errors: PharosVilleAssetLoadError[];
  loaded: LoadedPharosVilleAsset[];
  manifest: PharosVilleAssetManifest;
  stats: PharosVilleAssetLoadStats;
}

export interface PharosVilleAssetLoadStats {
  activeDeferredLoads: number;
  criticalAssetCount: number;
  criticalLoadedCount: number;
  deferredAssetCount: number;
  deferredBatchesStarted: number;
  deferredCompletedAt: number | null;
  deferredLoadedCount: number;
  deferredQueuedCount: number;
  deferredStartedAt: number | null;
  failedAssetCount: number;
  failedLogoCount: number;
  loadedAssetCount: number;
  loadedLogoCount: number;
  maxDeferredConcurrency: number;
  peakDeferredConcurrency: number;
  requiredForFirstRenderCount: number;
  totalAssetCount: number;
}

export const PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY = 6;

export class PharosVilleAssetManager {
  private assets = new Map<string, LoadedPharosVilleAsset>();
  private failedAssets = new Map<string, PharosVilleAssetLoadError>();
  private failedLogos = new Set<string>();
  private logos = new Map<string, LoadedPharosVilleLogo>();
  private manifest: PharosVilleAssetManifest | null = null;
  private activeDeferredLoads = 0;
  private deferredBatchesStarted = 0;
  private deferredCompletedAt: number | null = null;
  private deferredStartedAt: number | null = null;
  private peakDeferredConcurrency = 0;

  get(id: string): LoadedPharosVilleAsset | null {
    return this.assets.get(id) ?? null;
  }

  getManifest(): PharosVilleAssetManifest | null {
    return this.manifest;
  }

  getLoadStats(): PharosVilleAssetLoadStats {
    const manifest = this.manifest;
    const criticalIds = new Set<string>();
    for (const asset of manifest?.assets ?? []) {
      if (asset.loadPriority === "critical" || manifest?.requiredForFirstRender.includes(asset.id)) {
        criticalIds.add(asset.id);
      }
    }
    const deferredAssets = manifest?.assets.filter((asset) => asset.loadPriority === "deferred") ?? [];
    return {
      activeDeferredLoads: this.activeDeferredLoads,
      criticalAssetCount: criticalIds.size,
      criticalLoadedCount: countLoaded(this.assets, criticalIds),
      deferredAssetCount: deferredAssets.length,
      deferredBatchesStarted: this.deferredBatchesStarted,
      deferredCompletedAt: this.deferredCompletedAt,
      deferredLoadedCount: deferredAssets.filter((asset) => this.assets.has(asset.id)).length,
      deferredQueuedCount: deferredAssets.filter((asset) => !this.assets.has(asset.id) && !this.failedAssets.has(asset.id)).length,
      deferredStartedAt: this.deferredStartedAt,
      failedAssetCount: this.failedAssets.size,
      failedLogoCount: this.failedLogos.size,
      loadedAssetCount: this.assets.size,
      loadedLogoCount: this.logos.size,
      maxDeferredConcurrency: PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY,
      peakDeferredConcurrency: this.peakDeferredConcurrency,
      requiredForFirstRenderCount: manifest?.requiredForFirstRender.length ?? 0,
      totalAssetCount: manifest?.assets.length ?? 0,
    };
  }

  areCriticalAssetsLoaded(): boolean {
    const manifest = this.manifest;
    if (!manifest) return false;
    return manifest.assets
      .filter((asset) => asset.loadPriority === "critical" || manifest.requiredForFirstRender.includes(asset.id))
      .every((asset) => this.assets.has(asset.id));
  }

  areDeferredAssetsSettled(): boolean {
    const manifest = this.manifest;
    if (!manifest) return false;
    return manifest.assets
      .filter((asset) => asset.loadPriority === "deferred")
      .every((asset) => this.assets.has(asset.id) || this.failedAssets.has(asset.id));
  }

  getLogo(src: string | null | undefined): LoadedPharosVilleLogo | null {
    if (!src) return null;
    return this.logos.get(src) ?? null;
  }

  async loadCritical(signal?: AbortSignal): Promise<PharosVilleAssetLoadResult> {
    const manifest = await this.loadManifest(signal);
    const critical = manifest.assets.filter((asset) => (
      asset.loadPriority === "critical" || manifest.requiredForFirstRender.includes(asset.id)
    ));
    return this.loadAssetGroup(critical, manifest, signal);
  }

  async loadDeferred(signal?: AbortSignal): Promise<PharosVilleAssetLoadResult> {
    const manifest = await this.loadManifest(signal);
    const deferred = orderDeferredAssets(manifest.assets.filter((asset) => asset.loadPriority === "deferred"), manifest);
    return this.loadAssetGroup(deferred, manifest, signal, {
      concurrency: PHAROSVILLE_DEFERRED_ASSET_CONCURRENCY,
      deferred: true,
    });
  }

  async loadManifest(signal?: AbortSignal): Promise<PharosVilleAssetManifest> {
    if (this.manifest) return this.manifest;
    const response = await fetch(PHAROSVILLE_ASSET_MANIFEST_PATH, { signal });
    if (!response.ok) throw new Error(`Failed to load PharosVille asset manifest: ${response.status}`);
    this.manifest = await response.json() as PharosVilleAssetManifest;
    return this.manifest;
  }

  async loadAsset(
    asset: PharosVilleAssetManifestEntry,
    manifest: PharosVilleAssetManifest,
    signal?: AbortSignal,
  ): Promise<LoadedPharosVilleAsset> {
    const cached = this.assets.get(asset.id);
    if (cached) return cached;
    try {
      const image = await loadImage(assetUrl(asset, manifest), signal);
      const loaded = { entry: asset, image };
      this.assets.set(asset.id, loaded);
      this.failedAssets.delete(asset.id);
      return loaded;
    } catch (error) {
      if (!isAbortError(error)) {
        this.failedAssets.set(asset.id, {
          id: asset.id,
          message: errorMessage(error),
          path: asset.path,
          priority: asset.loadPriority,
        });
      }
      throw error;
    }
  }

  async loadLogo(src: string, signal?: AbortSignal): Promise<LoadedPharosVilleLogo> {
    const cached = this.logos.get(src);
    if (cached) return cached;
    if (this.failedLogos.has(src)) throw new Error(`Skipped previously failed logo ${src}`);
    try {
      const image = await loadImage(src, signal);
      const loaded = { image, src };
      this.logos.set(src, loaded);
      return loaded;
    } catch (error) {
      if (!isAbortError(error)) this.failedLogos.add(src);
      throw error;
    }
  }

  async loadLogos(srcs: Iterable<string>, signal?: AbortSignal): Promise<LoadedPharosVilleLogo[]> {
    const uniqueSrcs = [...new Set([...srcs].filter((src) => src.startsWith("/") && !this.failedLogos.has(src)))];
    const settled = await Promise.allSettled(uniqueSrcs.map((src) => this.loadLogo(src, signal)));
    return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  private async loadAssetGroup(
    assets: PharosVilleAssetManifestEntry[],
    manifest: PharosVilleAssetManifest,
    signal?: AbortSignal,
    options: { concurrency?: number; deferred?: boolean } = {},
  ): Promise<PharosVilleAssetLoadResult> {
    if (options.deferred && assets.length > 0) {
      this.deferredBatchesStarted += 1;
      this.deferredStartedAt ??= performanceNow();
      this.deferredCompletedAt = null;
    }
    const settled = await settleAssetLoads(
      assets,
      (asset) => this.loadTrackedAsset(asset, manifest, signal, options.deferred === true),
      options.concurrency ?? assets.length,
    );
    if (options.deferred) this.deferredCompletedAt = performanceNow();
    const loaded: LoadedPharosVilleAsset[] = [];
    const errors: PharosVilleAssetLoadError[] = [];
    settled.forEach((result, index) => {
      const asset = assets[index];
      if (!asset) return;
      if (result.status === "fulfilled") {
        loaded.push(result.value);
        return;
      }
      errors.push({
        id: asset.id,
        message: errorMessage(result.reason),
        path: asset.path,
        priority: asset.loadPriority,
      });
    });
    return { errors, loaded, manifest, stats: this.getLoadStats() };
  }

  private async loadTrackedAsset(
    asset: PharosVilleAssetManifestEntry,
    manifest: PharosVilleAssetManifest,
    signal: AbortSignal | undefined,
    trackDeferred: boolean,
  ): Promise<LoadedPharosVilleAsset> {
    if (!trackDeferred || this.assets.has(asset.id)) return this.loadAsset(asset, manifest, signal);
    this.activeDeferredLoads += 1;
    this.peakDeferredConcurrency = Math.max(this.peakDeferredConcurrency, this.activeDeferredLoads);
    try {
      return await this.loadAsset(asset, manifest, signal);
    } finally {
      this.activeDeferredLoads -= 1;
    }
  }
}

async function settleAssetLoads<T>(
  assets: PharosVilleAssetManifestEntry[],
  load: (asset: PharosVilleAssetManifestEntry) => Promise<T>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  if (assets.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, assets.length));
  const settled: PromiseSettledResult<T>[] = new Array(assets.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < assets.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        settled[index] = { status: "fulfilled", value: await load(assets[index]) };
      } catch (reason) {
        settled[index] = { reason, status: "rejected" };
      }
    }
  }));
  return settled;
}

function orderDeferredAssets(
  assets: PharosVilleAssetManifestEntry[],
  manifest: PharosVilleAssetManifest,
): PharosVilleAssetManifestEntry[] {
  const required = new Set(manifest.requiredForFirstRender);
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) => (
      deferredAssetRank(left.asset, required) - deferredAssetRank(right.asset, required)
      || left.index - right.index
    ))
    .map(({ asset }) => asset);
}

function deferredAssetRank(asset: PharosVilleAssetManifestEntry, required: ReadonlySet<string>) {
  if (required.has(asset.id)) return 0;
  const categoryRank: Record<PharosVilleAssetManifestEntry["category"], number> = {
    terrain: 1,
    overlay: 2,
    dock: 3,
    landmark: 4,
    ship: 5,
    prop: 6,
  };
  return categoryRank[asset.category] ?? 10;
}

function countLoaded(assets: ReadonlyMap<string, LoadedPharosVilleAsset>, ids: ReadonlySet<string>) {
  let loaded = 0;
  ids.forEach((id) => {
    if (assets.has(id)) loaded += 1;
  });
  return loaded;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function performanceNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Image load aborted", "AbortError"));
      return;
    }
    const image = new Image();
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Image load aborted", "AbortError"));
    };
    image.decoding = "async";
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`Failed to load image ${src}`));
    };
    signal?.addEventListener("abort", abort, { once: true });
    image.src = src;
  });
}
