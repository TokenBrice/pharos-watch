export type PharosVilleAssetCategory = "terrain" | "landmark" | "dock" | "ship" | "prop" | "overlay";
export type PharosVilleAssetPriority = "critical" | "deferred";

export interface PharosVilleAssetManifestEntry {
  anchor: [number, number];
  category: PharosVilleAssetCategory;
  displayScale: number;
  footprint: [number, number];
  height: number;
  hitbox: [number, number, number, number];
  id: string;
  layer: string;
  loadPriority: PharosVilleAssetPriority;
  path: string;
  promptProvenance?: {
    jobId?: string;
    seed?: number;
    styleAnchorVersion: string;
  };
  tool?: string;
  width: number;
}

export interface PharosVilleAssetManifest {
  assets: PharosVilleAssetManifestEntry[];
  requiredForFirstRender: string[];
  schemaVersion: 1;
  style: {
    anchor: string;
    assetVersion: string;
    generationDefaults: {
      detail: string;
      outline: string;
      shading: string;
      transparentBackground: boolean;
      view: string;
    };
    palette: string[];
  };
}

export const PHAROSVILLE_ASSET_MANIFEST_PATH = "/pharosville/assets/manifest.json";

export function assetUrl(asset: PharosVilleAssetManifestEntry, manifest: PharosVilleAssetManifest): string {
  return `/pharosville/assets/${asset.path}?v=${encodeURIComponent(manifest.style.assetVersion)}`;
}
