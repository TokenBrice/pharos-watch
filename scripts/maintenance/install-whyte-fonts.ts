#!/usr/bin/env node
/**
 * Extract licensed ABC Whyte Inktrap webfonts from a Dinamo order zip.
 *
 * The Dinamo license allows WOFF2 use via @font-face on the licensed domain,
 * but does not allow putting the font files in public repositories. The output
 * directory is gitignored. This stages local files only; production CSS uses
 * the tracked Bricolage face unless a future deploy provisions and enables Whyte.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const TARGET_DIR = resolve(REPO_ROOT, "public/fonts/abc-whyte-inktrap");

const FONT_ENTRIES = [
  "ABC Whyte Inktrap/ABCWhyteInktrap-Regular.woff2",
  "ABC Whyte Inktrap/ABCWhyteInktrap-RegularItalic.woff2",
  "ABC Whyte Inktrap/ABCWhyteInktrap-Medium.woff2",
  "ABC Whyte Inktrap/ABCWhyteInktrap-MediumItalic.woff2",
  "ABC Whyte Inktrap/ABCWhyteInktrap-Bold.woff2",
  "ABC Whyte Inktrap/ABCWhyteInktrap-BoldItalic.woff2",
];

function usage() {
  console.log("Usage: npm run install:whyte-fonts -- /path/to/dinamo-order.zip");
}

const [zipArg] = process.argv.slice(2);
if (!zipArg || zipArg === "--help" || zipArg === "-h") {
  usage();
  process.exit(zipArg ? 0 : 1);
}

const zipPath = resolve(process.cwd(), zipArg);
if (!existsSync(zipPath)) {
  console.error(`[install-whyte-fonts] Zip not found: ${zipPath}`);
  process.exit(1);
}

const unzipProbe = spawnSync("unzip", ["-v"], { stdio: "ignore" });
if (unzipProbe.error || unzipProbe.status === null) {
  console.error("[install-whyte-fonts] The `unzip` command is required but was not found on PATH.");
  process.exit(127);
}

mkdirSync(TARGET_DIR, { recursive: true });

for (const entry of FONT_ENTRIES) {
  const result = spawnSync("unzip", ["-p", zipPath, entry], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.length) {
    const stderr = result.stderr?.toString().trim();
    console.error(`[install-whyte-fonts] Could not extract ${entry}${stderr ? `:\n${stderr}` : ""}`);
    process.exit(1);
  }

  const outPath = resolve(TARGET_DIR, basename(entry));
  writeFileSync(outPath, result.stdout);
}

console.log(`[install-whyte-fonts] Installed ${FONT_ENTRIES.length} webfont files to ${TARGET_DIR}`);
for (const entry of FONT_ENTRIES) {
  const outPath = resolve(TARGET_DIR, basename(entry));
  console.log(`  ${basename(entry)} ${(statSync(outPath).size / 1024).toFixed(1)} KB`);
}
