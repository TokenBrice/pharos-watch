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
 * It also writes the static social-card instances under
 * `worker/assets/fonts/social-card/` (see SOCIAL_CARD_JOBS).
 *
 * Modes:
 *   (default)      regenerate the woff2 files and the social-card TTFs in place
 *   --social-card  regenerate only the social-card TTFs (byte-deterministic)
 *   --check        structural verification: each committed woff2 exists, parses
 *                  as a valid font via fontTools, and preserves the expected
 *                  variable axes (Newsreader: wght 200..800 + opsz). Byte-for-
 *                  byte determinism is not feasible because pyftsubset's woff2
 *                  compressor is non-deterministic across runs.
 *
 * Requires `pyftsubset` (fonttools) on PATH for the default mode. `--check`
 * and `--social-card` require Python with fontTools (and brotli, to read
 * woff2 sources) importable as `python3`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const SRC_DIR = resolve(REPO_ROOT, "src/assets/fonts");
const ORIGINALS_DIR = resolve(SRC_DIR, "originals");
const ALLOWLIST_PATH = resolve(REPO_ROOT, "data/fonts/glyphs-allowlist.txt");

const CHECK_MODE = process.argv.includes("--check");
const SOCIAL_CARD_ONLY = process.argv.includes("--social-card");

const SOCIAL_CARD_DIR = resolve(REPO_ROOT, "worker/assets/fonts/social-card");
/**
 * Satori and resvg render variable fonts at their default instance and cannot
 * read woff2, so social cards use static TTF instances of the site's own faces.
 * Mono drops `calt` so code ligatures never fuse tickers such as "USD0++".
 */
const SOCIAL_CARD_JOBS = [
  { source: "BricolageGrotesque-Variable.woff2", axes: { wght: 800 }, family: "Bricolage Grotesque 96pt", style: "ExtraBold", output: "BricolageGrotesque-800.ttf" },
  { source: "BricolageGrotesque-Variable.woff2", axes: { wght: 600 }, family: "Bricolage Grotesque 96pt", style: "SemiBold", output: "BricolageGrotesque-600.ttf" },
  { source: "BricolageGrotesque-Variable.woff2", axes: { wght: 400 }, family: "Bricolage Grotesque 96pt", style: "Regular", output: "BricolageGrotesque-400.ttf" },
  { source: "JetBrainsMono-Variable.woff2", axes: { wght: 500 }, family: "JetBrains Mono", style: "Medium", output: "JetBrainsMono-500.ttf", dropFeatures: ["calt"] },
  { source: "JetBrainsMono-Variable.woff2", axes: { wght: 700 }, family: "JetBrains Mono", style: "Bold", output: "JetBrainsMono-700.ttf", dropFeatures: ["calt"] },
  { source: "originals/Newsreader-Variable.ttf", axes: { wght: 500, opsz: 72 }, family: "Newsreader 72pt", style: "Medium", output: "Newsreader-72pt-500.ttf" },
  { source: "originals/Newsreader-Italic-Variable.ttf", axes: { wght: 400, opsz: 72 }, family: "Newsreader 72pt", style: "Italic", output: "Newsreader-72pt-Italic-400.ttf" },
];
/** The drawable range; keep it equal to SOCIAL_CARD_TEXT in shared/lib/social-card/tokens.ts. */
const SOCIAL_CARD_UNICODES = "U+0020-007E,U+00A0-00FF,U+2013,U+2018,U+2019,U+201C,U+201D,U+2026,U+20AC";
// Pinned instance, subset and name records with source timestamps, so a rerun is byte-identical.
const SOCIAL_CARD_PYTHON = `
import json, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
unicodes = subset.parse_unicodes(sys.argv[2])
for job in json.loads(sys.argv[1]):
    font = TTFont(job["source"], recalcTimestamp=False)
    font.flavor = None
    font = instancer.instantiateVariableFont(font, job["axes"])
    features = {r.FeatureTag for t in ("GSUB", "GPOS") if t in font for r in font[t].table.FeatureList.FeatureRecord}
    options = subset.Options(layout_features=sorted(features - set(job.get("dropFeatures", []))), name_IDs=["*"],
                             hinting=False, notdef_outline=True, recalc_timestamp=False)
    options.drop_tables += ["DSIG", "STAT", "gasp"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    family, style = job["family"], job["style"]
    ribbi = style in ("Regular", "Italic", "Bold")
    postscript = f"{family}-{style}".replace(" ", "")
    names = {1: family if ribbi else f"{family} {style}", 2: style if ribbi else "Regular", 3: postscript, 4: f"{family} {style}", 6: postscript}
    if not ribbi:
        names.update({16: family, 17: style})
    for name_id in (1, 2, 3, 4, 6, 16, 17, 25):
        font["name"].removeNames(nameID=name_id)
    for name_id, value in names.items():
        font["name"].setName(value, name_id, 3, 1, 0x409)
    font.save(job["output"])
    print(f"  {job['output']}: {len(font.getGlyphOrder())} glyphs")
`;

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

function buildSocialCardInstances() {
  mkdirSync(SOCIAL_CARD_DIR, { recursive: true });
  const jobs = SOCIAL_CARD_JOBS.map((job) => ({
    ...job,
    source: join(SRC_DIR, job.source),
    output: join(SOCIAL_CARD_DIR, job.output),
  }));
  const result = spawnSync("python3", ["-c", SOCIAL_CARD_PYTHON, JSON.stringify(jobs), SOCIAL_CARD_UNICODES], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (result.status !== 0) {
    console.error(
      `[subset-fonts] social-card instancing failed (needs python3 with fontTools and brotli):\n${result.stderr?.toString() ?? ""}`,
    );
    process.exit(1);
  }
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

  if (!SOCIAL_CARD_ONLY) {
    ensureBinary("pyftsubset");
    regenerate(SRC_DIR);
    reportSizes(SRC_DIR, ORIGINALS_DIR, "regenerated woff2");
  }
  console.log("\n[subset-fonts] social-card instances:");
  buildSocialCardInstances();
}

main();
