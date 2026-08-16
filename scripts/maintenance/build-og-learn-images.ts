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
import { MECHANISM_EXPLAINER_ENTRIES } from "../../src/lib/mechanism-explainer-registry";
import { escapeXml } from "../lib/og-svg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const CHECK_MODE = process.argv.includes("--check");

const OUT_DIR = resolve(REPO_ROOT, "agents/og-learn-staging");

function checkPublishedPngs(): void {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const entry of MECHANISM_EXPLAINER_ENTRIES) {
    const path = resolve(REPO_ROOT, "public", entry.ogFilename);
    if (!existsSync(path)) {
      missing.push(`public/${entry.ogFilename}`);
      continue;
    }
    if (statSync(path).size <= 0) {
      empty.push(`public/${entry.ogFilename}`);
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

  console.log(`Mechanism OG PNG check passed (${MECHANISM_EXPLAINER_ENTRIES.length} file(s)).`);
}

if (CHECK_MODE) {
  checkPublishedPngs();
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

// Light product-shell substitutions. var() doesn't resolve in standalone SVG.
const TOKEN_MAP: Record<string, string> = {
  "var(--card)": "#ffffff",
  "var(--border-default)": "#d9dce1",
  "var(--text-tertiary)": "#71717a",
  "var(--text-secondary)": "#52525b",
  "var(--severity-severe)": "#dc2626",
  "var(--severity-healthy)": "#15803d",
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
  inner = inner.split('fill="currentColor"').join('fill="#171719"');
  // USDC -> STBL (the placeholder symbol used on explainer pages)
  inner = inner.split("USDC").join("STBL");
  return { inner, viewBoxH: heightAttr };
}

function buildOgSvg(slug: MechanismArchetype, title: string): string {
  const { inner, viewBoxH } = extractDesktopSvg(slug);

  // Diagram placement: 1000px wide, scaled by viewBox ratio
  const diagramX = 100;
  const diagramY = 280;
  const diagramW = 1000;
  const diagramH = (diagramW * viewBoxH) / 600;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628" font-family="ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, &quot;Helvetica Neue&quot;, Arial, sans-serif">
  <rect width="1200" height="628" fill="#f8f8fa" />

  <!-- top hairline -->
  <line x1="0" y1="2" x2="1200" y2="2" stroke="#22c55e" stroke-width="4" />

  <!-- kicker -->
  <text x="100" y="120" font-size="22" font-weight="700" letter-spacing="0" fill="#0e7490">
    PHAROS · MECHANISM EXPLAINER
  </text>

  <!-- archetype title -->
  <text x="100" y="200" font-size="56" font-weight="800" fill="#171719" letter-spacing="0">
    ${escapeXml(title)}
  </text>

  <!-- diagram, centered -->
  <svg x="${diagramX}" y="${diagramY}" width="${diagramW}" height="${diagramH}" viewBox="0 0 600 ${viewBoxH}" preserveAspectRatio="xMidYMid meet">
    ${inner}
  </svg>

  <!-- bottom row: wordmark + URL -->
  <line x1="100" y1="555" x2="1100" y2="555" stroke="#d9dce1" stroke-width="1" />
  <text x="100" y="595" font-size="20" font-weight="700" fill="#171719" letter-spacing="0">Pharos</text>
  <text x="1100" y="595" font-size="20" font-weight="500" fill="#5f6570" text-anchor="end">
    pharos.watch
  </text>
</svg>
`;
}

for (const entry of MECHANISM_EXPLAINER_ENTRIES) {
  const out = resolve(OUT_DIR, entry.ogFilename.replace(/\.png$/, ".svg"));
  writeFileSync(out, buildOgSvg(entry.slug, entry.title));
  console.log(`Wrote ${out}`);
}
