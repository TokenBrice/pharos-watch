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
 * Manual invocation only — not wired into the build chain. Re-run when
 * the template or the methodology version pin changes.
 *
 *   node scripts/maintenance/build-og-editorial.mjs
 */
import { firefox } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING = resolve(REPO_ROOT, "agents/og-editorial-staging");

mkdirSync(STAGING, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });

// Read the canonical methodology version label so the version pin always
// matches what the rest of the app renders.
const safetyScoreData = readFileSync(
  resolve(REPO_ROOT, "shared/lib/methodology-versions/safety-score-data.ts"),
  "utf-8",
);
const versionMatch = safetyScoreData.match(/currentVersion:\s*"([0-9.]+)"/);
if (!versionMatch) {
  throw new Error("Could not extract currentVersion from safety-score-data.ts");
}
const METHODOLOGY_LABEL = `Methodology v${versionMatch[1]}`;

const CARDS = [
  { kicker: "Daily Digest", title: "Daily Digest", file: "og-editorial-digest.png" },
  { kicker: "Depeg Briefing", title: "Depeg Briefing", file: "og-editorial-depeg.png" },
  { kicker: "Methodology", title: "How Pharos grades the peg", file: "og-editorial-methodology.png" },
  { kicker: "Cemetery", title: "A record of failure", file: "og-editorial-cemetery.png" },
  { kicker: "About", title: "About Pharos", file: "og-editorial-about.png" },
  { kicker: "Learn", title: "Stablecoin mechanisms", file: "og-editorial-learn.png" },
  { kicker: "Stablecoin Profile", title: "Stablecoin Profile", file: "og-editorial-profile.png" },
];

// Editorial template. Dark background matching the dashboard, no decorative
// gradient. Wordmark + version pin + kicker + title + signature line, with
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

  <!-- Dark background, matches dashboard dark mode -->
  <rect width="1200" height="628" fill="#0a0f1e"/>

  <!-- Top hairline rule -->
  <line x1="64" y1="64" x2="1136" y2="64" stroke="#E8DCC4" stroke-opacity="0.16" stroke-width="1"/>

  <!-- Pharos wordmark (top-left, Geist Mono) -->
  <text x="64" y="50"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="22" font-weight="600"
        fill="#E8DCC4"
        letter-spacing="0.16em">PHAROS</text>

  <!-- Methodology version pin (top-right, Geist Mono) -->
  <text x="1136" y="50"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="16" font-weight="400"
        fill="#8b8fa3"
        letter-spacing="0.06em"
        text-anchor="end">${escapeXml(METHODOLOGY_LABEL)}</text>

  <!-- Kicker (Geist Mono, below wordmark) -->
  <text x="64" y="220"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="20" font-weight="500"
        fill="#5ba3d9"
        letter-spacing="0.24em">${escapeXml(kicker.toUpperCase())}</text>

  <!-- Hairline below kicker -->
  <line x1="64" y1="244" x2="1136" y2="244" stroke="#E8DCC4" stroke-opacity="0.10" stroke-width="1"/>

  <!-- Page title (Newsreader serif) -->
  <text x="64" y="${titleSize > 90 ? 360 : titleSize > 80 ? 350 : 340}"
        font-family="'Newsreader', 'Newsreader Variable', Georgia, 'Times New Roman', serif"
        font-size="${titleSize}" font-weight="500"
        fill="#F5F0E6"
        letter-spacing="-0.015em">${escapeXml(title)}</text>

  <!-- Bottom hairline rule -->
  <line x1="64" y1="540" x2="1136" y2="540" stroke="#E8DCC4" stroke-opacity="0.16" stroke-width="1"/>

  <!-- Signature line (bottom-left, Geist Mono italic-feel via spacing) -->
  <text x="64" y="580"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="18" font-weight="400"
        fill="#8b8fa3"
        letter-spacing="0.04em">Watching the peg.</text>

  <!-- URL (bottom-right) -->
  <text x="1136" y="580"
        font-family="'GeistMono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="16" font-weight="400"
        fill="#8b8fa3"
        letter-spacing="0.04em"
        text-anchor="end">pharos.watch</text>
</svg>
`;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Wrap SVG in an HTML page that loads the Pharos local fonts via @font-face
// so Playwright Firefox can use the exact serif/mono the dashboard renders.
function buildHtml(svg) {
  const newsreaderUrl = pathToFileURL(
    resolve(REPO_ROOT, "src/assets/fonts/Newsreader-Variable.subset.woff2"),
  ).href;
  const geistMonoUrl = pathToFileURL(
    resolve(REPO_ROOT, "src/assets/fonts/GeistMono-Regular.woff2"),
  ).href;
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
  html, body { margin: 0; padding: 0; background: #0a0f1e; }
  svg { display: block; }
</style>
</head>
<body>${svg}</body></html>`;
}

const browser = await firefox.launch({ headless: true });
try {
  for (const card of CARDS) {
    const svg = buildSvg({ kicker: card.kicker, title: card.title });
    const svgPath = resolve(STAGING, card.file.replace(/\.png$/, ".svg"));
    const htmlPath = resolve(STAGING, card.file.replace(/\.png$/, ".html"));
    writeFileSync(svgPath, svg);
    writeFileSync(htmlPath, buildHtml(svg));

    const outPath = resolve(PUBLIC, card.file);
    const page = await browser.newPage({
      viewport: { width: 1200, height: 628 },
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
    // Allow Firefox to resolve the @font-face declarations before snapshot.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: outPath,
      omitBackground: false,
      clip: { x: 0, y: 0, width: 1200, height: 628 },
      timeout: 30000,
    });
    await page.close();
    // Clean up the staging files now that the PNG is captured.
    try {
      unlinkSync(svgPath);
      unlinkSync(htmlPath);
    } catch {
      /* swallow */
    }
    console.log(`Wrote ${outPath} (kicker: ${card.kicker})`);
  }
} finally {
  await browser.close();
}
