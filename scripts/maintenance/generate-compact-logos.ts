#!/usr/bin/env node
/**
 * Generate compact 32x32 WebP logo variants for oversized source logos.
 *
 * Scans public/logos/*.{png,jpg,jpeg,webp} (top-level only).
 * For each logo wider or taller than 64px AND heavier than 2500 bytes,
 * produces a 32x32 transparent-background WebP at public/logos/compact/.
 *
 * Also writes src/lib/logo-variants.generated.json mapping canonical src
 * paths to their compact counterparts. The map is consumed by logo-variants.ts.
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
}

interface CompactLogoPlan {
  variants: PlannedVariant[];
  collisions: string[];
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
  };
}

async function buildCompactLogoPlan(paths: CompactLogoPaths): Promise<CompactLogoPlan> {
  const entries = readdirSync(paths.logosDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ALLOWED_EXTS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  const variants: PlannedVariant[] = [];
  const sourceNamesByOutName = new Map<string, string[]>();

  for (const name of entries) {
    const srcPath = resolve(paths.logosDir, name);
    const stat = statSync(srcPath);

    if (stat.size <= BYTES_THRESHOLD) {
      continue;
    }

    const meta = await sharp(srcPath).metadata();
    const { width = 0, height = 0 } = meta;

    if (width <= SIZE_THRESHOLD && height <= SIZE_THRESHOLD) {
      continue;
    }

    const baseName = basename(name, extname(name));
    const outName = `${baseName}.webp`;
    variants.push({
      sourceName: name,
      outName,
      canonicalSrc: `/logos/${name}`,
      compactSrc: `/logos/compact/${outName}`,
    });
    const sources = sourceNamesByOutName.get(outName) ?? [];
    sources.push(name);
    sourceNamesByOutName.set(outName, sources);
  }

  const collisions = [...sourceNamesByOutName.entries()]
    .filter(([, sourceNames]) => sourceNames.length > 1)
    .map(([outName, sourceNames]) => sourceNames.sort().join(" + ") + ` both produce ${outName}`)
    .sort();

  return { variants, collisions };
}

function renderCompactVariant(srcPath: string): Promise<Buffer> {
  return sharp(srcPath)
    .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82 })
    .toBuffer();
}

function renderVariantMap(variants: readonly PlannedVariant[]): string {
  // Sort by key for deterministic output
  const sortedMap = Object.fromEntries(
    variants
      .map((variant) => [variant.canonicalSrc, variant.compactSrc] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
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

  mkdirSync(paths.compactDir, { recursive: true });

  let generated = 0;
  let bytesOriginal = 0;
  let bytesCompact = 0;

  for (const variant of plan.variants) {
    const srcPath = resolve(paths.logosDir, variant.sourceName);
    const outPath = resolve(paths.compactDir, variant.outName);

    const buffer = await renderCompactVariant(srcPath);
    writeFileSync(outPath, buffer);

    bytesOriginal += statSync(srcPath).size;
    bytesCompact += buffer.length;
    generated += 1;
  }

  writeFileSync(paths.mapPath, renderVariantMap(plan.variants));

  const expectedNames = new Set(plan.variants.map((variant) => variant.outName));
  const pruned = findOrphanOutputs(paths.compactDir, expectedNames);
  for (const orphan of pruned) {
    rmSync(resolve(paths.compactDir, orphan), { recursive: true });
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
  const expectedNames = new Set(plan.variants.map((variant) => variant.outName));

  for (const orphan of findOrphanOutputs(paths.compactDir, expectedNames)) {
    problems.push({
      kind: "orphan-output",
      message: `${orphan} has no qualifying source logo under ${paths.logosDir}`,
    });
  }

  for (const variant of plan.variants) {
    const outPath = resolve(paths.compactDir, variant.outName);
    if (!existsSync(outPath)) {
      problems.push({ kind: "missing-output", message: `${variant.outName} is missing` });
      continue;
    }
    const expected = await renderCompactVariant(resolve(paths.logosDir, variant.sourceName));
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
