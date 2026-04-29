import { describe, expect, it } from "vitest";
import {
  assetUrl,
  manifestCacheVersion,
  manifestStyleAnchorVersion,
  type PharosVilleAssetManifest,
  type PharosVilleAssetManifestEntry,
} from "./asset-manifest";

const baseEntry: PharosVilleAssetManifestEntry = {
  anchor: [48, 46],
  category: "dock",
  displayScale: 1,
  footprint: [42, 18],
  height: 64,
  hitbox: [8, 12, 80, 42],
  id: "dock.wooden-pier",
  layer: "docks",
  loadPriority: "critical",
  path: "docks/wooden-pier.png",
  width: 96,
};

const baseStyle = {
  anchor: "old-school 16-bit maritime isometric RPG pixel art",
  generationDefaults: {
    detail: "medium detail",
    outline: "single color outline",
    shading: "medium shading",
    transparentBackground: true,
    view: "low top-down",
  },
  palette: ["#061721", "#0d5f70", "#d3c89a", "#ffcc62"],
};

describe("PharosVille asset manifest helpers", () => {
  it("keeps v1 manifests compatible with the legacy assetVersion field", () => {
    const manifest: PharosVilleAssetManifest = {
      assets: [baseEntry],
      requiredForFirstRender: [baseEntry.id],
      schemaVersion: 1,
      style: {
        ...baseStyle,
        assetVersion: "legacy-v1",
      },
    };

    expect(manifestCacheVersion(manifest)).toBe("legacy-v1");
    expect(manifestStyleAnchorVersion(manifest)).toBe("legacy-v1");
    expect(assetUrl(baseEntry, manifest)).toBe("/pharosville/assets/docks/wooden-pier.png?v=legacy-v1");
  });

  it("separates v2 cache and style provenance versions", () => {
    const manifest: PharosVilleAssetManifest = {
      assets: [baseEntry],
      requiredForFirstRender: [baseEntry.id],
      schemaVersion: 2,
      style: {
        ...baseStyle,
        cacheVersion: "cache-v2",
        styleAnchorVersion: "style-v2",
      },
    };

    expect(manifestCacheVersion(manifest)).toBe("cache-v2");
    expect(manifestStyleAnchorVersion(manifest)).toBe("style-v2");
    expect(assetUrl(baseEntry, manifest)).toBe("/pharosville/assets/docks/wooden-pier.png?v=cache-v2");
  });

  it("models optional v2 sprite-sheet animation metadata without changing the static source", () => {
    const entry: PharosVilleAssetManifestEntry = {
      ...baseEntry,
      animation: {
        frameCount: 6,
        frameSource: "docks/wooden-pier-frames.png",
        fps: 6,
        loop: true,
        reducedMotionFrame: 0,
        spriteSheet: {
          columns: 3,
          frameHeight: 64,
          frameWidth: 96,
          rows: 2,
        },
      },
    };

    expect(entry.path).toBe("docks/wooden-pier.png");
    expect(entry.animation?.frameSource).toBe("docks/wooden-pier-frames.png");
    expect(entry.animation?.spriteSheet?.columns).toBe(3);
  });
});
