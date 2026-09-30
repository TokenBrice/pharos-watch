#!/usr/bin/env node
/**
 * Pack every cemetery logo into one WebP atlas plus a JSON manifest.
 *
 * Each `CEMETERY_ENTRIES` row resolves its logo exactly as the cemetery UI
 * does (`resolveCemeteryLogoUrl`). Every distinct source image becomes two
 * square cells side by side in the same atlas row: full colour, then a
 * grayscale copy computed with the CSS `grayscale(1)` matrix so the atlas
 * matches the look of today's `filter: grayscale()` logos. Rows that share
 * identical source bytes share cells. Rows without a logo are listed in the
 * manifest `missing` list; the UI renders an initial for them.
 *
 * Outputs (registered as the `cemetery-logo-atlas` generated artifact):
 * - public/logos/atlas/cemetery-atlas.webp
 * - src/lib/cemetery-logo-atlas.generated.json (manifest consumed by src/)
 * - scripts/maintenance/state/cemetery-logo-atlas-signature.json
 *
 * libvips WebP bytes differ across platforms, so freshness is judged on an
 * INPUT signature (generator version, cell/encoder params, resolved source
 * bytes), never by re-encoding. `--check` recomputes that signature and the
 * manifest, and verifies the committed WebP still hashes to the value
 * recorded when it was written. Default mode is a no-op when the check
 * passes, so the pre-commit hook never churns the WebP on another OS;
 * `--force` re-renders anyway.
 *
 *   npm run logos:cemetery-atlas
 *   npm run logos:cemetery-atlas -- --check
 *   npm run check:generated-artifacts -- --only=cemetery-logo-atlas
 */
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CEMETERY_ENTRIES, resolveCemeteryLogoUrl } from "@shared/lib/cemetery-merged";
import { sha256HexFromBytes, sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const GENERATED_BY = "scripts/maintenance/build-cemetery-logo-atlas.ts";
const REFRESH_COMMAND = "npm run logos:cemetery-atlas";

/** Bump when rendering or layout logic changes so the signature rotates. */
export const ATLAS_GENERATOR_VERSION = 1;

/**
 * Cell edge in device pixels. The atlas serves logos drawn at ~12-40 CSS px
 * on 2x screens (24-80 device px). 48 px is native 2x for 24 CSS px and
 * sits at the median source resolution (50 px), so it keeps nearly all the
 * detail the sources have; the 40 CSS px upper end upsamples 1.67x, the same
 * factor today's 28 px logos apply to 50 px sources on 2x screens. 64 px cells
 * encode to 185-225 KB, over the 150 KB budget, for detail the sources mostly
 * do not contain.
 */
export const ATLAS_CELL_SIZE = 48;

/**
 * Transparent pixels between cells. Bilinear sampling at a cropped cell edge
 * and 4:2:0 chroma in lossy WebP both reach ~1-2 px across a boundary; the
 * gutter keeps a neighbour's colour out of every cell.
 */
export const ATLAS_CELL_GUTTER = 2;

/** Measured at 48 px: q75/a100 142 KB, q70/a80 129 KB; the lower setting leaves headroom for new rows. */
export const ATLAS_WEBP_OPTIONS = {
  quality: 70,
  alphaQuality: 80,
  effort: 6,
} as const;

/** CSS Filter Effects `grayscale(1)` luminance weights (sRGB, no linearisation). */
export const CSS_GRAYSCALE_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

/** Plan §8 budget: one atlas, at most 150 KB. */
export const ATLAS_BYTE_BUDGET = 150_000;

export const ATLAS_IMAGE_PUBLIC_PATH = "/logos/atlas/cemetery-atlas.webp";

/**
 * Pixel-art sources keep hard pixel edges (nearest-neighbour) instead of
 * being smoothed by lanczos3. Keyed by resolved logo URL; a stale entry
 * fails the build so the list cannot silently drift.
 */
export const PIXEL_ART_LOGO_URLS: readonly string[] = ["/logos/10-mim.png"];

export type AtlasKernel = "lanczos3" | "nearest";

export interface AtlasInputRow {
  id: string;
  /** Resolved public URL, or undefined when the row has no logo. */
  logoUrl: string | undefined;
  /** sha256 of the source bytes; required when `logoUrl` is set. */
  sourceSha256?: string;
}

export interface AtlasSource {
  logoUrl: string;
  sha256: string;
  kernel: AtlasKernel;
  color: readonly [number, number];
  gray: readonly [number, number];
}

export interface AtlasPlan {
  cellSize: number;
  gutter: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  sources: AtlasSource[];
  /** Sorted by id; `source` indexes `sources`. */
  entries: { id: string; logoUrl: string; source: number }[];
  missing: string[];
  inputSha256: string;
}

/** Cell origins are top-left pixel offsets; each cell is `cellSize` square. */
export interface AtlasManifest {
  version: number;
  /** Short input-signature hash; append as `?v=` to bust the /logos/ cache. */
  revision: string;
  cellSize: number;
  columns: number;
  rows: number;
  /** Atlas pixel size (cells plus gutters). */
  width: number;
  height: number;
  image: string;
  entries: Record<string, { color: [number, number]; gray: [number, number] }>;
  missing: string[];
}

export interface AtlasPaths {
  publicDir: string;
  imagePath: string;
  manifestPath: string;
  signaturePath: string;
}

export interface AtlasProblem {
  kind:
    | "missing-signature"
    | "stale-inputs"
    | "stale-signature"
    | "missing-image"
    | "image-modified"
    | "image-dimensions"
    | "over-budget"
    | "stale-manifest";
  message: string;
}

/**
 * Deterministic layout: rows sorted by id, one colour+gray cell pair per
 * distinct (source bytes, kernel), pairs packed left to right in an even
 * column count so a pair never wraps across rows.
 */
export function planCemeteryLogoAtlas(
  rows: readonly AtlasInputRow[],
  {
    cellSize = ATLAS_CELL_SIZE,
    gutter = ATLAS_CELL_GUTTER,
    pixelArtLogoUrls = PIXEL_ART_LOGO_URLS,
  }: { cellSize?: number; gutter?: number; pixelArtLogoUrls?: readonly string[] } = {},
): AtlasPlan {
  // Code-unit order, not localeCompare: the layout must not depend on ICU.
  const sorted = [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const seenIds = new Set<string>();
  for (const row of sorted) {
    if (seenIds.has(row.id)) throw new Error(`Duplicate cemetery id in atlas input: ${row.id}`);
    seenIds.add(row.id);
  }

  const pixelArt = new Set(pixelArtLogoUrls);
  const usedUrls = new Set(sorted.flatMap((row) => (row.logoUrl ? [row.logoUrl] : [])));
  const staleOverrides = [...pixelArt].filter((url) => !usedUrls.has(url)).sort();
  if (staleOverrides.length > 0) {
    throw new Error(`Pixel-art logo override(s) match no cemetery row: ${staleOverrides.join(", ")}`);
  }

  const missing: string[] = [];
  const sourceIndexByKey = new Map<string, number>();
  const pending: { logoUrl: string; sha256: string; kernel: AtlasKernel }[] = [];
  const entries: AtlasPlan["entries"] = [];

  for (const row of sorted) {
    if (!row.logoUrl) {
      missing.push(row.id);
      continue;
    }
    if (!row.sourceSha256) throw new Error(`Missing source hash for ${row.id} (${row.logoUrl})`);
    const kernel: AtlasKernel = pixelArt.has(row.logoUrl) ? "nearest" : "lanczos3";
    const key = `${row.sourceSha256}:${kernel}`;
    let source = sourceIndexByKey.get(key);
    if (source === undefined) {
      source = pending.length;
      sourceIndexByKey.set(key, source);
      pending.push({ logoUrl: row.logoUrl, sha256: row.sourceSha256, kernel });
    }
    entries.push({ id: row.id, logoUrl: row.logoUrl, source });
  }

  const cellCount = pending.length * 2;
  const columns = Math.max(2, 2 * Math.ceil(Math.sqrt(cellCount) / 2));
  const gridRows = Math.max(1, Math.ceil(cellCount / columns));
  const pitch = cellSize + gutter;
  const cellOrigin = (cell: number): readonly [number, number] => [
    (cell % columns) * pitch,
    Math.floor(cell / columns) * pitch,
  ];
  const sources: AtlasSource[] = pending.map((source, index) => ({
    ...source,
    color: cellOrigin(index * 2),
    gray: cellOrigin(index * 2 + 1),
  }));

  const inputSha256 = sha256Hex(stableJsonStringifyV1({
    generatorVersion: ATLAS_GENERATOR_VERSION,
    cellSize,
    gutter,
    columns,
    webp: { ...ATLAS_WEBP_OPTIONS },
    grayscaleWeights: [...CSS_GRAYSCALE_WEIGHTS],
    sources: pending.map((source) => ({ ...source })),
    entries: entries.map(({ id, source }) => ({ id, source })),
    missing,
  }));

  return {
    cellSize,
    gutter,
    columns,
    rows: gridRows,
    width: columns * pitch - gutter,
    height: gridRows * pitch - gutter,
    sources,
    entries,
    missing,
    inputSha256,
  };
}

export function buildAtlasManifest(plan: AtlasPlan, image = ATLAS_IMAGE_PUBLIC_PATH): AtlasManifest {
  const entries: AtlasManifest["entries"] = {};
  for (const entry of plan.entries) {
    const source = plan.sources[entry.source];
    entries[entry.id] = { color: [...source.color], gray: [...source.gray] };
  }
  return {
    version: ATLAS_GENERATOR_VERSION,
    revision: plan.inputSha256.slice(0, 12),
    cellSize: plan.cellSize,
    columns: plan.columns,
    rows: plan.rows,
    width: plan.width,
    height: plan.height,
    image,
    entries,
    missing: [...plan.missing],
  };
}

export interface AtlasImageRecord {
  sha256: string;
  bytes: number;
}

export interface AtlasSignature {
  generatedBy: string;
  generatorVersion: number;
  cellSize: number;
  gutter: number;
  webp: typeof ATLAS_WEBP_OPTIONS;
  grayscaleWeights: number[];
  inputSha256: string;
  image: AtlasImageRecord & { width: number; height: number };
  sources: { logo: string; sha256: string; kernel: AtlasKernel }[];
  entries: { id: string; logo: string }[];
  missing: string[];
}

export function buildAtlasSignature(plan: AtlasPlan, image: AtlasImageRecord): AtlasSignature {
  return {
    generatedBy: GENERATED_BY,
    generatorVersion: ATLAS_GENERATOR_VERSION,
    cellSize: plan.cellSize,
    gutter: plan.gutter,
    webp: { ...ATLAS_WEBP_OPTIONS },
    grayscaleWeights: [...CSS_GRAYSCALE_WEIGHTS],
    inputSha256: plan.inputSha256,
    image: { sha256: image.sha256, bytes: image.bytes, width: plan.width, height: plan.height },
    sources: plan.sources.map(({ logoUrl, sha256, kernel }) => ({ logo: logoUrl, sha256, kernel })),
    entries: plan.entries.map(({ id, logoUrl }) => ({ id, logo: logoUrl })),
    missing: [...plan.missing],
  };
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Apply the CSS `grayscale(1)` matrix to 8-bit RGBA pixels; alpha is untouched. */
export function toCssGrayscale(rgba: Uint8Array): Buffer {
  if (rgba.length % 4 !== 0) throw new Error("RGBA buffer length must be a multiple of 4");
  const [wr, wg, wb] = CSS_GRAYSCALE_WEIGHTS;
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const luma = Math.round(wr * rgba[i] + wg * rgba[i + 1] + wb * rgba[i + 2]);
    out[i] = luma;
    out[i + 1] = luma;
    out[i + 2] = luma;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** Read and hash each row's resolved logo. A referenced file that is absent fails loudly. */
export function readAtlasInputs(
  rows: readonly { id: string; logo?: string }[],
  publicDir: string,
): { inputs: AtlasInputRow[]; bytesByUrl: Map<string, Buffer> } {
  const bytesByUrl = new Map<string, Buffer>();
  const inputs = rows.map((row): AtlasInputRow => {
    const logoUrl = resolveCemeteryLogoUrl(row.logo);
    if (!logoUrl) return { id: row.id, logoUrl };
    let bytes = bytesByUrl.get(logoUrl);
    if (!bytes) {
      const path = resolve(publicDir, `.${logoUrl}`);
      if (!existsSync(path)) throw new Error(`Cemetery logo for ${row.id} not found: ${logoUrl}`);
      bytes = readFileSync(path);
      bytesByUrl.set(logoUrl, bytes);
    }
    return { id: row.id, logoUrl, sourceSha256: sha256HexFromBytes(bytes) };
  });
  return { inputs, bytesByUrl };
}

async function rasteriseCell(bytes: Buffer, logoUrl: string, kernel: AtlasKernel, cellSize: number): Promise<Buffer> {
  let input = sharp(bytes);
  if (logoUrl.toLowerCase().endsWith(".svg")) {
    const { width = cellSize, height = cellSize } = await sharp(bytes).metadata();
    // Rasterise vectors at twice the cell so the downscale antialiases edges.
    const density = Math.ceil((72 * 2 * cellSize) / Math.max(1, Math.min(width, height)));
    input = sharp(bytes, { density });
  }
  const { data, info } = await input
    .toColourspace("srgb")
    .ensureAlpha()
    .resize(cellSize, cellSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel })
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.width !== cellSize || info.height !== cellSize || info.channels !== 4) {
    throw new Error(`Unexpected raster for ${logoUrl}: ${info.width}x${info.height}x${info.channels}`);
  }
  return data;
}

export async function renderCemeteryLogoAtlas(plan: AtlasPlan, bytesByUrl: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const raw = { width: plan.cellSize, height: plan.cellSize, channels: 4 as const };
  const layers: OverlayOptions[] = [];
  for (const source of plan.sources) {
    const bytes = bytesByUrl.get(source.logoUrl);
    if (!bytes) throw new Error(`Missing source bytes for ${source.logoUrl}`);
    const color = await rasteriseCell(bytes, source.logoUrl, source.kernel, plan.cellSize);
    layers.push({ input: color, raw, left: source.color[0], top: source.color[1] });
    layers.push({ input: toCssGrayscale(color), raw, left: source.gray[0], top: source.gray[1] });
  }
  return sharp({
    create: { width: plan.width, height: plan.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .webp({ ...ATLAS_WEBP_OPTIONS })
    .toBuffer();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Platform-stable freshness check: compares input signatures and the
 * committed image hash, never re-encodes the WebP.
 */
export async function checkCemeteryLogoAtlas(plan: AtlasPlan, paths: AtlasPaths, image = ATLAS_IMAGE_PUBLIC_PATH): Promise<AtlasProblem[]> {
  const problems: AtlasProblem[] = [];
  const committed = existsSync(paths.signaturePath)
    ? (readJson(paths.signaturePath) as AtlasSignature | null)
    : null;

  if (!committed?.image) {
    problems.push({ kind: "missing-signature", message: `${paths.signaturePath} is missing or unreadable` });
  } else {
    if (committed.inputSha256 !== plan.inputSha256) {
      problems.push({
        kind: "stale-inputs",
        message: `input signature ${String(committed.inputSha256).slice(0, 12)} != expected ${plan.inputSha256.slice(0, 12)} (a logo, row, or generator parameter changed)`,
      });
    }
    const expectedSignature = serializeJson(buildAtlasSignature(plan, committed.image));
    if (readFileSync(paths.signaturePath, "utf8") !== expectedSignature) {
      problems.push({ kind: "stale-signature", message: `${paths.signaturePath} does not match the expected signature` });
    }

    if (!existsSync(paths.imagePath)) {
      problems.push({ kind: "missing-image", message: `${paths.imagePath} is missing` });
    } else {
      const bytes = readFileSync(paths.imagePath);
      if (sha256HexFromBytes(bytes) !== committed.image.sha256) {
        problems.push({ kind: "image-modified", message: `${paths.imagePath} does not match the hash recorded when it was generated` });
      }
      if (bytes.length > ATLAS_BYTE_BUDGET) {
        problems.push({ kind: "over-budget", message: `${paths.imagePath} is ${bytes.length} B (budget ${ATLAS_BYTE_BUDGET} B)` });
      }
      const { width, height, format } = await sharp(bytes).metadata();
      if (format !== "webp" || width !== plan.width || height !== plan.height) {
        problems.push({
          kind: "image-dimensions",
          message: `${paths.imagePath} is ${format} ${width}x${height}; expected webp ${plan.width}x${plan.height}`,
        });
      }
    }
  }

  const expectedManifest = serializeJson(buildAtlasManifest(plan, image));
  if (!existsSync(paths.manifestPath) || readFileSync(paths.manifestPath, "utf8") !== expectedManifest) {
    problems.push({ kind: "stale-manifest", message: `${paths.manifestPath} does not match the planned layout` });
  }
  return problems;
}

function writeFileEnsuringDir(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export interface BuildAtlasResult {
  status: "current" | "written";
  plan: AtlasPlan;
  imageBytes: number;
}

export async function buildCemeteryLogoAtlas({
  rows,
  paths,
  force = false,
  pixelArtLogoUrls = PIXEL_ART_LOGO_URLS,
  image = ATLAS_IMAGE_PUBLIC_PATH,
}: {
  rows: readonly { id: string; logo?: string }[];
  paths: AtlasPaths;
  force?: boolean;
  pixelArtLogoUrls?: readonly string[];
  image?: string;
}): Promise<BuildAtlasResult> {
  const { inputs, bytesByUrl } = readAtlasInputs(rows, paths.publicDir);
  const plan = planCemeteryLogoAtlas(inputs, { pixelArtLogoUrls });

  if (!force && (await checkCemeteryLogoAtlas(plan, paths, image)).length === 0) {
    return { status: "current", plan, imageBytes: readFileSync(paths.imagePath).length };
  }

  const webp = await renderCemeteryLogoAtlas(plan, bytesByUrl);
  if (webp.length > ATLAS_BYTE_BUDGET) {
    throw new Error(`Cemetery logo atlas is ${webp.length} B, over the ${ATLAS_BYTE_BUDGET} B budget; nothing written`);
  }
  writeFileEnsuringDir(paths.imagePath, webp);
  writeFileEnsuringDir(paths.manifestPath, serializeJson(buildAtlasManifest(plan, image)));
  writeFileEnsuringDir(
    paths.signaturePath,
    serializeJson(buildAtlasSignature(plan, { sha256: sha256HexFromBytes(webp), bytes: webp.length })),
  );
  return { status: "written", plan, imageBytes: webp.length };
}

export function defaultAtlasPaths(): AtlasPaths {
  const publicDir = resolve(REPO_ROOT, "public");
  return {
    publicDir,
    imagePath: resolve(publicDir, `.${ATLAS_IMAGE_PUBLIC_PATH}`),
    manifestPath: resolve(REPO_ROOT, "src/lib/cemetery-logo-atlas.generated.json"),
    signaturePath: resolve(REPO_ROOT, "scripts/maintenance/state/cemetery-logo-atlas-signature.json"),
  };
}

const USAGE = `Usage: node --import tsx scripts/maintenance/build-cemetery-logo-atlas.ts [--check | --force]

  --check  Verify the committed atlas, manifest and signature against current inputs (no writes).
  --force  Re-render even when the committed outputs are current.`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { check: { type: "boolean" }, force: { type: "boolean" } },
    conflicts: [["check", "force"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const paths = defaultAtlasPaths();

  if (values.check === true) {
    const { inputs } = readAtlasInputs(CEMETERY_ENTRIES, paths.publicDir);
    const plan = planCemeteryLogoAtlas(inputs);
    const problems = await checkCemeteryLogoAtlas(plan, paths);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[cemetery-logo-atlas] ${problem.kind}: ${problem.message}`);
      throw new Error(`Cemetery logo atlas is stale (${problems.length} problem(s)). Run \`${REFRESH_COMMAND}\`.`);
    }
    console.log(`Cemetery logo atlas is current (${plan.entries.length} rows, ${plan.sources.length} distinct logos, ${plan.missing.length} missing).`);
    return;
  }

  const result = await buildCemeteryLogoAtlas({ rows: CEMETERY_ENTRIES, paths, force: values.force === true });
  const { plan } = result;
  console.log(
    `${result.status === "current" ? "Cemetery logo atlas already current" : "Wrote cemetery logo atlas"}: `
      + `${plan.width}x${plan.height} (${plan.columns}x${plan.rows} cells of ${plan.cellSize} px), `
      + `${result.imageBytes} B, ${plan.entries.length} rows, ${plan.sources.length} distinct logos, `
      + `missing: ${plan.missing.join(", ") || "none"}`,
  );
}

runDirectCli(import.meta.url, main, { label: "build-cemetery-logo-atlas", usage: USAGE });
