/**
 * Scene kit logo atlas builder: packs logos into one WebP atlas plus a JSON manifest and an input signature.
 *
 * Every distinct source image becomes two square cells side by side in the same atlas row: full colour, then a
 * grayscale copy computed with the CSS `grayscale(1)` matrix (so the grey cell matches `filter: grayscale()`). Rows
 * that share identical source bytes share cells; rows without a logo are listed in the manifest `missing` list.
 * `toSceneAtlas` (`shared/lib/scene/atlas.ts`) is the client-side reader of the manifest.
 *
 * libvips WebP bytes differ across platforms, so freshness is judged on an INPUT signature (generator version,
 * cell/encoder params, resolved source bytes), never by re-encoding: the check recomputes that signature and the
 * manifest and verifies the committed WebP still hashes to the value recorded when it was written. A consumer script
 * supplies its rows (id → resolved public logo URL), its paths and {@link SceneAtlasParams}.
 */
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256HexFromBytes, sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

/** CSS Filter Effects `grayscale(1)` luminance weights (sRGB, no linearisation). */
export const CSS_GRAYSCALE_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

/** Everything about an atlas that is not its rows: recorded in the signature, so a change rotates it. */
export interface SceneAtlasParams {
  /** Repo-relative path of the generating script. */
  generatedBy: string;
  /** Bump when rendering or layout logic changes. */
  generatorVersion: number;
  /** Cell edge in device pixels. */
  cellSize: number;
  /** Transparent pixels between cells (keeps bilinear sampling and 4:2:0 chroma from bleeding across cells). */
  gutter: number;
  webp: { readonly quality: number; readonly alphaQuality: number; readonly effort: number };
  /** Hard byte budget for the WebP. */
  byteBudget: number;
  /** Public path of the WebP (the manifest's `image`). */
  image: string;
}

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
  /** Short input-signature hash; append as `?v=` to bust the image cache. */
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
 * Deterministic layout: rows sorted by id, one colour+gray cell pair per distinct (source bytes, kernel), pairs packed
 * left to right in an even column count so a pair never wraps across rows. `pixelArtLogoUrls` keep hard pixel edges
 * (nearest-neighbour) instead of lanczos3; an override that matches no row throws, so the list cannot silently drift.
 */
export function planSceneAtlas(
  rows: readonly AtlasInputRow[],
  params: Pick<SceneAtlasParams, "generatorVersion" | "cellSize" | "gutter" | "webp">,
  pixelArtLogoUrls: readonly string[] = [],
): AtlasPlan {
  const { cellSize, gutter } = params;
  // Code-unit order, not localeCompare: the layout must not depend on ICU.
  const sorted = [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const seenIds = new Set<string>();
  for (const row of sorted) {
    if (seenIds.has(row.id)) throw new Error(`Duplicate id in atlas input: ${row.id}`);
    seenIds.add(row.id);
  }

  const pixelArt = new Set(pixelArtLogoUrls);
  const usedUrls = new Set(sorted.flatMap((row) => (row.logoUrl ? [row.logoUrl] : [])));
  const staleOverrides = [...pixelArt].filter((url) => !usedUrls.has(url)).sort();
  if (staleOverrides.length > 0) {
    throw new Error(`Pixel-art logo override(s) match no atlas row: ${staleOverrides.join(", ")}`);
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
    generatorVersion: params.generatorVersion,
    cellSize,
    gutter,
    columns,
    webp: { ...params.webp },
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

export function buildSceneAtlasManifest(plan: AtlasPlan, params: Pick<SceneAtlasParams, "generatorVersion" | "image">): AtlasManifest {
  const entries: AtlasManifest["entries"] = {};
  for (const entry of plan.entries) {
    const source = plan.sources[entry.source];
    entries[entry.id] = { color: [...source.color], gray: [...source.gray] };
  }
  return {
    version: params.generatorVersion,
    revision: plan.inputSha256.slice(0, 12),
    cellSize: plan.cellSize,
    columns: plan.columns,
    rows: plan.rows,
    width: plan.width,
    height: plan.height,
    image: params.image,
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
  webp: SceneAtlasParams["webp"];
  grayscaleWeights: number[];
  inputSha256: string;
  image: AtlasImageRecord & { width: number; height: number };
  sources: { logo: string; sha256: string; kernel: AtlasKernel }[];
  entries: { id: string; logo: string }[];
  missing: string[];
}

export function buildSceneAtlasSignature(plan: AtlasPlan, image: AtlasImageRecord, params: Pick<SceneAtlasParams, "generatedBy" | "generatorVersion" | "webp">): AtlasSignature {
  return {
    generatedBy: params.generatedBy,
    generatorVersion: params.generatorVersion,
    cellSize: plan.cellSize,
    gutter: plan.gutter,
    webp: { ...params.webp },
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

/** Read and hash each row's resolved logo (a public URL under `publicDir`). A referenced file that is absent fails loudly. */
export function readSceneAtlasInputs(
  rows: readonly { id: string; logoUrl: string | undefined }[],
  publicDir: string,
): { inputs: AtlasInputRow[]; bytesByUrl: Map<string, Buffer> } {
  const bytesByUrl = new Map<string, Buffer>();
  const inputs = rows.map((row): AtlasInputRow => {
    const { logoUrl } = row;
    if (!logoUrl) return { id: row.id, logoUrl };
    let bytes = bytesByUrl.get(logoUrl);
    if (!bytes) {
      const path = resolve(publicDir, `.${logoUrl}`);
      if (!existsSync(path)) throw new Error(`Logo for ${row.id} not found: ${logoUrl}`);
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

export async function renderSceneAtlas(plan: AtlasPlan, bytesByUrl: ReadonlyMap<string, Buffer>, params: Pick<SceneAtlasParams, "webp">): Promise<Buffer> {
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
    .webp({ ...params.webp })
    .toBuffer();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Platform-stable freshness check: compares input signatures and the committed image hash, never re-encodes the WebP. */
export async function checkSceneAtlas(plan: AtlasPlan, paths: AtlasPaths, params: SceneAtlasParams): Promise<AtlasProblem[]> {
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
    const expectedSignature = serializeJson(buildSceneAtlasSignature(plan, committed.image, params));
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
      if (bytes.length > params.byteBudget) {
        problems.push({ kind: "over-budget", message: `${paths.imagePath} is ${bytes.length} B (budget ${params.byteBudget} B)` });
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

  const expectedManifest = serializeJson(buildSceneAtlasManifest(plan, params));
  if (!existsSync(paths.manifestPath) || readFileSync(paths.manifestPath, "utf8") !== expectedManifest) {
    problems.push({ kind: "stale-manifest", message: `${paths.manifestPath} does not match the planned layout` });
  }
  return problems;
}

function writeFileEnsuringDir(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export interface BuildSceneAtlasResult {
  status: "current" | "written";
  plan: AtlasPlan;
  imageBytes: number;
}

/** Plans, and unless the committed outputs are current (or `force`), renders and writes the WebP, manifest and signature. */
export async function buildSceneAtlas({
  plan,
  bytesByUrl,
  paths,
  params,
  force = false,
}: {
  plan: AtlasPlan;
  bytesByUrl: ReadonlyMap<string, Buffer>;
  paths: AtlasPaths;
  params: SceneAtlasParams;
  force?: boolean;
}): Promise<BuildSceneAtlasResult> {
  if (!force && (await checkSceneAtlas(plan, paths, params)).length === 0) {
    return { status: "current", plan, imageBytes: readFileSync(paths.imagePath).length };
  }

  const webp = await renderSceneAtlas(plan, bytesByUrl, params);
  if (webp.length > params.byteBudget) {
    throw new Error(`Logo atlas is ${webp.length} B, over the ${params.byteBudget} B budget; nothing written`);
  }
  writeFileEnsuringDir(paths.imagePath, webp);
  writeFileEnsuringDir(paths.manifestPath, serializeJson(buildSceneAtlasManifest(plan, params)));
  writeFileEnsuringDir(
    paths.signaturePath,
    serializeJson(buildSceneAtlasSignature(plan, { sha256: sha256HexFromBytes(webp), bytes: webp.length }, params)),
  );
  return { status: "written", plan, imageBytes: webp.length };
}
