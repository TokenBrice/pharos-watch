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
}

export class PharosVilleAssetManager {
  private assets = new Map<string, LoadedPharosVilleAsset>();
  private logos = new Map<string, LoadedPharosVilleLogo>();
  private manifest: PharosVilleAssetManifest | null = null;

  get(id: string): LoadedPharosVilleAsset | null {
    return this.assets.get(id) ?? null;
  }

  getManifest(): PharosVilleAssetManifest | null {
    return this.manifest;
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
    const deferred = manifest.assets.filter((asset) => asset.loadPriority === "deferred");
    return this.loadAssetGroup(deferred, manifest, signal);
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

  async loadLogo(src: string, signal?: AbortSignal): Promise<LoadedPharosVilleLogo> {
    const cached = this.logos.get(src);
    if (cached) return cached;
    const image = await loadImage(src, signal);
    const loaded = { image, src };
    this.logos.set(src, loaded);
    return loaded;
  }

  async loadLogos(srcs: Iterable<string>, signal?: AbortSignal): Promise<LoadedPharosVilleLogo[]> {
    const uniqueSrcs = [...new Set([...srcs].filter((src) => src.startsWith("/")))];
    return Promise.all(uniqueSrcs.map((src) => this.loadLogo(src, signal)));
  }

  private async loadAssetGroup(
    assets: PharosVilleAssetManifestEntry[],
    manifest: PharosVilleAssetManifest,
    signal?: AbortSignal,
  ): Promise<PharosVilleAssetLoadResult> {
    const settled = await Promise.allSettled(assets.map((asset) => this.loadAsset(asset, manifest, signal)));
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
    return { errors, loaded, manifest };
  }
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
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
