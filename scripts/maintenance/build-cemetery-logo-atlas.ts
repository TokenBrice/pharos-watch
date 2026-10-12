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
 * The packing, rendering and freshness logic is the scene kit's
 * (`scripts/lib/scene-atlas.ts`); this script is its cemetery configuration.
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CEMETERY_ENTRIES, resolveCemeteryLogoUrl } from "@shared/lib/cemetery-merged";
import {
  CSS_GRAYSCALE_WEIGHTS,
  buildSceneAtlas,
  buildSceneAtlasManifest,
  buildSceneAtlasSignature,
  checkSceneAtlas,
  planSceneAtlas,
  readSceneAtlasInputs,
  renderSceneAtlas,
  serializeJson,
  toCssGrayscale,
  type AtlasImageRecord,
  type AtlasInputRow,
  type AtlasKernel,
  type AtlasManifest,
  type AtlasPaths,
  type AtlasPlan,
  type AtlasProblem,
  type AtlasSignature,
  type AtlasSource,
  type BuildSceneAtlasResult,
  type SceneAtlasParams,
} from "../lib/scene-atlas";
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

/** Plan §8 budget: one atlas, at most 150 KB. */
export const ATLAS_BYTE_BUDGET = 150_000;

export const ATLAS_IMAGE_PUBLIC_PATH = "/logos/atlas/cemetery-atlas.webp";

/**
 * Pixel-art sources keep hard pixel edges (nearest-neighbour) instead of
 * being smoothed by lanczos3. Keyed by resolved logo URL; a stale entry
 * fails the build so the list cannot silently drift.
 */
export const PIXEL_ART_LOGO_URLS: readonly string[] = ["/logos/10-mim.png"];

export { CSS_GRAYSCALE_WEIGHTS, serializeJson, toCssGrayscale };
export type { AtlasImageRecord, AtlasInputRow, AtlasKernel, AtlasManifest, AtlasPaths, AtlasPlan, AtlasProblem, AtlasSignature, AtlasSource };

/** The cemetery atlas's kit parameters, with the manifest's public image path. */
function atlasParams(image = ATLAS_IMAGE_PUBLIC_PATH, cellSize = ATLAS_CELL_SIZE, gutter = ATLAS_CELL_GUTTER): SceneAtlasParams {
  return { generatedBy: GENERATED_BY, generatorVersion: ATLAS_GENERATOR_VERSION, cellSize, gutter, webp: ATLAS_WEBP_OPTIONS, byteBudget: ATLAS_BYTE_BUDGET, image };
}

/** The kit's deterministic layout (`planSceneAtlas`) with the cemetery's cell size, gutter and pixel-art overrides. */
export function planCemeteryLogoAtlas(
  rows: readonly AtlasInputRow[],
  {
    cellSize = ATLAS_CELL_SIZE,
    gutter = ATLAS_CELL_GUTTER,
    pixelArtLogoUrls = PIXEL_ART_LOGO_URLS,
  }: { cellSize?: number; gutter?: number; pixelArtLogoUrls?: readonly string[] } = {},
): AtlasPlan {
  return planSceneAtlas(rows, atlasParams(ATLAS_IMAGE_PUBLIC_PATH, cellSize, gutter), pixelArtLogoUrls);
}

export function buildAtlasManifest(plan: AtlasPlan, image = ATLAS_IMAGE_PUBLIC_PATH): AtlasManifest {
  return buildSceneAtlasManifest(plan, atlasParams(image));
}

export function buildAtlasSignature(plan: AtlasPlan, image: AtlasImageRecord): AtlasSignature {
  return buildSceneAtlasSignature(plan, image, atlasParams());
}

/** Read and hash each row's logo, resolved exactly as the cemetery UI does (`resolveCemeteryLogoUrl`). */
export function readAtlasInputs(
  rows: readonly { id: string; logo?: string }[],
  publicDir: string,
): { inputs: AtlasInputRow[]; bytesByUrl: Map<string, Buffer> } {
  return readSceneAtlasInputs(rows.map((row) => ({ id: row.id, logoUrl: resolveCemeteryLogoUrl(row.logo) })), publicDir);
}

export async function renderCemeteryLogoAtlas(plan: AtlasPlan, bytesByUrl: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  return renderSceneAtlas(plan, bytesByUrl, atlasParams());
}

/** Platform-stable freshness check (`checkSceneAtlas`): input signatures and the committed image hash. */
export async function checkCemeteryLogoAtlas(plan: AtlasPlan, paths: AtlasPaths, image = ATLAS_IMAGE_PUBLIC_PATH): Promise<AtlasProblem[]> {
  return checkSceneAtlas(plan, paths, atlasParams(image));
}

export type BuildAtlasResult = BuildSceneAtlasResult;

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
  return buildSceneAtlas({ plan, bytesByUrl, paths, params: atlasParams(image), force });
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
