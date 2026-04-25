#!/usr/bin/env node
/**
 * Enforces palette discipline for the Lighthouse isometric harbor:
 * every #RRGGBB literal in src/app/lighthouse/**.{ts,tsx} (except
 * palette.ts and test/fixture files) must be a value in HARBOR_PALETTE.
 *
 * Run via: npm run check:harbor-palette
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "tsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const paletteModule = await import("../src/app/lighthouse/systems/palette.ts");
const HARBOR_PALETTE =
  paletteModule.HARBOR_PALETTE ??
  paletteModule.default?.HARBOR_PALETTE ??
  paletteModule["module.exports"]?.HARBOR_PALETTE;
if (!HARBOR_PALETTE) {
  console.error("FATAL: Could not import HARBOR_PALETTE");
  process.exit(2);
}
const allowed = new Set(Object.values(HARBOR_PALETTE).map((h) => String(h).toLowerCase()));

const fileList = execSync(
  "git ls-files src/app/lighthouse | grep -E '\\.(ts|tsx)$' | grep -v test | grep -v __fixtures__",
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const offenders = [];
const HEX = /#[0-9a-fA-F]{6}\b/g;
let scanned = 0;
for (const f of fileList) {
  if (f.endsWith("/palette.ts")) continue;
  scanned++;
  const text = readFileSync(resolve(root, f), "utf8");
  for (const match of text.matchAll(HEX)) {
    if (!allowed.has(match[0].toLowerCase())) {
      offenders.push({ file: f, hex: match[0] });
    }
  }
}

if (offenders.length) {
  console.error("Hex literals not in HARBOR_PALETTE:");
  for (const o of offenders) console.error(`  ${o.file}: ${o.hex}`);
  process.exit(1);
}
console.log(`OK: scanned ${scanned} files, all hex literals are in HARBOR_PALETTE`);
