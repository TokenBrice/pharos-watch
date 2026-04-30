export type PharosVilleAssetCategory = "terrain" | "landmark" | "dock" | "ship" | "prop" | "overlay";
export type PharosVilleAssetPriority = "critical" | "deferred";
export type PharosVilleAssetManifestSchemaVersion = 1 | 2;

export interface PharosVilleAssetAnimation {
  durationMs?: number;
  fps?: number;
  frameCount: number;
  frameSource: string;
  loop: boolean;
  reducedMotionFrame: number;
  spriteSheet?: {
    columns: number;
    frameHeight: number;
    frameWidth: number;
    rows: number;
  };
}

export interface PharosVilleAssetManifestEntry {
  animation?: PharosVilleAssetAnimation;
  anchor: [number, number];
  beacon?: [number, number];
  category: PharosVilleAssetCategory;
  criticalReason?: string;
  displayScale: number;
  footprint: [number, number];
  height: number;
  hitbox: [number, number, number, number];
  id: string;
  layer: string;
  loadPriority: PharosVilleAssetPriority;
  paletteKeys?: string[];
  path: string;
  promptKey?: string;
  promptProvenance?: {
    jobId?: string;
    seed?: number;
    styleAnchorVersion: string;
  };
  semanticRole?: string;
  tool?: string;
  width: number;
}

interface PharosVilleAssetManifestStyleBase {
  anchor: string;
  generationDefaults: {
    detail: string;
    outline: string;
    shading: string;
    transparentBackground: boolean;
    view: string;
  };
  palette: string[];
}

interface PharosVilleAssetManifestV1Style extends PharosVilleAssetManifestStyleBase {
  assetVersion: string;
}

interface PharosVilleAssetManifestV2Style extends PharosVilleAssetManifestStyleBase {
  cacheVersion: string;
  styleAnchorVersion: string;
}

export interface PharosVilleAssetManifestV1 {
  assets: PharosVilleAssetManifestEntry[];
  requiredForFirstRender: string[];
  schemaVersion: 1;
  style: PharosVilleAssetManifestV1Style;
}

export interface PharosVilleAssetManifestV2 {
  assets: PharosVilleAssetManifestEntry[];
  requiredForFirstRender: string[];
  schemaVersion: 2;
  style: PharosVilleAssetManifestV2Style;
}

export type PharosVilleAssetManifest = PharosVilleAssetManifestV1 | PharosVilleAssetManifestV2;

export const PHAROSVILLE_ASSET_MANIFEST_PATH = "/pharosville/assets/manifest.json";

export function manifestCacheVersion(manifest: PharosVilleAssetManifest): string {
  return manifest.schemaVersion === 2 ? manifest.style.cacheVersion : manifest.style.assetVersion;
}

export function manifestStyleAnchorVersion(manifest: PharosVilleAssetManifest): string {
  return manifest.schemaVersion === 2 ? manifest.style.styleAnchorVersion : manifest.style.assetVersion;
}

export function assetUrl(asset: PharosVilleAssetManifestEntry, manifest: PharosVilleAssetManifest): string {
  return `/pharosville/assets/${asset.path}?v=${encodeURIComponent(manifestCacheVersion(manifest))}`;
}
