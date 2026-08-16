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
 * Manual invocation:  node --import tsx scripts/maintenance/generate-compact-logos.ts
 * Re-run whenever logos are added or replaced.
 */
import sharp from "sharp";
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const LOGOS_DIR = resolve(REPO_ROOT, "public/logos");
const COMPACT_DIR = resolve(REPO_ROOT, "public/logos/compact");
const MAP_PATH = resolve(REPO_ROOT, "src/lib/logo-variants.generated.json");

const SIZE_THRESHOLD = 64;   // px — either dimension exceeding this triggers generation
const BYTES_THRESHOLD = 2500; // bytes — file must also exceed this

mkdirSync(COMPACT_DIR, { recursive: true });

const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const entries = readdirSync(LOGOS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && ALLOWED_EXTS.has(extname(e.name).toLowerCase()))
  .map((e) => e.name);

let generated = 0;
let bytesOriginal = 0;
let bytesCompact = 0;
const map: Record<string, string> = {};

for (const name of entries) {
  const srcPath = resolve(LOGOS_DIR, name);
  const stat = statSync(srcPath);

  if (stat.size <= BYTES_THRESHOLD) continue;

  const meta = await sharp(srcPath).metadata();
  const { width = 0, height = 0 } = meta;

  if (width <= SIZE_THRESHOLD && height <= SIZE_THRESHOLD) continue;

  const baseName = basename(name, extname(name));
  const outName = `${baseName}.webp`;
  const outPath = resolve(COMPACT_DIR, outName);

  await sharp(srcPath)
    .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82 })
    .toFile(outPath);

  const compactStat = statSync(outPath);

  const canonicalSrc = `/logos/${name}`;
  const compactSrc = `/logos/compact/${outName}`;
  map[canonicalSrc] = compactSrc;

  bytesOriginal += stat.size;
  bytesCompact += compactStat.size;
  generated++;
}

// Sort map by key for deterministic output
const sortedMap = Object.fromEntries(
  Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
);

writeFileSync(MAP_PATH, JSON.stringify(sortedMap, null, 2) + "\n");

const savedKB = ((bytesOriginal - bytesCompact) / 1024).toFixed(1);
console.log(`Generated ${generated} compact variants.`);
console.log(`Total original size: ${(bytesOriginal / 1024).toFixed(1)} KB`);
console.log(`Total compact size:  ${(bytesCompact / 1024).toFixed(1)} KB`);
console.log(`Saved: ${savedKB} KB`);
console.log(`Map written to: ${MAP_PATH}`);
