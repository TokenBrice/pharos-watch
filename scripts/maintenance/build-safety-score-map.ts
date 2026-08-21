/**
 * Build the shareable Safety Score map: a landscape Twitter-post-size
 * (1600x900) editorial infographic of the graded stablecoin universe.
 *
 * Composition (bubble map): every graded coin appears as its logo, sized by
 * circulating supply (area-proportional with a legibility floor), packed into
 * horizontal grade strata A-F. Size carries the economic story — the A band
 * holds the giants, the lower tiers read as shrinking gravel — and white
 * score chips label every coin large enough to name.
 *
 * This is a manual/monthly social artifact, not a committed site asset: it
 * renders from the live production API, so outputs land in the ignored
 * agents/ scratch tree with a month-stamped filename.
 *
 * Usage:
 *   npm run build:safety-score-map
 *   npm run build:safety-score-map -- --out agents/custom.png
 *
 * Inputs:
 *   - $PHAROS_API_KEY (env or .env.local): required for api.pharos.watch
 *   - $PHAROS_API_BASE: optional API origin override
 *
 * Outputs:
 *   - agents/safety-score-map/safety-score-map-YYYY-MM.png (and .svg)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { firefox } from "playwright";
import sharp from "sharp";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { getCirculatingRaw } from "@shared/lib/supply";
import { V9_GRADE_THRESHOLDS } from "@shared/types/safety-score-v9-grade";
import { escapeXml } from "../lib/og-svg.mts";
import { buildMaintenanceApiRequest, DEFAULT_MAINTENANCE_API_BASE_URL } from "../lib/maintenance-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const NEWSREADER_FONT = resolve(REPO_ROOT, "src/assets/fonts/Newsreader-Variable.subset.woff2");
const NEWSREADER_ITALIC_FONT = resolve(REPO_ROOT, "src/assets/fonts/Newsreader-Italic-Variable.subset.woff2");
const JETBRAINS_MONO_FONT = resolve(REPO_ROOT, "src/assets/fonts/JetBrainsMono-Variable.woff2");
const BRICOLAGE_FONT = resolve(REPO_ROOT, "src/assets/fonts/BricolageGrotesque-Variable.woff2");
const BRAND_MARK = resolve(REPO_ROOT, "public/pharos-mark-on-light.svg");
const LOGOS_JSON = resolve(REPO_ROOT, "data/logos.json");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const OUT_DIR = resolve(REPO_ROOT, "agents/safety-score-map");

const WIDTH = 1600;
const HEIGHT = 900;
const MARGIN_X = 64;
const CONTENT_W = WIDTH - MARGIN_X * 2;
const FOOTER_RULE_Y = 848;
const RAIL_WIDTH = 170;
const FLOW_X = MARGIN_X + RAIL_WIDTH;
const FLOW_RIGHT = WIDTH - MARGIN_X;
const FLOW_W = FLOW_RIGHT - FLOW_X;
const BODY_TOP = 192;

// Palette: editorial shell neutrals shared with the OG templates.
const INK = "#171719";
const INK_SECONDARY = "#5f6570";
const INK_TERTIARY = "#8a909b";
const HAIRLINE = "#e4e7eb";
const RULE = "#d9dce1";
const FROST_BLUE = "#4bc4de";

// Letter-tier hex tokens mirror GRADE_RADAR_COLORS in shared/lib/report-card-core.ts.
const TIER_ORDER = ["A", "B", "C", "D", "F"] as const;
type Tier = (typeof TIER_ORDER)[number];
const TIER_COLORS: Record<Tier, string> = {
  A: "#10b981",
  B: "#3b82f6",
  C: "#f59e0b",
  D: "#f97316",
  F: "#ef4444",
};
// Text twins: darker per-tier hues for letters, grades, and scores on the light
// shell (mirrors the site's light-mode amber darkening for WCAG contrast).
const TIER_TEXT_COLORS: Record<Tier, string> = {
  A: "#059669",
  B: "#2563eb",
  C: "#b45309",
  D: "#c2410c",
  F: "#dc2626",
};

// Bubble sizing: area tracks circulating supply, floored for presence. The
// largest coin anchors the scale; the fit loop shrinks it until the strata
// stack above the footer.
const R_MAX_TARGET = 150;
// Legibility floors bend strict area-proportionality for the long tail; the
// A tier floors higher so "every A is exceptional" survives at poster scale.
const R_MIN: Record<Tier, number> = { A: 14, B: 7, C: 7, D: 7, F: 7 };
const CHIP_MIN_R = 15;

interface MapCoin {
  id: string;
  symbol: string;
  grade: string;
  score: number;
  tier: Tier;
  mcap: number;
}

function parseCliArgs(argv: readonly string[]): { out: string | null } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
    },
  });
  return { out: values.out ?? null };
}

function loadApiKey(): string {
  if (!process.env.PHAROS_API_KEY) {
    const envFile = resolve(REPO_ROOT, ".env.local");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const key = process.env.PHAROS_API_KEY?.trim();
  if (!key) throw new Error("PHAROS_API_KEY not found in env or .env.local");
  return key;
}

async function fetchJson<T>(apiPath: string, apiKey: string, baseUrl: string): Promise<T> {
  const { url, headers } = buildMaintenanceApiRequest(apiPath, apiKey, baseUrl);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${apiPath} returned ${res.status}`);
  return (await res.json()) as T;
}

function formatUsdCompact(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

// JetBrains Mono advance is 0.6em; text widths are exact, not estimated.
function monoWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

// Grade-band score range projected from the methodology policy thresholds.
function tierRange(tier: Tier): string {
  const mins = V9_GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) === tier).map((t) => t.min);
  const min = Math.min(...mins);
  const higher = V9_GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) !== tier && t.min > min).map((t) => t.min);
  const max = higher.length > 0 ? Math.min(...higher) - 1 : 100;
  return `${min}–${max}`;
}

async function loadLogoDataUri(publicLogoPath: string, sizePx: number): Promise<string | null> {
  const filePath = resolve(PUBLIC_DIR, `.${publicLogoPath}`);
  if (!existsSync(filePath)) return null;
  try {
    // SVG sources rasterize at their intrinsic size unless the density is
    // raised to cover the target; probe the metadata so tiny viewBoxes
    // (e.g. a 16px USDC svg) still yield crisp 2x rasters at bubble scale.
    const meta = await sharp(filePath).metadata();
    const srcDim = Math.max(meta.width ?? 64, meta.height ?? 64);
    const density = Math.min(9600, Math.max(144, Math.ceil((72 * sizePx * 2) / srcDim)));
    const png = await sharp(filePath, { density })
      .resize(sizePx * 2, sizePx * 2, { fit: "cover" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

// --- Bubble layout --------------------------------------------------------

interface Bubble {
  coin: MapCoin;
  cx: number;
  cy: number;
  r: number;
}

interface BandLayout {
  tier: Tier;
  y: number;
  height: number;
  bubbles: Bubble[];
  totalCount: number;
  totalMcap: number;
  flowInset: number; // horizontal centering offset (A stratum only)
}

interface TierGaps {
  colGap: number;
  vGap: number;
  padTop: number;
  padBottom: number;
}

// The A stratum breathes (room for chips below its tail bubbles); lower
// strata pack tighter as the gravel shrinks.
const TIER_GAPS: Record<Tier, TierGaps> = {
  A: { colGap: 42, vGap: 26, padTop: 16, padBottom: 26 },
  B: { colGap: 10, vGap: 8, padTop: 20, padBottom: 20 },
  C: { colGap: 8, vGap: 7, padTop: 18, padBottom: 18 },
  D: { colGap: 7, vGap: 6, padTop: 12, padBottom: 12 },
  F: { colGap: 7, vGap: 6, padTop: 12, padBottom: 12 },
};

/**
 * Column packing: bubbles sorted by descending radius flow left to right,
 * stacking vertically inside each column while the stack fits the band's
 * inner height. Deterministic, and the descending profile reads designed.
 * Returns local center coords (origin at the flow area's top-left) plus the
 * used width, or null when the band overflows horizontally.
 */
function packColumns(
  radii: readonly number[],
  innerH: number,
  colGap: number,
  vGap: number,
): { centers: Array<{ x: number; y: number }>; usedWidth: number } | null {
  const centers: Array<{ x: number; y: number }> = new Array(radii.length);
  let colX = 0;
  let colW = 0;
  let colUsed = 0;
  let colStart = 0;
  const finalizeColumn = (endIdx: number) => {
    // Center the finished column's stack vertically inside the band.
    const offset = (innerH - colUsed) / 2;
    for (let j = colStart; j < endIdx; j++) centers[j].y += offset;
  };
  for (let i = 0; i < radii.length; i++) {
    const d = radii[i] * 2;
    const needed = colUsed === 0 ? d : colUsed + vGap + d;
    if (colUsed > 0 && needed > innerH) {
      finalizeColumn(i);
      colX += colW + colGap;
      colW = 0;
      colUsed = 0;
      colStart = i;
    }
    const top = colUsed === 0 ? 0 : colUsed + vGap;
    centers[i] = { x: colX + radii[i], y: top + radii[i] };
    colUsed = top + d;
    colW = Math.max(colW, d);
  }
  finalizeColumn(radii.length);
  const usedWidth = colX + colW;
  if (usedWidth > FLOW_W) return null;
  return { centers, usedWidth };
}

function layoutBands(graded: readonly MapCoin[], scale: number): BandLayout[] | null {
  const maxMcap = Math.max(...graded.map((coin) => coin.mcap));
  const k = (R_MAX_TARGET * scale) / Math.sqrt(maxMcap);
  const radiusOf = (coin: MapCoin) => Math.max(R_MIN[coin.tier], k * Math.sqrt(Math.max(coin.mcap, 0)));

  const bands: BandLayout[] = [];
  let y = BODY_TOP;
  for (const tier of TIER_ORDER) {
    const coins = graded
      .filter((coin) => coin.tier === tier)
      .sort((a, b) =>
        tier === "A" && b.score !== a.score
          ? b.score - a.score
          : b.mcap !== a.mcap
            ? b.mcap - a.mcap
            : b.score - a.score || a.id.localeCompare(b.id),
      );
    if (coins.length === 0) continue;
    const gaps = TIER_GAPS[tier];
    const radii = coins.map(radiusOf);
    // Populous gravel tiers need deeper strata than their biggest bubble:
    // grow the inner height until the columns fit the flow width.
    let innerH = Math.max(Math.max(...radii) * 2, 40);
    let packed = packColumns(radii, innerH, gaps.colGap, gaps.vGap);
    while (!packed && innerH < 200) {
      innerH += 8;
      packed = packColumns(radii, innerH, gaps.colGap, gaps.vGap);
    }
    if (!packed) return null;
    const height = gaps.padTop + innerH + gaps.padBottom;
    // Every stratum centers in the flow so the strata read as a composed
    // stack rather than left-flushed packer output.
    const xOffset = Math.max((FLOW_W - packed.usedWidth) / 2, 0);
    const bubbles = coins.map((coin, i) => ({
      coin,
      cx: FLOW_X + xOffset + packed.centers[i].x,
      cy: y + gaps.padTop + packed.centers[i].y,
      r: radii[i],
    }));
    bands.push({
      tier,
      y,
      height,
      bubbles,
      totalCount: coins.length,
      totalMcap: coins.reduce((sum, coin) => sum + coin.mcap, 0),
      flowInset: xOffset,
    });
    y += height;
  }
  return y <= FOOTER_RULE_Y - 10 ? bands : null;
}

// --- SVG assembly ---------------------------------------------------------

function svgText(opts: {
  x: number;
  y: number;
  size: number;
  text: string;
  font?: "mono" | "serif" | "serifItalic" | "sans";
  weight?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  spacing?: string;
}): string {
  const families: Record<string, string> = {
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    serif: "'Newsreader', Georgia, 'Times New Roman', serif",
    serifItalic: "'Newsreader', Georgia, 'Times New Roman', serif",
    sans: "'Bricolage Grotesque', system-ui, sans-serif",
  };
  const attrs = [
    `x="${opts.x}"`,
    `y="${opts.y}"`,
    `font-family="${families[opts.font ?? "mono"]}"`,
    `font-size="${opts.size}"`,
    opts.weight ? `font-weight="${opts.weight}"` : "",
    opts.font === "serifItalic" ? `font-style="italic"` : "",
    `fill="${opts.fill ?? INK}"`,
    opts.anchor ? `text-anchor="${opts.anchor}"` : "",
    opts.spacing ? `letter-spacing="${opts.spacing}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${escapeXml(opts.text)}</text>`;
}

function buildSvg({
  bands,
  logos,
  brandMark,
  methodologyVersion,
  gradedCount,
  notRatedCount,
  asOfSec,
}: {
  bands: readonly BandLayout[];
  logos: ReadonlyMap<string, string | null>;
  brandMark: string;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  asOfSec: number;
}): string {
  const asOf = new Date(asOfSec * 1000);
  const monthName = asOf.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }).toUpperCase();
  const yearLabel = asOf.toISOString().slice(0, 4);
  const dateLabel = asOf.toISOString().slice(0, 10);
  const totalMcap = bands.reduce((sum, band) => sum + band.totalMcap, 0);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`);
  parts.push(`<defs><style>text { font-kerning: normal; font-variant-numeric: tabular-nums; }</style>`);
  // CSS circle() clip-paths silently no-op on SVG images in Firefox; a real
  // clipPath in objectBoundingBox units crops every bubble regardless of size.
  parts.push(`<clipPath id="bubble-clip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>`);

  // Light editorial shell shared with the OG templates.
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#f8f8fa"/>`);
  parts.push(`<rect width="${WIDTH}" height="4" fill="#22c55e"/>`);

  // Masthead: beacon mark + the single frost-blue beam reaching the top rule.
  const markSize = 32;
  const markX = MARGIN_X;
  const markY = 16;
  const markCx = markX + markSize / 2;
  parts.push(`<polygon points="${markCx - 2.5},${markY + 1} ${markCx + 2.5},${markY + 1} ${markCx + 1},4 ${markCx - 1},4" fill="${FROST_BLUE}"/>`);
  parts.push(`<image href="${brandMark}" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}"/>`);
  parts.push(svgText({ x: markX + markSize + 12, y: markY + markSize / 2 + 8, size: 21, text: "Pharos", font: "sans", weight: 700, spacing: "-0.3" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: markY + markSize / 2 + 6, size: 14, text: `Safety Score · Methodology v${methodologyVersion}`, fill: INK_SECONDARY, anchor: "end" }));
  parts.push(`<line x1="${MARGIN_X}" y1="64" x2="${WIDTH - MARGIN_X}" y2="64" stroke="${RULE}" stroke-width="1"/>`);

  // Title block with the month stamp as editorial furniture.
  parts.push(svgText({ x: MARGIN_X, y: 134, size: 54, text: "The Stablecoin Safety Map", font: "serif", weight: 500, spacing: "-0.5" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: 110, size: 13, text: monthName, font: "sans", weight: 700, fill: INK_SECONDARY, anchor: "end", spacing: "2.2" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: 136, size: 22, text: yearLabel, weight: 600, anchor: "end" }));
  parts.push(svgText({ x: MARGIN_X, y: 164, size: 13, text: `All ${gradedCount} graded stablecoins · sized by circulating supply, smallest floored for legibility · ${formatUsdCompact(totalMcap)} mapped`, fill: INK_SECONDARY }));

  const chips: string[] = [];
  for (const band of bands) {
    const color = TIER_COLORS[band.tier];
    const textColor = TIER_TEXT_COLORS[band.tier];

    if (band.tier === "A") {
      parts.push(`<rect x="${MARGIN_X}" y="${band.y}" width="${CONTENT_W}" height="${band.height}" fill="${color}" fill-opacity="0.03"/>`);
    }
    if (band.y > BODY_TOP) {
      parts.push(`<line x1="${MARGIN_X}" y1="${band.y}" x2="${WIDTH - MARGIN_X}" y2="${band.y}" stroke="${HAIRLINE}" stroke-width="1"/>`);
    }
    parts.push(`<rect x="${MARGIN_X}" y="${band.y + 10}" width="2" height="${band.height - 20}" fill="${color}"/>`);

    // Tier rail: the A stratum gets the tall editorial rail; compressed
    // strata use the compact inline form.
    const railX = MARGIN_X + 18;
    const share = ((band.totalMcap / totalMcap) * 100).toFixed(1);
    if (band.tier === "A") {
      parts.push(svgText({ x: railX, y: band.y + 76, size: 78, text: "A", font: "serif", weight: 560, fill: textColor }));
      const lines = [`Score ${tierRange("A")}`, `${band.totalCount} coins`, `${formatUsdCompact(band.totalMcap)} · ${share}%`];
      lines.forEach((line, i) => {
        parts.push(svgText({ x: railX + 2, y: band.y + 100 + i * 16, size: 11, text: line, fill: INK_SECONDARY }));
      });
    } else {
      parts.push(svgText({ x: railX, y: band.y + band.height / 2 + 11, size: 30, text: band.tier, font: "serif", weight: 560, fill: textColor }));
      parts.push(svgText({ x: railX + 34, y: band.y + band.height / 2 - 3, size: 10.5, text: `${tierRange(band.tier)} · ${band.totalCount} coins`, fill: INK_SECONDARY }));
      parts.push(svgText({ x: railX + 34, y: band.y + band.height / 2 + 11, size: 10.5, text: `${formatUsdCompact(band.totalMcap)} · ${share}%`, fill: INK_SECONDARY }));
    }

    // Editorial annotation in the A stratum's left void — the supply-share
    // punchline — drawn only when the centered pack leaves genuine room.
    if (band.tier === "A" && band.flowInset >= 180) {
      const annX = FLOW_X + 16;
      const annY = band.y + band.height / 2 - 8;
      parts.push(svgText({ x: annX, y: annY, size: 21, text: `${share}% of all graded supply`, font: "serifItalic", weight: 500, fill: INK_SECONDARY }));
      parts.push(svgText({ x: annX, y: annY + 28, size: 21, text: "sits in A-grade assets.", font: "serifItalic", weight: 500, fill: INK_SECONDARY }));
    }

    // Bubbles: circle-clipped logos with a hairline keyline. Chips render on
    // a later layer so labels sit above neighboring bubbles.
    let chipFlip = false;
    for (const bubble of band.bubbles) {
      const { coin, cx, cy, r } = bubble;
      const logo = logos.get(coin.id) ?? null;
      if (logo) {
        const size = r * 2;
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#ffffff"/>`);
        parts.push(
          `<g transform="translate(${(cx - r).toFixed(1)} ${(cy - r).toFixed(1)})"><image href="${logo}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" clip-path="url(#bubble-clip)"/></g>`,
        );
      } else {
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${HAIRLINE}"/>`);
        if (r >= 6) {
          parts.push(svgText({ x: cx, y: cy + r * 0.36, size: Math.max(Math.round(r * 0.9), 7), text: coin.symbol.slice(0, 1), fill: INK_SECONDARY, anchor: "middle" }));
        }
      }
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="rgba(23,23,25,0.10)" stroke-width="1"/>`);

      // Score chip: every A coin is named (the honor roll survives at bubble
      // scale); gravel strata only label bubbles big enough to carry a chip,
      // zigzagging between bottom and top rim so neighboring labels clear.
      if (band.tier === "A" || r >= CHIP_MIN_R) {
        const big = r >= 56;
        const size = big ? 13 : r >= 22 ? 12 : 10.5;
        const label = big ? `${coin.symbol} ${coin.score} · ${formatUsdCompact(coin.mcap)}` : `${coin.symbol} ${coin.score}`;
        const scoreText = big ? `${coin.score} · ${formatUsdCompact(coin.mcap)}` : String(coin.score);
        const symW = monoWidth(`${coin.symbol} `, size);
        const w = monoWidth(label, size) + 14;
        const h = size + 9;
        let chipCy: number;
        if (band.tier === "A") {
          // A chips clear their bubble entirely (the stratum breathes).
          chipCy = r < 56 ? cy + r + h / 2 + 3 : cy + r - h / 2 + 2;
        } else {
          chipCy = chipFlip ? cy - r - h / 2 - 2 : cy + r + h / 2 + 2;
          chipFlip = !chipFlip;
        }
        const chipX = Math.min(Math.max(cx - w / 2, FLOW_X - 8), FLOW_RIGHT - w + 8);
        chips.push(`<rect x="${chipX.toFixed(1)}" y="${(chipCy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="#ffffff" fill-opacity="0.94" stroke="${HAIRLINE}" stroke-width="1"/>`);
        chips.push(svgText({ x: chipX + 7, y: chipCy + size * 0.36, size, text: coin.symbol, weight: 600 }));
        chips.push(svgText({ x: chipX + 7 + symW, y: chipCy + size * 0.36, size, text: scoreText, weight: 650, fill: textColor }));
      }
    }
  }
  parts.push(...chips);

  // Footer.
  parts.push(`<line x1="${MARGIN_X}" y1="${FOOTER_RULE_Y}" x2="${WIDTH - MARGIN_X}" y2="${FOOTER_RULE_Y}" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(svgText({ x: MARGIN_X, y: FOOTER_RULE_Y + 32, size: 19, text: "Watching the peg.", font: "serifItalic", weight: 500 }));
  parts.push(svgText({ x: WIDTH / 2, y: FOOTER_RULE_Y + 31, size: 12, text: `Methodology v${methodologyVersion} · data as of ${dateLabel}${notRatedCount > 0 ? ` · ${notRatedCount} not rated` : ""}`, fill: INK_TERTIARY, anchor: "middle" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: FOOTER_RULE_Y + 31, size: 14, text: "pharos.watch", weight: 600, anchor: "end" }));
  parts.push(`</svg>`);
  return parts.join("\n");
}

function buildHtml(svg: string): string {
  const fontFace = (family: string, file: string, weights: string, italic = false) => `
  @font-face {
    font-family: '${family}';
    font-style: ${italic ? "italic" : "normal"};
    font-weight: ${weights};
    src: url('${pathToFileURL(file).href}') format('woff2');
    font-display: block;
  }`;
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>${fontFace("Newsreader", NEWSREADER_FONT, "200 800")}${fontFace("Newsreader", NEWSREADER_ITALIC_FONT, "200 800", true)}${fontFace("JetBrains Mono", JETBRAINS_MONO_FONT, "100 800")}${fontFace("Bricolage Grotesque", BRICOLAGE_FONT, "200 800")}
  html, body { margin: 0; padding: 0; background: #f8f8fa; }
  svg { display: block; }
</style>
</head>
<body>${svg}</body></html>`;
}

async function main(): Promise<void> {
  const { out } = parseCliArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const baseUrl = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;

  console.log(`[safety-score-map] Fetching live data from ${baseUrl}`);
  const [reportCards, list] = await Promise.all([
    fetchJson<{
      cards: Array<{ id: string; score: number | null; grade: string }>;
      methodology: { version: string };
      asOfSec: number;
    }>(API_PATHS.reportCardsV9(), apiKey, baseUrl),
    fetchJson<{ peggedAssets: Array<{ id: string; symbol: string; circulating?: Record<string, number> }> }>(
      API_PATHS.stablecoins(),
      apiKey,
      baseUrl,
    ),
  ]);

  const listById = new Map(list.peggedAssets.map((asset) => [asset.id, asset]));
  const graded: MapCoin[] = [];
  let notRatedCount = 0;
  for (const card of reportCards.cards) {
    const tier = card.grade.charAt(0) as Tier;
    if (card.grade === "NR" || card.score == null || !TIER_ORDER.includes(tier)) {
      notRatedCount += 1;
      continue;
    }
    const row = listById.get(card.id);
    graded.push({
      id: card.id,
      symbol: row?.symbol ?? card.id.toUpperCase(),
      grade: card.grade,
      score: card.score,
      tier,
      mcap: row ? getCirculatingRaw(row) : 0,
    });
  }

  // Shrink the bubble scale until every stratum fits above the footer.
  let bands: BandLayout[] | null = null;
  for (let scale = 1; scale >= 0.55; scale *= 0.96) {
    bands = layoutBands(graded, scale);
    if (bands) break;
  }
  if (!bands) throw new Error("Could not fit the bubble strata above the footer");

  const logosById = JSON.parse(readFileSync(LOGOS_JSON, "utf8")) as Record<string, string>;
  const logos = new Map<string, string | null>();
  const allBubbles = bands.flatMap((band) => band.bubbles);
  await Promise.all(
    allBubbles.map(async (bubble) => {
      const path = logosById[bubble.coin.id];
      logos.set(bubble.coin.id, path ? await loadLogoDataUri(path, Math.ceil(bubble.r * 2)) : null);
    }),
  );
  const missingLogos = allBubbles.filter((bubble) => !logos.get(bubble.coin.id));
  if (missingLogos.length > 0) {
    console.warn(`[safety-score-map] No logo for ${missingLogos.length} coins: ${missingLogos.slice(0, 12).map((b) => b.coin.id).join(", ")}${missingLogos.length > 12 ? ", …" : ""}`);
  }

  const brandMark = `data:image/svg+xml;base64,${readFileSync(BRAND_MARK).toString("base64")}`;
  const svg = buildSvg({
    bands,
    logos,
    brandMark,
    methodologyVersion: reportCards.methodology.version,
    gradedCount: graded.length,
    notRatedCount,
    asOfSec: reportCards.asOfSec,
  });

  const monthStamp = new Date(reportCards.asOfSec * 1000).toISOString().slice(0, 7);
  const pngPath = out
    ? resolve(out)
    : resolve(OUT_DIR, `safety-score-map-${monthStamp}.png`);
  const svgPath = pngPath.replace(/\.png$/, ".svg");
  const htmlPath = pngPath.replace(/\.png$/, ".html");
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(svgPath, svg);
  writeFileSync(htmlPath, buildHtml(svg));

  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: pngPath,
      omitBackground: false,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      timeout: 30000,
    });
  } finally {
    await browser.close();
  }

  console.log(`[safety-score-map] Wrote ${pngPath} (all ${graded.length} graded coins)`);
}

main().catch((err: unknown) => {
  console.error(`[safety-score-map] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
