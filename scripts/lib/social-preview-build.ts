import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import sharp, { type Sharp } from "sharp";
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH, type SocialPreviewImage } from "../../shared/lib/social-preview";
import { assertSocialPreviewPng } from "../../shared/lib/social-preview-asset";
import type { SocialCardAssets, SocialCardLogo } from "../../shared/lib/social-card/parts";
import type { SocialCardSpec, SocialScorecardCard } from "../../shared/lib/social-card/spec";
import { createSocialCardMeasurer, type HarfBuzzApi } from "../../shared/lib/social-card/text";
import {
  DARK,
  SOCIAL_CARD_FONT_DIR,
  SOCIAL_CARD_FONTS,
  SOCIAL_CARD_LOGO_PATH,
  isTrustedLogoSvg,
  type SocialCardFace,
} from "../../shared/lib/social-card/tokens";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";
import { getRouteCapabilities } from "../../src/lib/route-capabilities";
import { atomicWriteFileSync } from "./atomic-artifact-write.mts";
import { renderSvgPngWithResvg } from "./og-resvg-render.mts";
import { buildSocialCardCatalog } from "./social-card-catalog";
import {
  identitiesOf,
  loadSocialCardAssets,
  renderSocialCardSvg,
  SOCIAL_CARD_RENDER_SOURCES,
  validateSocialCardSpec,
  type SocialCardRenderAssets,
} from "./social-card-render";

export const SOCIAL_PREVIEW_MAP_PATH = "src/generated/social-preview-images.json";
/** The rasterizer joins every drawn identity, as do the satori and resvg package versions. */
const RASTER_SOURCE = "scripts/lib/og-resvg-render.mts";
const WARN_BYTES = 300_000;
const MAX_BYTES = 500_000;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const VALIDATION_LOGO_PLACEHOLDER = "validation-only:logo";
const FONT_FACES = Object.keys(SOCIAL_CARD_FONTS) as SocialCardFace[];

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

export interface SocialPreviewCardTask {
  url: string;
  spec: SocialCardSpec;
}

export interface SocialPreviewWorkerPayload {
  repoRoot: string;
  background: string;
  fontBuffersByFace: readonly Uint8Array[];
  resvgFontBuffers: readonly Uint8Array[];
  logos: readonly (readonly [string, SocialCardLogo])[];
  tasks: readonly SocialPreviewCardTask[];
}

export interface SocialPreviewWorkerResult {
  rendered: number;
  warnings: { url: string; message: string }[];
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

/** A dark mark whose rim is mostly transparent has no disc of its own and would vanish on the dark plate. */
async function needsLightPlate(source: Sharp): Promise<boolean> {
  const { data } = await source
    .resize(64, 64, { fit: "contain", background: TRANSPARENT })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let rim = 0;
  let rimOpaque = 0;
  let opaque = 0;
  let luminance = 0;
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const distance = Math.hypot(x - 31.5, y - 31.5);
      if (distance > 31) continue;
      const index = (y * 64 + x) * 4;
      const solid = data[index + 3] > 127;
      if (distance > 27) {
        rim += 1;
        if (solid) rimOpaque += 1;
      }
      if (solid) {
        opaque += 1;
        luminance += (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
      }
    }
  }
  return opaque > 0 && rimOpaque / rim < 0.5 && luminance / opaque < 0.5;
}

/**
 * Validates one registered logo (path grammar, bytes present, SVG admission,
 * sharp decode and 64x64 light-plate analysis) without encoding 384x384 PNGs.
 * Lives outside scripts/lib/social-card-render.ts so card URL hashes stay stable.
 */
async function validateLogoWithoutPngBuffers(repoRoot: string, path: string, grey: boolean): Promise<SocialCardLogo> {
  const match = SOCIAL_CARD_LOGO_PATH.exec(path);
  if (!match) throw new Error(`Social card logo must be a registered local image: ${path}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(repoRoot, `public${path}`));
  } catch (cause) {
    throw new Error(`Social card logo bytes are missing: public${path}`, { cause });
  }
  const isSvg = match[1].toLowerCase() === "svg";
  if (isSvg && !isTrustedLogoSvg(bytes.toString("utf8"))) {
    throw new Error(`Social card logo has an external or executable resource: ${path}`);
  }
  try {
    const lightPlate = await needsLightPlate(sharp(bytes, isSvg ? { density: 288 } : {}).rotate());
    const logo: SocialCardLogo = lightPlate
      ? { color: VALIDATION_LOGO_PLACEHOLDER, lightPlate }
      : { color: VALIDATION_LOGO_PLACEHOLDER };
    return grey ? { ...logo, grey: VALIDATION_LOGO_PLACEHOLDER } : logo;
  } catch (cause) {
    throw new Error(`Social card logo could not be decoded: ${path}`, { cause });
  }
}

function collectLogoSpecs(specs: readonly (SocialCardSpec | SocialScorecardCard)[]): {
  paths: string[];
  greyPaths: Set<string>;
} {
  const greyPaths = new Set(
    specs.flatMap((spec) =>
      "template" in spec && spec.template === "dossier" && spec.lifecycle === "historical" && spec.identity.logoPath
        ? [spec.identity.logoPath]
        : [],
    ),
  );
  const paths = [
    ...new Set(specs.flatMap((spec) => identitiesOf(spec).flatMap((identity) => (identity.logoPath ? [identity.logoPath] : [])))),
  ].sort();
  return { paths, greyPaths };
}

/**
 * Loads HarfBuzz metrics and validates every referenced logo (including
 * `needsLightPlate` and SVG admission) without encoding 384x384 PNG buffers.
 */
export async function loadSocialCardValidationAssets(
  repoRoot: string,
  specs: readonly (SocialCardSpec | SocialScorecardCard)[],
): Promise<SocialCardAssets> {
  const bytes = Object.fromEntries(
    FONT_FACES.map((face) => [face, readFileSync(resolve(repoRoot, SOCIAL_CARD_FONT_DIR, SOCIAL_CARD_FONTS[face].file))]),
  ) as Record<SocialCardFace, Buffer>;
  const hb = await (createRequire(import.meta.url)("harfbuzzjs") as Promise<HarfBuzzApi>);
  const { paths, greyPaths } = collectLogoSpecs(specs);
  const logos = new Map(await Promise.all(paths.map(async (path) => [path, await validateLogoWithoutPngBuffers(repoRoot, path, greyPaths.has(path))] as const)));
  return { measure: createSocialCardMeasurer(hb, bytes), logos };
}

/**
 * Loads full PNG logo buffers only for `renderSpecs` while validating all
 * remaining logos in `allSpecs` without encoding PNGs — every logo is decoded at most once.
 */
async function loadDefaultSocialCardAssets(
  repoRoot: string,
  allSpecs: readonly SocialCardSpec[],
  renderSpecs: readonly SocialCardSpec[],
): Promise<{ renderAssets: SocialCardRenderAssets | null; validationAssets: SocialCardAssets }> {
  if (renderSpecs.length === 0) {
    return {
      renderAssets: null,
      validationAssets: await loadSocialCardValidationAssets(repoRoot, allSpecs),
    };
  }
  const { paths: allPaths, greyPaths: allGreyPaths } = collectLogoSpecs(allSpecs);
  const { paths: renderPaths } = collectLogoSpecs(renderSpecs);
  const renderPathSet = new Set(renderPaths);
  const validationOnlyPaths = allPaths.filter((path) => !renderPathSet.has(path));

  const [renderAssets, validationOnlyEntries] = await Promise.all([
    loadSocialCardAssets(repoRoot, renderSpecs),
    Promise.all(
      validationOnlyPaths.map(async (path) => [path, await validateLogoWithoutPngBuffers(repoRoot, path, allGreyPaths.has(path))] as const),
    ),
  ]);

  const validationLogos = new Map<string, SocialCardLogo>(validationOnlyEntries);
  for (const [path, logo] of renderAssets.logos) {
    validationLogos.set(
      path,
      allGreyPaths.has(path) && !logo.grey ? { ...logo, grey: VALIDATION_LOGO_PLACEHOLDER } : logo,
    );
  }
  return {
    renderAssets,
    validationAssets: { measure: renderAssets.measure, logos: validationLogos },
  };
}

/**
 * Adapter boundary: the catalog and renderer plug in here and nowhere else.
 * Identity, rasterization, storage and the route map never inspect a spec.
 */
export async function loadSocialPreviewEntries(
  repoRoot: string,
  { includePngBuffers = true }: { includePngBuffers?: boolean } = {},
): Promise<SocialPreviewEntries> {
  const catalog = buildSocialCardCatalog(discoverSocialPreviewPages(repoRoot));
  const renderAssets = includePngBuffers ? await loadSocialCardAssets(repoRoot, catalog.cards) : null;
  const assets: SocialCardAssets = renderAssets ?? await loadSocialCardValidationAssets(repoRoot, catalog.cards);
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
          svg: () => {
            if (!renderAssets) {
              throw new Error(`Cannot render social card SVG for ${card.path}: logo PNG buffers were not loaded (includePngBuffers: false)`);
            }
            return renderSocialCardSvg(card, renderAssets);
          },
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
function admitPng(bytes: Uint8Array, label: string, onWarn: (message: string) => void = console.warn): void {
  assertSocialPreviewPng(bytes);
  const kilobytes = Math.round(bytes.byteLength / 1000);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Social preview exceeds ${MAX_BYTES / 1000} KB: ${label} (${kilobytes} KB)`);
  if (bytes.byteLength > WARN_BYTES) onWarn(`Social preview exceeds ${WARN_BYTES / 1000} KB: ${label} (${kilobytes} KB)`);
}

/** Authored covers are palette re-encoded on admission; their URL hashes the admitted bytes. */
async function admitAuthoredPng(
  repoRoot: string,
  file: string,
  onWarn: (message: string) => void = console.warn,
): Promise<Buffer> {
  if (!/^public\/[\w/-]+\.png$/.test(file)) throw new Error(`Invalid authored social preview path: ${file}`);
  const bytes = await sharp(readFileSync(resolve(repoRoot, file))).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
  admitPng(bytes, file, onWarn);
  return bytes;
}

function buildWorkerRenderAssets(
  hb: HarfBuzzApi,
  fontBuffersByFace: readonly Uint8Array[],
  logos: readonly (readonly [string, SocialCardLogo])[],
): SocialCardRenderAssets {
  if (fontBuffersByFace.length !== FONT_FACES.length) {
    throw new Error(`Expected ${FONT_FACES.length} social card font buffers, received ${fontBuffersByFace.length}`);
  }
  const bytesByFace = Object.fromEntries(
    FONT_FACES.map((face, index) => {
      const raw = fontBuffersByFace[index]!;
      return [face, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)];
    }),
  ) as Record<SocialCardFace, Buffer>;
  return {
    measure: createSocialCardMeasurer(hb, bytesByFace),
    logos: new Map(logos),
    fonts: FONT_FACES.map((face) => ({
      name: SOCIAL_CARD_FONTS[face].family,
      data: bytesByFace[face],
      weight: SOCIAL_CARD_FONTS[face].weight,
      style: SOCIAL_CARD_FONTS[face].style,
    })),
    fontBuffers: FONT_FACES.map((face) => new Uint8Array(bytesByFace[face])),
  };
}

/** Worker-thread entrypoint: renders one partition of missing drawn cards with preloaded fonts and logos. */
export async function renderSocialPreviewWorkerBatch(payload: SocialPreviewWorkerPayload): Promise<SocialPreviewWorkerResult> {
  const hb = await (createRequire(import.meta.url)("harfbuzzjs") as Promise<HarfBuzzApi>);
  const assets = buildWorkerRenderAssets(hb, payload.fontBuffersByFace, payload.logos);
  const resvgFontBuffers = payload.resvgFontBuffers.map((raw) => new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const warnings: { url: string; message: string }[] = [];
  for (const { url, spec } of payload.tasks) {
    const svg = await renderSocialCardSvg(spec, assets);
    const bytes = await renderSvgPngWithResvg({
      svg,
      fontBuffers: resvgFontBuffers,
      background: payload.background,
      width: SOCIAL_PREVIEW_WIDTH,
    });
    admitPng(bytes, url, (message) => warnings.push({ url, message }));
    atomicWriteFileSync(resolve(payload.repoRoot, `public${url}`), bytes);
  }
  return { rendered: payload.tasks.length, warnings };
}

function partitionTasksRoundRobin<T>(tasks: readonly T[], poolSize: number): T[][] {
  const partitions = Array.from({ length: poolSize }, () => [] as T[]);
  for (let index = 0; index < tasks.length; index += 1) {
    partitions[index % poolSize]!.push(tasks[index]!);
  }
  return partitions.filter((partition) => partition.length > 0);
}

/**
 * Renders missing drawn social cards in-process (when poolSize === 1) or across
 * `node:worker_threads` sharing preloaded font buffers and only the logos each
 * worker's cards reference.
 */
export async function renderSocialPreviewCards({
  repoRoot,
  tasks,
  renderAssets,
  resvgFontBuffers = [],
  background = DARK.ground,
  workerCount = Math.min(8, Math.max(1, availableParallelism())),
}: {
  repoRoot: string;
  tasks: readonly SocialPreviewCardTask[];
  renderAssets: SocialCardRenderAssets;
  resvgFontBuffers?: readonly Uint8Array[];
  background?: string;
  workerCount?: number;
}): Promise<{ rendered: number }> {
  if (tasks.length === 0) return { rendered: 0 };
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
    throw new Error(`Invalid social preview worker count: ${workerCount}`);
  }
  const poolSize = Math.min(workerCount, tasks.length);
  if (poolSize === 1) {
    const fontBuffers = [...resvgFontBuffers];
    for (const { url, spec } of tasks) {
      const bytes = await renderSvgPngWithResvg({
        svg: await renderSocialCardSvg(spec, renderAssets),
        fontBuffers,
        background,
        width: SOCIAL_PREVIEW_WIDTH,
      });
      admitPng(bytes, url);
      atomicWriteFileSync(resolve(repoRoot, `public${url}`), bytes);
    }
    return { rendered: tasks.length };
  }

  const partitions = partitionTasksRoundRobin(tasks, poolSize);
  const workers: Worker[] = [];
  try {
    const pending = partitions.map((partition) => {
      const logoPaths = new Set(
        partition.flatMap(({ spec }) => identitiesOf(spec).flatMap((identity) => (identity.logoPath ? [identity.logoPath] : []))),
      );
      const logos: [string, SocialCardLogo][] = [...logoPaths].sort().map((path) => {
        const logo = renderAssets.logos.get(path);
        if (!logo) throw new Error(`Social card logo was not preloaded for worker render: ${path}`);
        return [path, logo];
      });
      const workerData: SocialPreviewWorkerPayload = {
        repoRoot,
        background,
        fontBuffersByFace: renderAssets.fontBuffers,
        resvgFontBuffers,
        logos,
        tasks: partition,
      };
      // scripts/lib/social-preview-worker.mjs registers tsx in the worker
      // before importing this module, matching critical-css-worker.mjs.
      const worker = new Worker(new URL("./social-preview-worker.mjs", import.meta.url), { workerData });
      workers.push(worker);
      return new Promise<SocialPreviewWorkerResult>((resolveWorker, rejectWorker) => {
        let received = false;
        worker.once("message", (result: SocialPreviewWorkerResult) => {
          received = true;
          resolveWorker(result);
        });
        worker.once("error", rejectWorker);
        worker.once("messageerror", rejectWorker);
        worker.once("exit", (code) => {
          if (!received) rejectWorker(new Error(`Social preview worker exited without results (code ${code}).`));
        });
      });
    });

    const results = await Promise.all(pending);
    const warnings = results
      .flatMap((result) => result.warnings)
      .sort((left, right) => left.url.localeCompare(right.url));
    for (const warning of warnings) console.warn(warning.message);
    const rendered = results.reduce((sum, result) => sum + result.rendered, 0);
    if (rendered !== tasks.length) {
      throw new Error(`Worker render left ${tasks.length - rendered} social previews unrendered`);
    }
    return { rendered };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function matchesShard(url: string, shard?: { index: number; count: number }): boolean {
  return !shard || Number.parseInt(url.slice(-12, -4), 16) % shard.count === shard.index;
}

/**
 * `check` validates in memory and reads no ignored output; `map` (bootstrap)
 * also writes the route map; `render` also rasterizes every current image that
 * public/og/v2 lacks. A URL hashes its inputs, so an existing file is that image.
 */
export async function buildSocialPreviewImages({ repoRoot, mode, load = loadSocialPreviewEntries, shard, workers }: {
  repoRoot: string; mode: "check" | "map" | "render"; load?: (repoRoot: string) => Promise<SocialPreviewEntries>;
  /** Render only the K-th of N slices of the missing images and write no map: kept for CLI compatibility and tests. */
  shard?: { index: number; count: number };
  /** Optional worker count override for default worker_threads rendering. */
  workers?: number;
}): Promise<{ routes: number; images: number; rendered: number }> {
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

  const map: Record<string, SocialPreviewImage> = {};
  let imageCount = 0;
  let rendered = 0;

  if (load === loadSocialPreviewEntries) {
    const catalog = buildSocialCardCatalog(discoverSocialPreviewPages(repoRoot));
    const drawnByUrl = new Map<string, SocialCardSpec>();
    for (const card of catalog.cards) {
      const { path, copy, ...drawn } = card;
      const inputs = [...SOCIAL_CARD_RENDER_SOURCES, ...identitiesOf(card).flatMap((identity) => (identity.logoPath ? [`public${identity.logoPath}`] : []))];
      const files = [...new Set([RASTER_SOURCE, ...inputs].map(hashFile))].sort();
      const url = `/og/v2/image-${sha256(stableJsonStringifyV1({ drawn, files, packages }))}.png`;
      if (!drawnByUrl.has(url)) drawnByUrl.set(url, card);
      map[path] = { ...copy, url, width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, type: "image/png" };
    }

    const missingDrawn: SocialPreviewCardTask[] = mode === "render"
      ? [...drawnByUrl.entries()]
        .filter(([url]) => !existsSync(resolve(repoRoot, `public${url}`)) && matchesShard(url, shard))
        .map(([url, spec]) => ({ url, spec }))
      : [];

    const [authoredAdmitted, { renderAssets, validationAssets }] = await Promise.all([
      Promise.all(
        catalog.authored.map(async ({ path, sourcePath, copy }) => {
          const authored = `public${sourcePath}`;
          const warnings: string[] = [];
          const bytes = await admitAuthoredPng(repoRoot, authored, (message) => warnings.push(message));
          return { path, copy, url: `/og/v2/image-${sha256(bytes)}.png`, bytes, warnings };
        }),
      ),
      loadDefaultSocialCardAssets(repoRoot, catalog.cards, missingDrawn.map(({ spec }) => spec)),
    ]);

    // Each unique drawing is validated once (budgets, glyphs, fit, logos) without rasterizing.
    for (const card of drawnByUrl.values()) {
      validateSocialCardSpec(card, validationAssets);
    }

    const authoredByUrl = new Map<string, Buffer>();
    for (const entry of authoredAdmitted) {
      for (const message of entry.warnings) console.warn(message);
      authoredByUrl.set(entry.url, entry.bytes);
      map[entry.path] = { ...entry.copy, url: entry.url, width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, type: "image/png" };
    }
    imageCount = new Set([...drawnByUrl.keys(), ...authoredByUrl.keys()]).size;

    if (mode === "render") {
      mkdirSync(resolve(repoRoot, "public/og/v2"), { recursive: true });
      for (const [url, bytes] of authoredByUrl) {
        if (existsSync(resolve(repoRoot, `public${url}`)) || !matchesShard(url, shard)) continue;
        admitPng(bytes, url);
        atomicWriteFileSync(resolve(repoRoot, `public${url}`), bytes);
        rendered++;
      }
      if (missingDrawn.length > 0 && renderAssets) {
        const result = await renderSocialPreviewCards({
          repoRoot,
          tasks: missingDrawn,
          renderAssets,
          resvgFontBuffers: [],
          background: DARK.ground,
          workerCount: shard ? 1 : workers,
        });
        rendered += result.rendered;
      }
    }
  } else {
    const { entries, fonts, background } = await load(repoRoot);
    const uniqueAuthoredFiles = [...new Set(entries.flatMap((entry) => ("authored" in entry ? [entry.authored] : [])))];
    const admittedAuthored = new Map(
      await Promise.all(
        uniqueAuthoredFiles.map(async (file) => {
          const warnings: string[] = [];
          const bytes = await admitAuthoredPng(repoRoot, file, (message) => warnings.push(message));
          return [file, { bytes, warnings }] as const;
        }),
      ),
    );

    const images = new Map<string, { svg(): Promise<string> } | { bytes: Buffer }>();
    for (const entry of entries) {
      let url: string;
      if ("authored" in entry) {
        const admitted = admittedAuthored.get(entry.authored)!;
        for (const message of admitted.warnings) console.warn(message);
        url = `/og/v2/image-${sha256(admitted.bytes)}.png`;
        images.set(url, { bytes: admitted.bytes });
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
    imageCount = images.size;

    if (mode === "render") {
      const fontBuffers = fonts.map((file) => readFileSync(resolve(repoRoot, file)));
      mkdirSync(resolve(repoRoot, "public/og/v2"), { recursive: true });
      // Slices follow the URL's content hash, so they stay stable whatever a sibling already wrote.
      const missing = [...images].filter(([url]) => !existsSync(resolve(repoRoot, `public${url}`)) && matchesShard(url, shard));
      for (const [url, image] of missing) {
        const bytes = "bytes" in image
          ? image.bytes
          : await renderSvgPngWithResvg({ svg: await image.svg(), fontBuffers, background, width: SOCIAL_PREVIEW_WIDTH });
        admitPng(bytes, url);
        atomicWriteFileSync(resolve(repoRoot, `public${url}`), bytes);
        rendered++;
      }
    }
  }

  if (mode !== "check" && !shard) {
    // A render writes the map after its images; bootstrap's map names images the Pages build renders.
    const content = `${JSON.stringify(Object.fromEntries(Object.entries(map).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`;
    const destination = resolve(repoRoot, SOCIAL_PREVIEW_MAP_PATH);
    if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
      mkdirSync(resolve(destination, ".."), { recursive: true });
      atomicWriteFileSync(destination, content);
    }
  }
  return { routes: Object.keys(map).length, images: imageCount, rendered };
}
