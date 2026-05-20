#!/usr/bin/env node
/**
 * subset-fonts.mjs — convert tracked TTFs to woff2 and subset Newsreader.
 *
 * Output:
 *   src/assets/fonts/Geist-Regular.woff2
 *   src/assets/fonts/Geist-Bold.woff2
 *   src/assets/fonts/GeistMono-Regular.woff2
 *   src/assets/fonts/Newsreader-Variable.subset.woff2
 *   src/assets/fonts/Newsreader-Italic-Variable.subset.woff2
 *
 * Geist/GeistMono are converted format-only (no glyph subset). Newsreader is
 * subsetted against `data/fonts/glyphs-allowlist.txt` while preserving the
 * `wght 200..800` variable axis.
 *
 * Modes:
 *   (default)   regenerate the woff2 files in place
 *   --check     structural verification: each committed woff2 exists, parses
 *               as a valid font via fontTools, and preserves the expected
 *               variable axes (Newsreader: wght 200..800 + opsz). Byte-for-
 *               byte determinism is not feasible because pyftsubset's woff2
 *               compressor is non-deterministic across runs.
 *
 * Requires `pyftsubset` (fonttools) on PATH for the default mode. `--check`
 * additionally requires Python with fontTools importable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const SRC_DIR = resolve(REPO_ROOT, "src/assets/fonts");
const ORIGINALS_DIR = resolve(SRC_DIR, "originals");
const ALLOWLIST_PATH = resolve(REPO_ROOT, "data/fonts/glyphs-allowlist.txt");

const CHECK_MODE = process.argv.includes("--check");

const GEIST_JOBS = [
  { ttf: "Geist-Regular.ttf", woff2: "Geist-Regular.woff2" },
  { ttf: "Geist-Bold.ttf", woff2: "Geist-Bold.woff2" },
  { ttf: "GeistMono-Regular.ttf", woff2: "GeistMono-Regular.woff2" },
];

const NEWSREADER_JOBS = [
  { ttf: "Newsreader-Variable.ttf", woff2: "Newsreader-Variable.subset.woff2" },
  { ttf: "Newsreader-Italic-Variable.ttf", woff2: "Newsreader-Italic-Variable.subset.woff2" },
];

function ensureBinary(name) {
  const probe = spawnSync(name, ["--help"], { stdio: "ignore" });
  if (probe.error || probe.status === null) {
    console.error(
      `[subset-fonts] ${name} is required but not on PATH.\n` +
        `  Install fonttools (e.g. \`pipx install fonttools[woff]\` or system\n` +
        `  package). The committed woff2 files were produced with this tool;\n` +
        `  CI does not need it unless --check is run there.`,
    );
    process.exit(127);
  }
}

function parseAllowlistToUnicodes(path) {
  const raw = readFileSync(path, "utf8");
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    // Validate format: U+HHHH or U+HHHH-HHHH (case-insensitive hex)
    // eslint-disable-next-line security/detect-unsafe-regex
    if (!/^U\+[0-9A-Fa-f]{1,6}(-[0-9A-Fa-f]{1,6})?$/.test(trimmed)) {
      throw new Error(`[subset-fonts] Invalid allowlist entry: ${trimmed}`);
    }
    entries.push(trimmed);
  }
  if (entries.length === 0) {
    throw new Error(`[subset-fonts] Allowlist file ${path} is empty.`);
  }
  return entries.join(",");
}

function runPyftsubset(args, label) {
  const result = spawnSync("pyftsubset", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    console.error(`[subset-fonts] pyftsubset failed for ${label}:\n${stderr || stdout}`);
    process.exit(1);
  }
}

function buildConvertOnlyWoff2(ttfPath, outPath) {
  // Convert TTF to woff2 without subsetting (all glyphs retained). We pass
  // --unicodes='*' and --glyphs='*' so pyftsubset preserves the full font;
  // the conversion is then format-only.
  runPyftsubset(
    [
      ttfPath,
      `--output-file=${outPath}`,
      "--flavor=woff2",
      "--unicodes=*",
      "--glyphs=*",
      "--layout-features=*",
      "--no-hinting",
      "--no-desubroutinize",
      "--name-IDs=*",
      "--notdef-glyph",
      "--notdef-outline",
      "--recalc-bounds",
      "--recalc-timestamp=False",
    ],
    ttfPath,
  );
}

function buildNewsreaderSubsetWoff2(ttfPath, outPath, unicodesArg) {
  // Subset Newsreader against the allowlist while preserving variation axes.
  runPyftsubset(
    [
      ttfPath,
      `--output-file=${outPath}`,
      "--flavor=woff2",
      `--unicodes=${unicodesArg}`,
      "--layout-features=*",
      "--no-hinting",
      "--no-desubroutinize",
      "--name-IDs=*",
      "--notdef-glyph",
      "--notdef-outline",
      "--recalc-bounds",
      "--recalc-timestamp=False",
      // Variable-font axis preservation:
      "--retain-gids",
    ],
    ttfPath,
  );
}

function fileSize(path) {
  return statSync(path).size;
}

function regenerate(targetDir) {
  const unicodesArg = parseAllowlistToUnicodes(ALLOWLIST_PATH);

  for (const job of GEIST_JOBS) {
    const inPath = join(ORIGINALS_DIR, job.ttf);
    const outPath = join(targetDir, job.woff2);
    buildConvertOnlyWoff2(inPath, outPath);
  }

  for (const job of NEWSREADER_JOBS) {
    const inPath = join(ORIGINALS_DIR, job.ttf);
    const outPath = join(targetDir, job.woff2);
    buildNewsreaderSubsetWoff2(inPath, outPath, unicodesArg);
  }
}

function allOutputNames() {
  return [...GEIST_JOBS, ...NEWSREADER_JOBS].map((j) => j.woff2);
}

function reportSizes(targetDir, originalsDir, label) {
  let totalIn = 0;
  let totalOut = 0;
  console.log(`\n[subset-fonts] ${label}:`);
  for (const job of [...GEIST_JOBS, ...NEWSREADER_JOBS]) {
    const inSize = fileSize(join(originalsDir, job.ttf));
    const outSize = fileSize(join(targetDir, job.woff2));
    totalIn += inSize;
    totalOut += outSize;
    const pct = ((1 - outSize / inSize) * 100).toFixed(1);
    console.log(`  ${job.ttf.padEnd(36)} ${(inSize / 1024).toFixed(1)} KB  ->  ${job.woff2.padEnd(40)} ${(outSize / 1024).toFixed(1)} KB  (-${pct}%)`);
  }
  const totalPct = ((1 - totalOut / totalIn) * 100).toFixed(1);
  console.log(`  total                                ${(totalIn / 1024).toFixed(1)} KB  ->  ${(totalOut / 1024).toFixed(1)} KB  (-${totalPct}%)`);
}

function structuralCheck() {
  // Probe Python + fontTools availability. The check mode reads tables, so
  // we need `python3 -c "from fontTools.ttLib import TTFont"`.
  const probe = spawnSync(
    "python3",
    ["-c", "import fontTools.ttLib"],
    { stdio: "ignore" },
  );
  if (probe.status !== 0) {
    console.error(
      "[subset-fonts] --check requires Python with fontTools importable.",
    );
    process.exit(127);
  }

  const newsreaderNames = new Set(NEWSREADER_JOBS.map((j) => j.woff2));
  let failed = false;

  for (const name of allOutputNames()) {
    const path = join(SRC_DIR, name);
    if (!existsSync(path)) {
      console.error(`[subset-fonts] --check missing committed file: ${path}`);
      failed = true;
      continue;
    }
    // Inspect the font via fontTools and report any structural drift.
    const script = `
import json, sys
from fontTools.ttLib import TTFont
fnt = TTFont(${JSON.stringify(path)})
fvar = fnt.get("fvar")
out = {
  "tables": sorted(fnt.keys()),
  "numGlyphs": len(fnt.getGlyphOrder()),
  "axes": [
    {"tag": ax.axisTag, "min": ax.minValue, "max": ax.maxValue}
    for ax in (fvar.axes if fvar else [])
  ],
}
print(json.dumps(out))
`;
    const result = spawnSync("python3", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      console.error(
        `[subset-fonts] --check failed to parse ${name}:\n${result.stderr?.toString() ?? ""}`,
      );
      failed = true;
      continue;
    }
    const meta = JSON.parse(result.stdout.toString());

    if (!Array.isArray(meta.tables) || !meta.tables.includes("cmap")) {
      console.error(`[subset-fonts] --check ${name}: missing cmap table.`);
      failed = true;
    }

    if (newsreaderNames.has(name)) {
      // Newsreader subsets must keep the wght axis spanning 200..800.
      const wght = (meta.axes ?? []).find((a) => a.tag === "wght");
      if (!wght || wght.min > 200 || wght.max < 800) {
        console.error(
          `[subset-fonts] --check ${name}: expected wght axis 200..800, got ${JSON.stringify(wght)}.`,
        );
        failed = true;
      }
      // Must retain a non-trivial subset (sanity floor; full font is ~900
      // glyphs, the subset is ~650, anything <100 means the allowlist was
      // accidentally emptied).
      if (typeof meta.numGlyphs !== "number" || meta.numGlyphs < 100) {
        console.error(
          `[subset-fonts] --check ${name}: numGlyphs=${meta.numGlyphs}, expected >= 100.`,
        );
        failed = true;
      }
    }
  }

  if (failed) {
    console.error(
      "[subset-fonts] --check FAILED. Run `npm run subset:fonts` and re-commit.",
    );
    process.exit(1);
  }
  console.log(
    `[subset-fonts] --check OK (${allOutputNames().length} files parse + retain expected axes).`,
  );
}

function main() {
  if (CHECK_MODE) {
    structuralCheck();
    return;
  }

  ensureBinary("pyftsubset");
  regenerate(SRC_DIR);
  reportSizes(SRC_DIR, ORIGINALS_DIR, "regenerated woff2");
}

main();
