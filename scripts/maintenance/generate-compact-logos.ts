#!/usr/bin/env node
/**
 * Generate 32px/100px WebP stablecoin logos and 56px/100px WebP chain icons.
 *
 * Stablecoin sources must exceed 64px and 2500 bytes; chain rasters are
 * converted regardless of source dimensions, without enlargement.
 * The generated map records each canonical source's available pixel sizes.
 *
 * Registered as the `compact-logos` generated artifact in
 * scripts/lib/automation-registry.mjs. Default mode regenerates every output,
 * prunes compact assets whose source logo is gone, and refuses basename
 * collisions (two source logos compacting to the same .webp name).
 * `--check` verifies the committed outputs byte-for-byte without writing.
 *
 * Manual invocation:  npm run logos:compact
 * Freshness check:    npm run check:generated-artifacts -- --only=compact-logos
 */
import sharp from "sharp";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const SIZE_THRESHOLD = 64;   // px — either dimension exceeding this triggers generation
const BYTES_THRESHOLD = 2500; // bytes — file must also exceed this
const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface CompactLogoPaths {
  logosDir: string;
  compactDir: string;
  mapPath: string;
  chainsDir?: string;
  compactChainsDir?: string;
}

export type CompactLogoProblemKind =
  | "collision"
  | "missing-output"
  | "stale-output"
  | "orphan-output"
  | "stale-map";

export interface CompactLogoProblem {
  kind: CompactLogoProblemKind;
  message: string;
}

export interface PlannedVariant {
  sourceName: string;
  outName: string;
  canonicalSrc: string;
  compactSrc: string;
  size: number;
  sourcePath: string;
  outputDir: string;
}

interface CompactLogoPlan {
  variants: PlannedVariant[];
  collisions: string[];
  outputDirs: string[];
}

export interface GenerateCompactLogosResult {
  ok: boolean;
  problems: CompactLogoProblem[];
  generated: number;
  pruned: string[];
  bytesOriginal: number;
  bytesCompact: number;
}

export interface CheckCompactLogosResult {
  ok: boolean;
  problems: CompactLogoProblem[];
  variantCount: number;
}

export function defaultCompactLogoPaths(): CompactLogoPaths {
  return {
    logosDir: resolve(REPO_ROOT, "public/logos"),
    compactDir: resolve(REPO_ROOT, "public/logos/compact"),
    mapPath: resolve(REPO_ROOT, "src/lib/logo-variants.generated.json"),
    chainsDir: resolve(REPO_ROOT, "public/chains"),
    compactChainsDir: resolve(REPO_ROOT, "public/chains/compact"),
  };
}

async function buildCompactLogoPlan(paths: CompactLogoPaths): Promise<CompactLogoPlan> {
  const collections = [
    { sourceDir: paths.logosDir, outputDir: paths.compactDir, prefix: "/logos", sizes: [32, 100], gated: true },
    ...(paths.chainsDir && paths.compactChainsDir
      ? [{ sourceDir: paths.chainsDir, outputDir: paths.compactChainsDir, prefix: "/chains", sizes: [56, 100], gated: false }]
      : []),
  ];

  const variants: PlannedVariant[] = [];
  const sourceNamesByOutName = new Map<string, string[]>();

  for (const collection of collections) {
    const entries = readdirSync(collection.sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ALLOWED_EXTS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
    for (const name of entries) {
      const sourcePath = resolve(collection.sourceDir, name);
      if (collection.gated) {
        if (statSync(sourcePath).size <= BYTES_THRESHOLD) continue;
        const { width = 0, height = 0 } = await sharp(sourcePath).metadata();
        if (width <= SIZE_THRESHOLD && height <= SIZE_THRESHOLD) continue;
      }
      const baseName = basename(name, extname(name));
      for (const size of collection.sizes) {
        const outName = `${baseName}${size === 100 ? "-100" : ""}.webp`;
        variants.push({
          sourceName: name,
          sourcePath,
          outputDir: collection.outputDir,
          size,
          outName,
          canonicalSrc: `${collection.prefix}/${name}`,
          compactSrc: `${collection.prefix}/compact/${outName}`,
        });
        const outputPath = resolve(collection.outputDir, outName);
        const sources = sourceNamesByOutName.get(outputPath) ?? [];
        sources.push(name);
        sourceNamesByOutName.set(outputPath, sources);
      }
    }
  }

  const collisions = [...sourceNamesByOutName.entries()]
    .filter(([, sourceNames]) => sourceNames.length > 1)
    .map(([outName, sourceNames]) => sourceNames.sort().join(" + ") + ` both produce ${outName}`)
    .sort();

  return { variants, collisions, outputDirs: collections.map((collection) => collection.outputDir) };
}

function renderCompactVariant(srcPath: string, size: number): Promise<Buffer> {
  return sharp(srcPath)
    .resize(size, size, { fit: "contain", withoutEnlargement: true, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82 })
    .toBuffer();
}

function renderVariantMap(variants: readonly PlannedVariant[]): string {
  const map: Record<string, Record<number, string>> = {};
  for (const variant of variants) {
    (map[variant.canonicalSrc] ??= {})[variant.size] = variant.compactSrc;
  }
  const sortedMap = Object.fromEntries(Object.entries(map).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify(sortedMap, null, 2)}\n`;
}

/** Compact-dir entries that no planned variant claims. Sorted for reports. */
function findOrphanOutputs(compactDir: string, expectedNames: ReadonlySet<string>): string[] {
  if (!existsSync(compactDir)) return [];
  return readdirSync(compactDir)
    .filter((name) => !expectedNames.has(name))
    .sort();
}

export async function generateCompactLogos(
  paths: CompactLogoPaths = defaultCompactLogoPaths(),
): Promise<GenerateCompactLogosResult> {
  const plan = await buildCompactLogoPlan(paths);
  const collisionProblems: CompactLogoProblem[] = plan.collisions.map((message) => ({
    kind: "collision" as const,
    message: `${message}; rename one source logo so each gets its own compact variant`,
  }));

  if (collisionProblems.length > 0) {
    return {
      ok: false,
      problems: collisionProblems,
      generated: 0,
      pruned: [],
      bytesOriginal: 0,
      bytesCompact: 0,
    };
  }

  for (const outputDir of plan.outputDirs) mkdirSync(outputDir, { recursive: true });

  let generated = 0;
  let bytesOriginal = 0;
  let bytesCompact = 0;
  const countedSources = new Set<string>();

  for (const variant of plan.variants) {
    const srcPath = variant.sourcePath;
    const outPath = resolve(variant.outputDir, variant.outName);

    const buffer = await renderCompactVariant(srcPath, variant.size);
    writeFileSync(outPath, buffer);

    if (!countedSources.has(srcPath)) {
      bytesOriginal += statSync(srcPath).size;
      countedSources.add(srcPath);
    }
    bytesCompact += buffer.length;
    generated += 1;
  }

  writeFileSync(paths.mapPath, renderVariantMap(plan.variants));

  const pruned: string[] = [];
  for (const outputDir of plan.outputDirs) {
    const expectedNames = new Set(plan.variants.filter((variant) => variant.outputDir === outputDir).map((variant) => variant.outName));
    for (const orphan of findOrphanOutputs(outputDir, expectedNames)) {
      rmSync(resolve(outputDir, orphan), { recursive: true });
      pruned.push(resolve(outputDir, orphan));
    }
  }

  return { ok: true, problems: [], generated, pruned, bytesOriginal, bytesCompact };
}

export async function checkCompactLogos(
  paths: CompactLogoPaths = defaultCompactLogoPaths(),
): Promise<CheckCompactLogosResult> {
  const plan = await buildCompactLogoPlan(paths);
  const collisionProblems: CompactLogoProblem[] = plan.collisions.map((message) => ({
    kind: "collision" as const,
    message,
  }));

  // A colliding plan makes the expected output set ambiguous; freshness of
  // individual outputs is meaningless until the source logos are renamed.
  if (collisionProblems.length > 0) {
    return { ok: false, problems: collisionProblems, variantCount: plan.variants.length };
  }

  const problems: CompactLogoProblem[] = [];
  for (const outputDir of plan.outputDirs) {
    const expectedNames = new Set(plan.variants.filter((variant) => variant.outputDir === outputDir).map((variant) => variant.outName));
    for (const orphan of findOrphanOutputs(outputDir, expectedNames)) {
      problems.push({
        kind: "orphan-output",
        message: `${resolve(outputDir, orphan)} has no qualifying source logo`,
      });
    }
  }

  for (const variant of plan.variants) {
    const outPath = resolve(variant.outputDir, variant.outName);
    if (!existsSync(outPath)) {
      problems.push({ kind: "missing-output", message: `${variant.outName} is missing` });
      continue;
    }
    const expected = await renderCompactVariant(variant.sourcePath, variant.size);
    if (!readFileSync(outPath).equals(expected)) {
      problems.push({
        kind: "stale-output",
        message: `${variant.outName} does not match a fresh render of ${variant.sourceName}`,
      });
    }
  }

  const expectedMap = renderVariantMap(plan.variants);
  if (!existsSync(paths.mapPath) || readFileSync(paths.mapPath, "utf8") !== expectedMap) {
    problems.push({
      kind: "stale-map",
      message: `${paths.mapPath} does not match the rendered variant map`,
    });
  }

  return { ok: problems.length === 0, problems, variantCount: plan.variants.length };
}

async function main(): Promise<void> {
  const paths = defaultCompactLogoPaths();

  if (process.argv.includes("--check")) {
    const result = await checkCompactLogos(paths);
    if (!result.ok) {
      for (const problem of result.problems) {
        console.error(`[compact-logos] ${problem.kind}: ${problem.message}`);
      }
      console.error(
        `Compact logos are stale (${result.problems.length} problem(s)). Run \`npm run logos:compact\`.`,
      );
      process.exit(1);
    }
    console.log(`Compact logos are current (${result.variantCount} variants).`);
    return;
  }

  const result = await generateCompactLogos(paths);
  if (!result.ok) {
    for (const problem of result.problems) {
      console.error(`[compact-logos] ${problem.kind}: ${problem.message}`);
    }
    process.exit(1);
  }

  const savedKB = ((result.bytesOriginal - result.bytesCompact) / 1024).toFixed(1);
  console.log(`Generated ${result.generated} compact variants.`);
  if (result.pruned.length > 0) {
    console.log(`Pruned ${result.pruned.length} orphaned compact asset(s): ${result.pruned.join(", ")}`);
  }
  console.log(`Total original size: ${(result.bytesOriginal / 1024).toFixed(1)} KB`);
  console.log(`Total compact size:  ${(result.bytesCompact / 1024).toFixed(1)} KB`);
  console.log(`Saved: ${savedKB} KB`);
  console.log(`Map written to: ${paths.mapPath}`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
