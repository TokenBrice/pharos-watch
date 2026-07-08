#!/usr/bin/env node
/**
 * Generate the mechanism-explainer OG staging SVGs (`agents/og-learn-staging/`)
 * for `/learn/mechanisms/<slug>/`; the published `public/og-learn-<slug>.png`
 * files are rendered from these and committed.
 *
 * The desktop diagram SVG is rendered directly from the mechanism-diagram
 * components via `renderToStaticMarkup` (this script previously scraped the
 * markup out of a vitest snapshot, which the snapshot-test retirement in
 * 12971d83f deleted).
 *
 *   tsx scripts/maintenance/build-og-learn-images.ts
 *   tsx scripts/maintenance/build-og-learn-images.ts --check
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { mechanismDiagramFor } from "../../src/components/stablecoin-detail/mechanism-diagrams";
import type { MechanismArchetype } from "@shared/types";
import { escapeXml } from "../lib/og-svg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const CHECK_MODE = process.argv.includes("--check");

const OUT_DIR = resolve(REPO_ROOT, "agents/og-learn-staging");

const SLUGS: MechanismArchetype[] = [
  "fiat-cash",
  "tbill",
  "cdp",
  "synthetic-delta-neutral",
  "algorithmic",
  "rwa-credit-fund",
];

const TITLES: Record<string, string> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins, Explained",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
  "rwa-credit-fund": "Tokenized Credit Fund Stablecoins, Explained",
};

function checkPublishedPngs(): void {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const slug of SLUGS) {
    const path = resolve(REPO_ROOT, "public", `og-learn-${slug}.png`);
    if (!existsSync(path)) {
      missing.push(`public/og-learn-${slug}.png`);
      continue;
    }
    if (statSync(path).size <= 0) {
      empty.push(`public/og-learn-${slug}.png`);
    }
  }

  if (missing.length > 0 || empty.length > 0) {
    if (missing.length > 0) {
      console.error(`Missing mechanism OG PNG(s): ${missing.join(", ")}`);
    }
    if (empty.length > 0) {
      console.error(`Empty mechanism OG PNG(s): ${empty.join(", ")}`);
    }
    process.exit(1);
  }

  console.log(`Mechanism OG PNG check passed (${SLUGS.length} file(s)).`);
}

if (CHECK_MODE) {
  checkPublishedPngs();
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

// Dark-mode token substitutions. var() doesn't resolve in standalone SVG;
// inline literal oklch() colors keep the dark-mode appearance.
const TOKEN_MAP: Record<string, string> = {
  "var(--card)": "oklch(0.140 0.010 260)",
  "var(--border-default)": "oklch(1 0 0 / 0.18)",
  "var(--text-tertiary)": "oklch(0.708 0 0)",
  "var(--text-secondary)": "oklch(0.85 0.005 260)",
  "var(--severity-severe)": "oklch(0.704 0.191 22)",
  "var(--severity-healthy)": "oklch(0.690 0.180 155)",
};

function extractDesktopSvg(slug: MechanismArchetype): { inner: string; viewBoxH: number } {
  // Same render call the retired snapshot test used: USDC as the sample
  // symbol (substituted to STBL below), no wrapper/override options.
  const node = mechanismDiagramFor(slug, "USDC");
  if (node == null) throw new Error(`No diagram rendered for ${slug}`);
  const html = renderToStaticMarkup(node);
  // Pull just the first <svg ...>...</svg> (the hidden sm:block desktop variant)
  const svgMatch = html.match(/<svg[^>]*viewBox="0 0 600 (\d+)"[^>]*>(.*?)<\/svg>/s);
  if (!svgMatch) throw new Error(`Desktop SVG not found for ${slug}`);
  const heightAttr = Number.parseInt(svgMatch[1], 10);
  let inner = svgMatch[2];
  // Substitute tokens
  for (const [k, v] of Object.entries(TOKEN_MAP)) {
    inner = inner.split(k).join(v);
  }
  // Substitute currentColor with white (label fill)
  inner = inner.split('fill="currentColor"').join('fill="#f5f5f7"');
  // USDC -> STBL (the placeholder symbol used on explainer pages)
  inner = inner.split("USDC").join("STBL");
  return { inner, viewBoxH: heightAttr };
}

function buildOgSvg(slug: MechanismArchetype): string {
  const { inner, viewBoxH } = extractDesktopSvg(slug);
  const title = TITLES[slug];

  // Diagram placement: 1000px wide, scaled by viewBox ratio
  const diagramX = 100;
  const diagramY = 280;
  const diagramW = 1000;
  const diagramH = (diagramW * viewBoxH) / 600;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628" font-family="ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, &quot;Helvetica Neue&quot;, Arial, sans-serif">
  <defs>
    <radialGradient id="bg" cx="20%" cy="0%" r="120%">
      <stop offset="0%" stop-color="oklch(0.16 0.020 248)" />
      <stop offset="60%" stop-color="oklch(0.110 0.010 260)" />
      <stop offset="100%" stop-color="oklch(0.085 0.015 260)" />
    </radialGradient>
  </defs>

  <rect width="1200" height="628" fill="url(#bg)" />

  <!-- top hairline -->
  <line x1="0" y1="0" x2="1200" y2="0" stroke="oklch(0.72 0.14 248)" stroke-opacity="0.4" stroke-width="2" />

  <!-- kicker -->
  <text x="100" y="120" font-size="22" font-weight="700" letter-spacing="4" fill="oklch(0.72 0.14 248)">
    PHAROS · MECHANISM EXPLAINER
  </text>

  <!-- archetype title -->
  <text x="100" y="200" font-size="56" font-weight="800" fill="#f5f5f7" letter-spacing="-1.5">
    ${escapeXml(title)}
  </text>

  <!-- diagram, centered -->
  <svg x="${diagramX}" y="${diagramY}" width="${diagramW}" height="${diagramH}" viewBox="0 0 600 ${viewBoxH}" preserveAspectRatio="xMidYMid meet">
    ${inner}
  </svg>

  <!-- bottom row: wordmark + URL -->
  <line x1="100" y1="555" x2="1100" y2="555" stroke="oklch(1 0 0 / 0.10)" stroke-width="1" />
  <text x="100" y="595" font-size="20" font-weight="700" fill="#f5f5f7" letter-spacing="2">PHAROS</text>
  <text x="1100" y="595" font-size="20" font-weight="500" fill="oklch(0.708 0 0)" text-anchor="end">
    pharos.watch
  </text>
</svg>
`;
}

for (const slug of SLUGS) {
  const out = resolve(OUT_DIR, `og-learn-${slug}.svg`);
  writeFileSync(out, buildOgSvg(slug));
  console.log(`Wrote ${out}`);
}
