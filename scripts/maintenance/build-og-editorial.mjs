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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeXml } from "../lib/og-svg.mts";
import { runOgStaticCli, runOgStaticMain } from "../lib/og-static-runner.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING = resolve(REPO_ROOT, "agents/og-editorial-staging");
const SIGNATURE_PATH = resolve(REPO_ROOT, "scripts/maintenance/state/og-editorial-signatures.json");

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

const renderInputs = CARDS.map((card) => {
  const svg = buildSvg({ kicker: card.kicker, title: card.title });
  return {
    file: card.file,
    svg,
    signature: {
      kicker: card.kicker,
      title: card.title,
    },
  };
});
export async function main() {
  await runOgStaticCli({
    repoRoot: REPO_ROOT,
    family: "Editorial",
    generatedBy: "scripts/maintenance/build-og-editorial.mjs",
    manifestFields: { methodologyVersion: currentVersion },
    publicDir: PUBLIC,
    refreshCommand: "npm run build:og-editorial",
    roster: renderInputs,
    signaturePath: SIGNATURE_PATH,
    stagingDir: STAGING,
  });
}

runOgStaticMain(import.meta.url, main);
