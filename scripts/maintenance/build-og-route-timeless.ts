#!/usr/bin/env node
/**
 * Generate the timeless route share cards (`public/og-*.png` listed in
 * `OG_ROUTE_CARDS`, shared/lib/og-route-cards.ts).
 *
 * A timeless card names the route and its promise and carries no figure, date
 * or state claim, so it stays true however long a platform caches it. Live
 * routes select the Worker card `/api/og/page/:slug` and use the same copy when
 * that card fails closed; every other route selects its timeless card directly.
 * The filenames are the retired screenshot roster's, so inbound links keep
 * resolving.
 *
 * Renders SVG → PNG via Playwright Firefox through the shared static runner,
 * with the Geist faces the Worker cards use.
 *
 *   node --import tsx scripts/maintenance/build-og-route-timeless.ts
 *   node --import tsx scripts/maintenance/build-og-route-timeless.ts --check
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Coins } from "lucide-react";
import { NAV_ITEMS } from "../../src/lib/nav-config";
import {
  OG_ROUTE_CARDS,
  OG_ROUTE_CARD_COLORS as C,
  OG_ROUTE_CARD_LAYOUT as L,
  ogRouteCardHost,
  type OgRouteCardKey,
} from "../../shared/lib/og-route-cards";
import type { OgRouteGlyphElement } from "../../shared/lib/og-route-glyphs";
import { escapeXml } from "../lib/og-svg.mts";
import { writeFileIfChanged } from "../lib/og-image-checks.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { runOgStaticCli } from "../lib/og-static-runner.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING = resolve(REPO_ROOT, "agents/og-route-timeless-staging");
const SIGNATURE_PATH = resolve(REPO_ROOT, "scripts/maintenance/state/og-route-timeless-signatures.json");
const FONTS = resolve(REPO_ROOT, "src/assets/fonts");
const SANS = "'Geist Sans', 'Geist', system-ui, sans-serif";
const MONO = "'Geist Mono', 'GeistMono', ui-monospace, monospace";

function svgAttributes(raw: string, context: string): Record<string, string> {
  const attrs = [...raw.matchAll(/ ([\w-]+)="([^"&]*)"/g)];
  if (attrs.map(([attr]) => attr).join("") !== raw) {
    throw new Error(`Unsupported SVG attributes for ${context}`);
  }
  return Object.fromEntries(attrs.map(([, name, value]) => [name, value]));
}

function buildRouteGlyphs(): Readonly<Record<OgRouteCardKey, readonly OgRouteGlyphElement[]>> {
  const glyphs = {} as Record<OgRouteCardKey, readonly OgRouteGlyphElement[]>;
  for (const key of Object.keys(OG_ROUTE_CARDS) as OgRouteCardKey[]) {
    const card = OG_ROUTE_CARDS[key];
    // Stablecoins is no longer a navigation destination; Lucide still owns its art.
    const icon = key === "stablecoins" ? Coins : NAV_ITEMS.find((item) => item.href === card.path)?.icon;
    if (!icon) throw new Error(`Missing navigation icon for OG route ${key}`);
    const body = renderToStaticMarkup(createElement(icon)).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    const elements = [...body.matchAll(/<(path|rect|circle)([^>]*)><\/\1>/g)];
    if (elements.length === 0 || elements.map(([element]) => element).join("") !== body) {
      throw new Error(`Unsupported navigation icon geometry for OG route ${key}`);
    }
    glyphs[key] = elements.map(([, tag, attrs]) => [
      tag as OgRouteGlyphElement[0], svgAttributes(attrs, `OG route ${key}`),
    ]);
  }
  return glyphs;
}

export function syncBrandMark(check: boolean): void {
  const path = resolve(REPO_ROOT, "worker/src/lib/og-templates/shared.tsx");
  const source = readFileSync(path, "utf-8");
  const start = "// BEGIN GENERATED: pharos-mark";
  const end = "// END GENERATED: pharos-mark";
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error("Missing generated Pharos mark block");
  // Keep the Worker's existing clip structure; derive its geometry from the authored SVG.
  const svg = readFileSync(resolve(PUBLIC, "pharos-mark-on-light.svg"), "utf-8");
  const root = svg.match(/^<svg([^>]*)>/);
  const disc = svg.match(/<clipPath id="pharos-mark-disc">\s*<rect([^>]*)\/>\s*<\/clipPath>/);
  if (!root || !disc) throw new Error("Unsupported authored Pharos mark viewport or disc");
  const viewport = svgAttributes(root[1], "Pharos mark viewport");
  if (!viewport.viewBox || !viewport.fill) throw new Error("Missing authored Pharos mark viewport attributes");
  const art = svg.split("<defs>")[0];
  const paths = [...art.matchAll(/<path([^>]*)\/>/g)];
  const unsupported = art.replace(/^<svg[^>]*>/, "")
    .replace(/<g clip-path="url\(#pharos-mark-(disc|inner)\)">|<\/g>|<path[^>]*\/>/g, "").trim();
  if (paths.length === 0 || unsupported) throw new Error("Unsupported authored Pharos mark geometry");
  const element = (tag: string, attrs: string): string => {
    const props = Object.entries(svgAttributes(attrs, "Pharos mark")).map(([name, value]) =>
      `${name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}=${JSON.stringify(value)}`,
    ).join(" ");
    return `<${tag} ${props}/>`;
  };
  const block = `${start}
export function PharosMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox=${JSON.stringify(viewport.viewBox)} fill=${JSON.stringify(viewport.fill)}>
      <defs>
        <clipPath id="pharos-mark-disc">
          ${element("rect", disc[1])}
        </clipPath>
      </defs>
      <g clipPath="url(#pharos-mark-disc)">
${paths.map(([, attrs]) => `        ${element("path", attrs)}`).join("\n")}
      </g>
    </svg>
  );
}
${end}`;
  const expected = source.slice(0, startIndex) + block + source.slice(endIndex + end.length);
  if (check) {
    if (source !== expected) {
      throw new Error("OG brand mark is stale. Run `npm run build:og-route-timeless` to refresh it.");
    }
  } else {
    writeFileIfChanged(path, expected);
  }
}

const ROUTE_GLYPHS = buildRouteGlyphs();

export function syncRouteGlyphs(check: boolean): void {
  const path = resolve(REPO_ROOT, "shared/lib/og-route-glyphs.ts");
  const source = `// Generated by scripts/maintenance/build-og-route-timeless.ts from navigation icons. Do not edit.
import type { OgRouteCardKey } from "./og-route-cards";

/** One element of a 24×24 stroked icon (lucide icon-node shape, without React keys). */
export type OgRouteGlyphElement = readonly [
  tag: "path" | "rect" | "circle",
  attrs: Readonly<Record<string, string>>,
];

export const OG_ROUTE_GLYPHS: Readonly<Record<OgRouteCardKey, readonly OgRouteGlyphElement[]>> = {
${Object.entries(ROUTE_GLYPHS).map(([key, elements]) => `  ${JSON.stringify(key)}: ${JSON.stringify(elements)},`).join("\n")}
};
`;
  if (check) {
    if (readFileSync(path, "utf-8") !== source) {
      throw new Error("OG route glyphs are stale. Run `npm run build:og-route-timeless` to refresh them.");
    }
  } else {
    writeFileIfChanged(path, source);
  }
}

// The committed on-light brand mark, placed as a nested SVG so its clip paths keep their ids.
const MARK = readFileSync(resolve(PUBLIC, "pharos-mark-on-light.svg"), "utf-8")
  .trim()
  .replace(/^<svg([^>]*)>/, (_opening, attrs: string) => {
    const { viewBox, fill } = svgAttributes(attrs, "Pharos mark viewport");
    return `<svg x="${L.paddingX}" y="${L.headerTop}" width="${L.markSize}" height="${L.markSize}" viewBox="${escapeXml(viewBox)}" fill="${escapeXml(fill)}">`;
  });

function buildGlyphSvg(key: OgRouteCardKey, x: number, y: number): string {
  const elements = ROUTE_GLYPHS[key]
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")}/>`)
    .join("");
  return `<svg x="${x}" y="${y}" width="${L.glyphSize}" height="${L.glyphSize}" viewBox="0 0 24 24" fill="none" stroke="${C.textSecondary}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${elements}</svg>`;
}

export function buildRouteTimelessSvg(key: OgRouteCardKey): string {
  const card = OG_ROUTE_CARDS[key];
  const right = L.width - L.paddingX;
  const headerBaseline = L.headerTop + L.markSize / 2 + L.wordmarkSize * 0.36;
  const ruleY = L.headerTop + L.markSize + 24;
  const kickerCenter = L.kickerTop + L.glyphSize / 2;
  const kickerBaseline = kickerCenter + L.kickerSize * 0.36;
  const promiseBaseline = L.promiseTop + L.promiseSize;
  const footerBaseline = L.height - L.footerBottom;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}">
  <rect width="${L.width}" height="${L.height}" fill="${C.background}"/>
  <rect width="${L.width}" height="${L.accentBarHeight}" fill="${C.accent}"/>
  ${MARK}
  <text x="${L.paddingX + L.markSize + 12}" y="${headerBaseline}" font-family="${SANS}" font-size="${L.wordmarkSize}" font-weight="700" fill="${C.textPrimary}">Pharos</text>
  <text x="${right}" y="${headerBaseline}" font-family="${MONO}" font-size="${L.hostSize}" fill="${C.textSecondary}" text-anchor="end">pharos.watch</text>
  <line x1="${L.paddingX}" y1="${ruleY}" x2="${right}" y2="${ruleY}" stroke="${C.rule}" stroke-width="1"/>
  ${buildGlyphSvg(key, L.paddingX, L.kickerTop)}
  <text x="${L.paddingX + L.glyphSize + 12}" y="${kickerBaseline}" font-family="${SANS}" font-size="${L.kickerSize}" fill="${C.textSecondary}">${escapeXml(card.kicker)}</text>
  <text font-family="${SANS}" font-size="${L.promiseSize}" font-weight="700" fill="${C.textPrimary}">
    <tspan x="${L.paddingX}" y="${promiseBaseline}">${escapeXml(card.promise[0])}</tspan>
    <tspan x="${L.paddingX}" y="${promiseBaseline + L.promiseLineHeight}">${escapeXml(card.promise[1])}</tspan>
  </text>
  <text x="${L.paddingX}" y="${footerBaseline}" font-family="${MONO}" font-size="${L.footerSize}" fill="${C.textSecondary}">Live figures at ${escapeXml(ogRouteCardHost(card.path))}</text>
</svg>
`;
}

const roster = (Object.keys(OG_ROUTE_CARDS) as OgRouteCardKey[]).map((key) => ({
  file: OG_ROUTE_CARDS[key].file,
  svg: buildRouteTimelessSvg(key),
  signature: { key },
}));

export async function main() {
  syncRouteGlyphs(process.argv.includes("--check"));
  syncBrandMark(process.argv.includes("--check"));
  await runOgStaticCli({
    repoRoot: REPO_ROOT,
    family: "Route timeless",
    generatedBy: "scripts/maintenance/build-og-route-timeless.ts",
    publicDir: PUBLIC,
    refreshCommand: "npm run build:og-route-timeless",
    roster,
    signaturePath: SIGNATURE_PATH,
    stagingDir: STAGING,
    fonts: [
      { key: "geistSans", family: "Geist Sans", file: resolve(FONTS, "Geist-Regular.woff2"), weight: 400 },
      { key: "geistSansBold", family: "Geist Sans", file: resolve(FONTS, "Geist-Bold.woff2"), weight: 700 },
      { key: "geistMono", family: "Geist Mono", file: resolve(FONTS, "GeistMono-Regular.woff2"), weight: "400 700" },
    ],
  });
}

runDirectCli(import.meta.url, main);
