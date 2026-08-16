#!/usr/bin/env node
/**
 * Generate the unified editorial OG image template per content category.
 *
 * One PNG per kicker (Daily Digest, Depeg Briefing, Methodology, Cemetery,
 * About, Learn, Stablecoin Profile). The layout is identical across all
 * outputs; only the kicker varies. Wired by metadata in the corresponding
 * routes.
 *
 * Renders SVG → PNG via Playwright Firefox so the local Newsreader serif
 * and Geist Mono subsets render faithfully (matches the build-og-learn /
 * generate-pwa-icons skill flow).
 *
 * Re-run when the template or the methodology version pin changes. Use
 * `--check` in CI to fail when committed PNGs are stale.
 *
 *   node scripts/maintenance/build-og-editorial.mjs
 *   node scripts/maintenance/build-og-editorial.mjs --check
 */
import { firefox } from "playwright";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { escapeXml } from "../lib/og-svg.mts";
import {
  assertNoStaleOgOutputs,
  formatOgWriteStatus,
  promoteGeneratedPngIfChanged,
  stalePngCheckLabel,
  writeFileIfChanged,
} from "../lib/og-image-checks.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING = resolve(REPO_ROOT, "agents/og-editorial-staging");
const SIGNATURE_PATH = resolve(REPO_ROOT, "scripts/maintenance/state/og-editorial-signatures.json");
const NEWSREADER_FONT = resolve(REPO_ROOT, "src/assets/fonts/Newsreader-Variable.subset.woff2");
const GEIST_MONO_FONT = resolve(REPO_ROOT, "src/assets/fonts/GeistMono-Regular.woff2");
const CHECK_MODE = process.argv.includes("--check");

mkdirSync(STAGING, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });
mkdirSync(dirname(SIGNATURE_PATH), { recursive: true });

// Read the canonical methodology version label so the version pin always
// matches what the rest of the app renders. Both the TS app and this script
// consume the same current-version.json source of truth.
const { currentVersion } = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, "shared/lib/methodology-versions/current-version.json"),
    "utf-8",
  ),
);
const METHODOLOGY_LABEL = `Methodology v${currentVersion}`;
const FONT_SIGNATURES = {
  newsreader: sha256(readFileSync(NEWSREADER_FONT)),
  geistMono: sha256(readFileSync(GEIST_MONO_FONT)),
};

const CARDS = [
  { kicker: "Daily Digest", title: "Daily Digest", file: "og-editorial-digest.png" },
  { kicker: "Depeg Briefing", title: "Depeg Briefing", file: "og-editorial-depeg.png" },
  { kicker: "Methodology", title: "How Pharos grades the peg", file: "og-editorial-methodology.png" },
  { kicker: "Cemetery", title: "A record of failure", file: "og-editorial-cemetery.png" },
  { kicker: "About", title: "About Pharos", file: "og-editorial-about.png" },
  { kicker: "Learn", title: "Stablecoin mechanisms", file: "og-editorial-learn.png" },
  { kicker: "Stablecoin Profile", title: "Stablecoin Profile", file: "og-editorial-profile.png" },
];

// Editorial template matching the current light product shell. Wordmark,
// version pin, kicker, title, and signature line use the live UI palette, with
// hairline rules where they help structure.
function buildSvg({ kicker, title }) {
  // Newsreader is loaded as a local font; Playwright resolves it via @font-face
  // when the SVG is embedded in an HTML page.
  // Title font sizes scale down with length so very long titles never overflow.
  // Newsreader at 500 weight averages ~0.56 em advance — calibrated empirically
  // against the 1072px content width (1136 - 64).
  const titleLen = title.length;
  const titleSize = titleLen > 24 ? 72 : titleLen > 18 ? 88 : 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628">
  <defs>
    <style>
      text { font-kerning: normal; }
    </style>
  </defs>

  <rect width="1200" height="628" fill="#f8f8fa"/>
  <rect width="1200" height="4" fill="#22c55e"/>

  <!-- Top hairline rule -->
  <line x1="64" y1="64" x2="1136" y2="64" stroke="#d9dce1" stroke-width="1"/>

  <!-- Pharos wordmark (top-left, Geist Mono) -->
  <text x="64" y="50"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="22" font-weight="600"
        fill="#171719"
        letter-spacing="0">Pharos</text>

  <!-- Methodology version pin (top-right, Geist Mono) -->
  <text x="1136" y="50"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="16" font-weight="400"
        fill="#5f6570"
        letter-spacing="0"
        text-anchor="end">${escapeXml(METHODOLOGY_LABEL)}</text>

  <!-- Kicker (Geist Mono, below wordmark) -->
  <text x="64" y="220"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="20" font-weight="500"
        fill="#0e7490"
        letter-spacing="0">${escapeXml(kicker.toUpperCase())}</text>

  <!-- Hairline below kicker -->
  <line x1="64" y1="244" x2="1136" y2="244" stroke="#e4e7eb" stroke-width="1"/>

  <!-- Page title (Newsreader serif) -->
  <text x="64" y="${titleSize > 90 ? 360 : titleSize > 80 ? 350 : 340}"
        font-family="'Newsreader', 'Newsreader Variable', Georgia, 'Times New Roman', serif"
        font-size="${titleSize}" font-weight="500"
        fill="#171719"
        letter-spacing="0">${escapeXml(title)}</text>

  <!-- Bottom hairline rule -->
  <line x1="64" y1="540" x2="1136" y2="540" stroke="#d9dce1" stroke-width="1"/>

  <!-- Signature line (bottom-left, Geist Mono italic-feel via spacing) -->
  <text x="64" y="580"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="18" font-weight="400"
        fill="#5f6570"
        letter-spacing="0">Watching the peg.</text>

  <!-- URL (bottom-right) -->
  <text x="1136" y="580"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="16" font-weight="400"
        fill="#5f6570"
        letter-spacing="0"
        text-anchor="end">pharos.watch</text>
</svg>
`;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function buildSignatureManifest(cards) {
  return `${JSON.stringify(
    {
      generatedBy: "scripts/maintenance/build-og-editorial.mjs",
      methodologyVersion: currentVersion,
      fonts: FONT_SIGNATURES,
      cards,
    },
    null,
    2,
  )}\n`;
}

function withPublicPngSignatures(signatures) {
  return signatures.map((signature) => {
    const publicPath = resolve(PUBLIC, signature.file);
    return {
      ...signature,
      pngSha256: existsSync(publicPath) ? sha256(readFileSync(publicPath)) : null,
    };
  });
}

const renderInputs = CARDS.map((card) => {
  const svg = buildSvg({ kicker: card.kicker, title: card.title });
  return {
    card,
    svg,
    signature: {
      file: card.file,
      kicker: card.kicker,
      title: card.title,
      svgSha256: sha256(svg),
    },
  };
});
const renderInputSignatures = renderInputs.map(({ signature }) => signature);
const inputSignatureManifest = buildSignatureManifest(renderInputSignatures);
const signatureManifest = CHECK_MODE
  ? buildSignatureManifest(withPublicPngSignatures(renderInputSignatures))
  : inputSignatureManifest;

function readExistingSignatureManifest() {
  return existsSync(SIGNATURE_PATH) ? readFileSync(SIGNATURE_PATH, "utf-8") : null;
}

function stripPngSignatures(manifest) {
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(manifest);
    parsed.cards = parsed.cards.map((signature) => ({
      file: signature.file,
      kicker: signature.kicker,
      title: signature.title,
      svgSha256: signature.svgSha256,
    }));
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return null;
  }
}

function stalePngSignatureLabels(manifest) {
  if (!manifest) return CARDS.map((card) => card.file);
  try {
    return JSON.parse(manifest).cards
      .filter(
        (signature) =>
          !signature.pngSha256 ||
          signature.pngSha256 !== sha256(readFileSync(resolve(PUBLIC, signature.file))),
      )
      .map((signature) => signature.file);
  } catch {
    return CARDS.map((card) => card.file);
  }
}

function allPublicOutputsExist() {
  return CARDS.every((card) => existsSync(resolve(PUBLIC, card.file)));
}

// Wrap SVG in an HTML page that loads the Pharos local fonts via @font-face
// so Playwright Firefox can use the exact serif/mono the dashboard renders.
function buildHtml(svg) {
  const newsreaderUrl = pathToFileURL(NEWSREADER_FONT).href;
  const geistMonoUrl = pathToFileURL(GEIST_MONO_FONT).href;
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  @font-face {
    font-family: 'Newsreader';
    font-style: normal;
    font-weight: 200 800;
    src: url('${newsreaderUrl}') format('woff2');
    font-display: block;
  }
  @font-face {
    font-family: 'GeistMono';
    font-style: normal;
    font-weight: 400 700;
    src: url('${geistMonoUrl}') format('woff2');
    font-display: block;
  }
  html, body { margin: 0; padding: 0; background: #f8f8fa; }
  svg { display: block; }
</style>
</head>
<body>${svg}</body></html>`;
}

// The signature manifest fingerprints every deterministic render input and
// committed PNG. When it matches and all committed PNGs exist, --check does
// not need Firefox while still detecting hand-edited or corrupted assets.
const existingSignatureManifest = readExistingSignatureManifest();

if (CHECK_MODE && existingSignatureManifest === signatureManifest && allPublicOutputsExist()) {
  for (const card of CARDS) {
    console.log(formatOgWriteStatus({
      check: true,
      publicPath: resolve(PUBLIC, card.file),
      suffix: ` (kicker: ${card.kicker})`,
    }));
  }
  console.log("Skipped Firefox render; editorial OG signatures are current.");
  process.exit(0);
}

if (
  CHECK_MODE &&
  allPublicOutputsExist() &&
  stripPngSignatures(existingSignatureManifest) === inputSignatureManifest
) {
  assertNoStaleOgOutputs({
    family: "Editorial",
    staleFiles: stalePngSignatureLabels(existingSignatureManifest),
    refreshCommand: "npm run build:og-editorial",
  });
}

const browser = await firefox.launch({ headless: true });
const staleFiles = [];
try {
  for (const { card, svg } of renderInputs) {
    const svgPath = resolve(STAGING, card.file.replace(/\.png$/, ".svg"));
    const htmlPath = resolve(STAGING, card.file.replace(/\.png$/, ".html"));
    writeFileSync(svgPath, svg);
    writeFileSync(htmlPath, buildHtml(svg));

    const publicPath = resolve(PUBLIC, card.file);
    const outPath = resolve(
      STAGING,
      card.file.replace(/\.png$/, CHECK_MODE ? ".check.png" : `.write-${process.pid}.png`),
    );
    const page = await browser.newPage({
      viewport: { width: 1200, height: 628 },
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
    // Wait for Firefox to resolve the @font-face declarations before snapshot.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: outPath,
      omitBackground: false,
      clip: { x: 0, y: 0, width: 1200, height: 628 },
      timeout: 30000,
    });
    await page.close();

    let changed = false;
    if (CHECK_MODE) {
      const staleLabel = await stalePngCheckLabel({
        fileLabel: card.file,
        expectedPath: publicPath,
        actualPath: outPath,
      });
      if (staleLabel) {
        staleFiles.push(staleLabel);
      }
    } else {
      changed = await promoteGeneratedPngIfChanged({ stagedPath: outPath, publicPath });
    }

    // Clean up the staging files now that the PNG is captured.
    try {
      unlinkSync(svgPath);
      unlinkSync(htmlPath);
      if (CHECK_MODE) unlinkSync(outPath);
    } catch {
      /* swallow */
    }
    console.log(formatOgWriteStatus({
      check: CHECK_MODE,
      changed,
      publicPath,
      suffix: ` (kicker: ${card.kicker})`,
    }));
  }

  if (CHECK_MODE) {
    if (existingSignatureManifest !== signatureManifest) {
      staleFiles.push("scripts/maintenance/state/og-editorial-signatures.json");
    }
  } else {
    writeFileIfChanged(SIGNATURE_PATH, buildSignatureManifest(withPublicPngSignatures(renderInputSignatures)));
  }

  assertNoStaleOgOutputs({
    family: "Editorial",
    staleFiles,
    refreshCommand: "npm run build:og-editorial",
  });
} finally {
  await browser.close();
}
