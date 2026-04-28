import type { PharosVilleAssetManifest, PharosVilleAssetManifestEntry } from "../systems/asset-manifest";
import { assetUrl, PHAROSVILLE_ASSET_MANIFEST_PATH } from "../systems/asset-manifest";

export interface LoadedPharosVilleAsset {
  entry: PharosVilleAssetManifestEntry;
  image: HTMLImageElement;
}

export class PharosVilleAssetManager {
  private assets = new Map<string, LoadedPharosVilleAsset>();
  private manifest: PharosVilleAssetManifest | null = null;

  get(id: string): LoadedPharosVilleAsset | null {
    return this.assets.get(id) ?? null;
  }

  getManifest(): PharosVilleAssetManifest | null {
    return this.manifest;
  }

  async loadCritical(signal?: AbortSignal): Promise<PharosVilleAssetManifest> {
    const manifest = await this.loadManifest(signal);
    const critical = manifest.assets.filter((asset) => (
      asset.loadPriority === "critical" || manifest.requiredForFirstRender.includes(asset.id)
    ));
    await Promise.all(critical.map((asset) => this.loadAsset(asset, manifest, signal)));
    return manifest;
  }

  async loadDeferred(signal?: AbortSignal): Promise<PharosVilleAssetManifest> {
    const manifest = await this.loadManifest(signal);
    const deferred = manifest.assets.filter((asset) => asset.loadPriority === "deferred");
    await Promise.all(deferred.map((asset) => this.loadAsset(asset, manifest, signal)));
    return manifest;
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
    const image = await loadImage(assetUrl(asset, manifest), signal);
    const loaded = { entry: asset, image };
    this.assets.set(asset.id, loaded);
    return loaded;
  }
}

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
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
