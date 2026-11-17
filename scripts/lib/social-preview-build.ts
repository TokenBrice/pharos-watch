import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import sharp from "sharp";
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH, type SocialPreviewImage } from "../../shared/lib/social-preview";
import { assertSocialPreviewPng } from "../../shared/lib/social-preview-asset";
import { DARK } from "../../shared/lib/social-card/tokens";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";
import { getRouteCapabilities } from "../../src/lib/route-capabilities";
import { atomicWriteFileSync } from "./atomic-artifact-write.mts";
import { renderSvgPngWithResvg } from "./og-resvg-render.mts";
import { buildSocialCardCatalog } from "./social-card-catalog";
import { identitiesOf, loadSocialCardAssets, renderSocialCardSvg, SOCIAL_CARD_RENDER_SOURCES, validateSocialCardSpec } from "./social-card-render";

export const SOCIAL_PREVIEW_MAP_PATH = "src/generated/social-preview-images.json";
/** The rasterizer joins every drawn identity, as do the satori and resvg package versions. */
const RASTER_SOURCE = "scripts/lib/og-resvg-render.mts";
const WARN_BYTES = 300_000;
const MAX_BYTES = 500_000;

/** One canonical destination: a drawn card or an authored PNG kept as-is. */
export type SocialPreviewEntry = {
  path: string;
  /** og:title / og:description / og:image:alt: never drawn, never part of the identity. */
  copy: { title: string; description: string; alt: string };
} & ({
  /** Every drawn field and nothing else: equal drawings share one URL. */
  drawn: unknown;
  /** Repo-relative files whose bytes shape the pixels: template modules, brand mark, fonts, logos. */
  inputs: readonly string[];
  /** Cheap budget, glyph, fit and logo validation; never rasterizes. */
  validate(): void;
  /** Only rendering calls this. */
  svg(): Promise<string>;
} | {
  /** Repo-relative authored PNG under public/. */
  authored: string;
});

export interface SocialPreviewEntries {
  entries: readonly SocialPreviewEntry[];
  /** resvg rasterization inputs shared by every drawn card. */
  fonts: readonly string[];
  background: string;
}

/** Static leaves are discovered, not copied into another hand-maintained route inventory. */
export function discoverSocialPreviewPages(repoRoot: string): string[] {
  const paths = new Set<string>();
  function visit(directory: string, segments: string[]): void {
    const route = `/${segments.filter((segment) => !segment.startsWith("(")).join("/")}/`.replace(/^\/\//, "/");
    if (getRouteCapabilities(route).chrome !== "public") return;
    for (const entry of readdirSync(resolve(repoRoot, directory), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("@") && !entry.name.startsWith("_")) {
        visit(`${directory}/${entry.name}`, [...segments, entry.name]);
      } else if (entry.isFile() && entry.name === "page.tsx" && segments.every((segment) => !segment.startsWith("["))) {
        paths.add(route);
      }
    }
  }
  visit("src/app", []);
  return [...paths].sort();
}

/**
 * Adapter boundary: the catalog and renderer plug in here and nowhere else.
 * Identity, rasterization, storage and the route map never inspect a spec.
 */
export async function loadSocialPreviewEntries(repoRoot: string): Promise<SocialPreviewEntries> {
  const catalog = buildSocialCardCatalog(discoverSocialPreviewPages(repoRoot));
  const assets = await loadSocialCardAssets(repoRoot, catalog.cards);
  return {
    // Satori outlines every glyph, so resvg rasterizes without fonts; the font files join identity via the render sources.
    fonts: [],
    background: DARK.ground,
    entries: [
      ...catalog.cards.map((card): SocialPreviewEntry => {
        const { path, copy, ...drawn } = card;
        return {
          path,
          copy,
          drawn,
          inputs: [...SOCIAL_CARD_RENDER_SOURCES, ...identitiesOf(card).flatMap((identity) => identity.logoPath ? [`public${identity.logoPath}`] : [])],
          validate: () => validateSocialCardSpec(card, assets),
          svg: () => renderSocialCardSvg(card, assets),
        };
      }),
      ...catalog.authored.map(({ path, sourcePath, copy }): SocialPreviewEntry => ({ path, copy, authored: `public${sourcePath}` })),
    ],
  };
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Every preview PNG: exactly 1200×630, well formed, and inside the WhatsApp-safe size budget. */
function admitPng(bytes: Uint8Array, label: string): void {
  assertSocialPreviewPng(bytes);
  const kilobytes = Math.round(bytes.byteLength / 1000);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Social preview exceeds ${MAX_BYTES / 1000} KB: ${label} (${kilobytes} KB)`);
  if (bytes.byteLength > WARN_BYTES) console.warn(`Social preview exceeds ${WARN_BYTES / 1000} KB: ${label} (${kilobytes} KB)`);
}

/** Authored covers are palette re-encoded on admission; their URL hashes the admitted bytes. */
async function admitAuthoredPng(repoRoot: string, file: string): Promise<Buffer> {
  if (!/^public\/[\w/-]+\.png$/.test(file)) throw new Error(`Invalid authored social preview path: ${file}`);
  const bytes = await sharp(readFileSync(resolve(repoRoot, file))).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
  admitPng(bytes, file);
  return bytes;
}

/**
 * `check` validates in memory and reads no ignored output; `map` (bootstrap)
 * also writes the route map; `render` also rasterizes every current image that
 * public/og/v2 lacks. A URL hashes its inputs, so an existing file is that image.
 */
export async function buildSocialPreviewImages({ repoRoot, mode, load = loadSocialPreviewEntries }: {
  repoRoot: string; mode: "check" | "map" | "render"; load?: (repoRoot: string) => Promise<SocialPreviewEntries>;
}): Promise<{ routes: number; images: number; rendered: number }> {
  const { entries, fonts, background } = await load(repoRoot);
  const digests = new Map<string, string>();
  const hashFile = (file: string): string => {
    let digest = digests.get(file);
    if (digest === undefined) digests.set(file, digest = sha256(readFileSync(resolve(repoRoot, file))));
    return digest;
  };
  const require = createRequire(import.meta.url);
  const packages = {
    satori: (require("satori/package.json") as { version: string }).version,
    "@cf-wasm/resvg": (require("@cf-wasm/resvg/package.json") as { version: string }).version,
  };
  const images = new Map<string, { svg(): Promise<string> } | { bytes: Buffer }>();
  const map: Record<string, SocialPreviewImage> = {};
  for (const entry of entries) {
    let url: string;
    if ("authored" in entry) {
      const bytes = await admitAuthoredPng(repoRoot, entry.authored);
      url = `/og/v2/image-${sha256(bytes)}.png`;
      images.set(url, { bytes });
    } else {
      const files = [...new Set([RASTER_SOURCE, ...fonts, ...entry.inputs].map(hashFile))].sort();
      url = `/og/v2/image-${sha256(stableJsonStringifyV1({ drawn: entry.drawn, files, packages }))}.png`;
      // Each drawing is validated once (budgets, glyphs, fit, logos) without rendering.
      if (!images.has(url)) {
        entry.validate();
        images.set(url, { svg: entry.svg });
      }
    }
    map[entry.path] = { ...entry.copy, url, width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, type: "image/png" };
  }

  let rendered = 0;
  if (mode === "render") {
    const fontBuffers = fonts.map((file) => readFileSync(resolve(repoRoot, file)));
    mkdirSync(resolve(repoRoot, "public/og/v2"), { recursive: true });
    // ponytail: sequential, ~28 ms per image (42 s for 1,518 on an M-series laptop); move
    // rasterization into a worker_threads pool if CI renders approach a minute or more.
    for (const [url, image] of images) {
      const destination = resolve(repoRoot, `public${url}`);
      if (existsSync(destination)) continue;
      const bytes = "bytes" in image
        ? image.bytes
        : await renderSvgPngWithResvg({ svg: await image.svg(), fontBuffers, background, width: SOCIAL_PREVIEW_WIDTH });
      admitPng(bytes, url);
      atomicWriteFileSync(destination, bytes);
      rendered++;
    }
  }
  if (mode !== "check") {
    // A render writes the map after its images; bootstrap's map names images the Pages build renders.
    const content = `${JSON.stringify(Object.fromEntries(Object.entries(map).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`;
    const destination = resolve(repoRoot, SOCIAL_PREVIEW_MAP_PATH);
    if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
      mkdirSync(resolve(destination, ".."), { recursive: true });
      atomicWriteFileSync(destination, content);
    }
  }
  return { routes: Object.keys(map).length, images: images.size, rendered };
}
