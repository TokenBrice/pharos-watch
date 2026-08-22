/**
 * Build the Safety Score map: a landscape Twitter-post-size (1600x900, rendered
 * at 2x) editorial infographic of the graded stablecoin universe.
 *
 * Composition (bubble map): every graded coin appears as its logo, sized by
 * circulating supply (area-proportional with a legibility floor), packed into
 * horizontal grade strata A-F. Size carries the economic story — the A band
 * holds the giants, the lower tiers read as shrinking gravel — and white
 * score chips label every coin large enough to name.
 *
 * Two editions share one composition:
 *   --edition=daily    stable output name, "DATA AS OF <date>" stamp, no issue
 *                      furniture. Regenerated unattended and published to
 *                      /safety-scores/map.
 *   --edition=monthly  month-stamped archive name plus the monthly issue
 *                      lockup. Triggered deliberately and reviewed by a human.
 *
 * Archive/output naming uses the run date (UTC); the visible stamp uses the
 * report-card capture clock (asOfSec). Every number on the poster is computed
 * from the fetched data — no headline figure is ever a literal.
 *
 * Usage:
 *   npm run build:safety-score-map
 *   npm run build:safety-score-map:monthly
 *   npm run build:safety-score-map -- --out agents/custom.png
 *
 * Inputs:
 *   - $PHAROS_API_KEY (env or .env.local): required for api.pharos.watch
 *   - $PHAROS_API_BASE: optional API origin override
 *   - --previous-snapshot <path>: the prior run's .snapshot.json, which arms
 *     the day-over-day delta guard. Optional; absent or unreadable skips that
 *     guard with a warning so a first run can bootstrap. Freshness, finite
 *     geometry, and join coverage are asserted unconditionally.
 *
 * Outputs (alongside the PNG, sharing its basename):
 *   - .svg / .html   the rendered scene and its screenshot host
 *   - .alt.json      alt text plus the per-tier table, same numbers as the pixels
 *   - .snapshot.json header {edition, date, asOfSec, renderedAtSec, counts}
 *                    plus {id, score, grade} per graded coin (movers baseline,
 *                    and the next run's delta-guard input)
 *   - .manifest.json {date, asOfSec, renderedAtSec, counts, bytes}
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { firefox } from "playwright";
import sharp from "sharp";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { GRADE_POSTER_TEXT_COLORS, GRADE_RADAR_COLORS } from "@shared/lib/classification";
import { GRADE_THRESHOLDS } from "@shared/lib/report-card-core";
import { getCirculatingRaw } from "@shared/lib/supply";
import { escapeXml } from "../lib/og-svg.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
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
const DEVICE_SCALE = 2;
const MARGIN_X = 64;
const CONTENT_W = WIDTH - MARGIN_X * 2;
const FOOTER_RULE_Y = 848;
const RAIL_WIDTH = 170;
const FLOW_X = MARGIN_X + RAIL_WIDTH;
const FLOW_RIGHT = WIDTH - MARGIN_X;
const BODY_TOP = 192;
// The headline stat owns a reserved column inside the A stratum. Reserving it
// in layout is what stops the poster's one sentence from silently vanishing
// when a wider A pack eats the left void.
const ANNOTATION_W = 310;

// Data freshness ceiling for an unattended render: a stalled report-card
// producer must fail the job, not publish week-old scores under today's date.
const MAX_DATA_AGE_SEC = 48 * 3600;
// Below this share of graded cards joining a list row with real supply, the
// map is drawing floors instead of data.
const MIN_JOIN_COVERAGE = 0.95;

// Palette: editorial shell neutrals shared with the OG templates.
const INK = "#171719";
const INK_SECONDARY = "#5f6570";
const HAIRLINE = "#e4e7eb";
const RULE = "#d9dce1";
const FROST_BLUE = "#4bc4de";

// Letter-tier hex tokens come from the shared classification palette.
const TIER_ORDER = ["A", "B", "C", "D", "F"] as const;
type Tier = (typeof TIER_ORDER)[number];
const TIER_COLORS = GRADE_RADAR_COLORS;
const TIER_TEXT_COLORS = GRADE_POSTER_TEXT_COLORS;

// Bubble sizing: area tracks circulating supply, floored for presence. The
// largest coin anchors the scale; the fit loop shrinks it until the strata
// stack above the footer.
const R_MAX_TARGET = 150;
// The A tier floors higher so "every A is exceptional" survives at poster
// scale; the gravel floor is the fit loop's second degradation axis.
const R_MIN_A = 14;
const GRAVEL_FLOORS = [7, 6, 5] as const;
const CHIP_MIN_R = 15;
// Always name this many coins per stratum, whatever their radius: "who is the
// biggest D coin" is the newsiest fact on the poster.
const CHIP_TOP_N = 3;

// Only these codepoints are covered by all four embedded faces. Anything else
// falls through to a machine-dependent glyph with the wrong advance, which
// silently breaks monoWidth()'s exact 0.6em math.
const RENDERABLE_TEXT = /^[\x20-\x7e·–—°€£¥]*$/;
const unsupportedGlyphs = new Set<string>();

type Edition = "daily" | "monthly";

interface MapCoin {
  id: string;
  symbol: string;
  grade: string;
  score: number;
  tier: Tier;
  mcap: number;
}

function parseCliArgs(argv: readonly string[]): {
  out: string | null;
  edition: Edition;
  issue: number | null;
  previousSnapshot: string | null;
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
      edition: { type: "string" },
      issue: { type: "string" },
      "previous-snapshot": { type: "string" },
    },
  });
  const edition = values.edition ?? "daily";
  if (edition !== "daily" && edition !== "monthly") {
    throw new Error(`--edition must be "daily" or "monthly" (got "${edition}")`);
  }
  let issue: number | null = null;
  if (values.issue != null) {
    issue = Number(values.issue);
    if (!Number.isInteger(issue) || issue < 1) throw new Error(`--issue must be a positive integer (got "${values.issue}")`);
  }
  return { out: values.out ?? null, edition, issue, previousSnapshot: values["previous-snapshot"] ?? null };
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

// U+20AE and friends are absent from every embedded face; transliterate the
// ones we know about and record the rest so the operator hears about them.
function mapLabel(text: string): string {
  const transliterated = text.replace(/₮/g, "T");
  for (const char of transliterated) {
    if (!RENDERABLE_TEXT.test(char)) unsupportedGlyphs.add(char);
  }
  return transliterated;
}

// Grade-band score range projected from the methodology policy thresholds.
function tierRange(tier: Tier): string {
  const mins = GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) === tier).map((t) => t.min);
  const min = Math.min(...mins);
  const higher = GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) !== tier && t.min > min).map((t) => t.min);
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
    const srcW = meta.width ?? 64;
    const srcH = meta.height ?? 64;
    const srcDim = Math.max(srcW, srcH);
    const target = sizePx * 2;
    const density = Math.min(9600, Math.max(144, Math.ceil((72 * target) / srcDim)));
    // Square artwork — most of the set — keeps filling the disc edge to edge.
    // Non-square sources (USDT's 339x295 hexagon at -13%, XAUT at -19%, FRAX
    // at -35%) must be letterboxed with an inset instead: "cover" crops the
    // square out of the box and the circle clip then exposes the flat top and
    // pointed bottom as white wedges.
    const pipeline = sharp(filePath, { density });
    if (Math.abs(srcW / srcH - 1) <= 0.03) {
      const png = await pipeline.resize(target, target, { fit: "cover" }).png().toBuffer();
      return `data:image/png;base64,${png.toString("base64")}`;
    }
    // A letterboxed source is already tangent to the inscribed circle at its
    // widest axis, so the inset only needs to cover anti-aliasing: at 8% the
    // hero bubble floated in a visible white halo.
    const pad = Math.max(1, Math.round(target * 0.02));
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const png = await pipeline
      .resize(target - pad * 2, target - pad * 2, { fit: "contain", background: transparent })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: transparent })
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
  flowLeft: number; // left edge of this stratum's usable flow area
}

interface TierGaps {
  colGap: number;
  vGap: number;
  padTop: number;
  padBottom: number;
}

interface FitDiagnostic {
  tier: string;
  count: number;
  usedWidth: number;
  innerH: number;
  deficit: number;
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
 * Column packing: bubbles flow left to right, stacking vertically inside each
 * column while the stack fits the band's inner height. Deterministic, and
 * tolerant of non-monotone radii. Returns local center coords (origin at the
 * flow area's top-left) plus the used width; `fits` is false when the band
 * overflows the available width.
 */
function packColumns(
  radii: readonly number[],
  innerH: number,
  colGap: number,
  vGap: number,
  availW: number,
): { centers: Array<{ x: number; y: number }>; usedWidth: number; fits: boolean } {
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
  return { centers, usedWidth, fits: usedWidth <= availW };
}

function layoutBands(
  graded: readonly MapCoin[],
  scale: number,
  gravelFloor: number,
  diag?: FitDiagnostic[],
): { bands: BandLayout[]; k: number; gravelFloor: number } | null {
  const maxMcap = Math.max(...graded.map((coin) => coin.mcap));
  const k = (R_MAX_TARGET * scale) / Math.sqrt(maxMcap);
  // maxMcap = 0 (an empty or unjoined list endpoint) yields k = Infinity and
  // NaN radii; every NaN comparison downstream is false, so the layout would
  // "fit" and a header-only poster would ship with exit code 0.
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`Bubble scale is not finite (k=${k}, maxMcap=${maxMcap}) — the supply join produced no usable values`);
  }
  const floorOf = (tier: Tier) => (tier === "A" ? R_MIN_A : gravelFloor);
  const radiusOf = (coin: MapCoin) => Math.max(floorOf(coin.tier), k * Math.sqrt(Math.max(coin.mcap, 0)));

  const bands: BandLayout[] = [];
  let y = BODY_TOP;
  for (const tier of TIER_ORDER) {
    // Every stratum is ordered by score, so x-position tracks the grade the
    // poster is about rather than restating the area encoding.
    const coins = graded
      .filter((coin) => coin.tier === tier)
      .sort((a, b) => b.score - a.score || b.mcap - a.mcap || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (coins.length === 0) continue;
    const gaps = TIER_GAPS[tier];
    const radii = coins.map(radiusOf);
    for (let i = 0; i < radii.length; i++) {
      if (!Number.isFinite(radii[i])) throw new Error(`Non-finite radius for ${coins[i].id} (mcap=${coins[i].mcap})`);
    }
    // The A stratum yields its left column to the headline stat.
    const flowLeft = tier === "A" ? FLOW_X + ANNOTATION_W : FLOW_X;
    const availW = FLOW_RIGHT - flowLeft;
    // Populous gravel tiers need deeper strata than their biggest bubble:
    // grow the inner height until the columns fit the flow width.
    let innerH = Math.max(Math.max(...radii) * 2, 40);
    let packed = packColumns(radii, innerH, gaps.colGap, gaps.vGap, availW);
    while (!packed.fits && innerH < 200) {
      innerH += 8;
      packed = packColumns(radii, innerH, gaps.colGap, gaps.vGap, availW);
    }
    if (!packed.fits) {
      diag?.push({ tier, count: coins.length, usedWidth: packed.usedWidth, innerH, deficit: packed.usedWidth - availW });
      return null;
    }
    const height = gaps.padTop + innerH + gaps.padBottom;
    // Every stratum centers in its flow area so the strata read as a composed
    // stack rather than left-flushed packer output.
    const xOffset = Math.max((availW - packed.usedWidth) / 2, 0);
    const bubbles = coins.map((coin, i) => ({
      coin,
      cx: flowLeft + xOffset + packed.centers[i].x,
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
      flowLeft,
    });
    y += height;
  }
  if (y > FOOTER_RULE_Y - 10) {
    diag?.push({ tier: "stack", count: graded.length, usedWidth: 0, innerH: y - BODY_TOP, deficit: y - (FOOTER_RULE_Y - 10) });
    return null;
  }
  return { bands, k, gravelFloor };
}

// --- Chip placement -------------------------------------------------------

interface PlacedChip {
  id: string;
  tier: Tier;
  symbol: string;
  score: string;
  size: number;
  symW: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CHIP_TOP = BODY_TOP - 8;
const CHIP_BOTTOM = FOOTER_RULE_Y - 4;

function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
}

/**
 * Chip placement with real collision rejection. Candidates are tried in a
 * deterministic order (below, above, then each nudged by a quarter width);
 * the first that clears every already-placed chip and stays inside its band
 * wins, then the same order relaxed to the poster's chip bounds. Forced chips
 * (the A honour roll and each tier's largest names) are placed first so they
 * win the contested space. A chip with nowhere to go is dropped, never drawn
 * overlapping.
 */
function placeChips(
  bands: readonly BandLayout[],
  labelledMcap: ReadonlySet<string>,
): { chips: PlacedChip[]; omitted: string[] } {
  interface Candidate {
    bubble: Bubble;
    band: BandLayout;
    forced: boolean;
    symbol: string;
    score: string;
    size: number;
    w: number;
    h: number;
    symW: number;
  }
  const wanted: Candidate[] = [];
  for (const band of bands) {
    const topByMcap = new Set(
      [...band.bubbles]
        .sort((a, b) => b.coin.mcap - a.coin.mcap)
        .slice(0, CHIP_TOP_N)
        .map((bubble) => bubble.coin.id),
    );
    for (const bubble of band.bubbles) {
      const forced = band.tier === "A" || topByMcap.has(bubble.coin.id);
      if (!forced && bubble.r < CHIP_MIN_R) continue;
      const size = bubble.r >= 56 ? 13 : 11;
      const symbol = mapLabel(bubble.coin.symbol);
      // Bubble area already encodes supply; only the two giants carry the
      // figure, where the number is the story rather than a repeat.
      const score = labelledMcap.has(bubble.coin.id)
        ? `${bubble.coin.score} · ${formatUsdCompact(bubble.coin.mcap)}`
        : String(bubble.coin.score);
      const symW = monoWidth(`${symbol} `, size);
      wanted.push({
        bubble,
        band,
        forced,
        symbol,
        score,
        size,
        symW,
        w: monoWidth(`${symbol} ${score}`, size) + 14,
        h: size + 9,
      });
    }
  }
  wanted.sort((a, b) => Number(b.forced) - Number(a.forced));

  const chips: PlacedChip[] = [];
  const omitted: string[] = [];
  for (const cand of wanted) {
    const { bubble, band, w, h } = cand;
    const { cx, cy, r } = bubble;
    const centers: number[] = [];
    // A giant's chip rides its own rim; it is far larger than the label.
    if (r >= 56) centers.push(cy + r - h / 2 + 2);
    const below = cy + r + h / 2 + 3;
    const above = cy - r - h / 2 - 3;
    centers.push(below, above);
    const offsets = [0, -w / 4, w / 4];
    const positions: Array<{ x: number; y: number }> = [];
    for (const dx of offsets) {
      for (const chipCy of centers) {
        const x = Math.min(Math.max(cx - w / 2 + dx, band.flowLeft - 8), FLOW_RIGHT - w + 8);
        positions.push({ x, y: chipCy - h / 2 });
      }
    }
    const fitsBand = (p: { y: number }) => p.y >= band.y + 1 && p.y + h <= band.y + band.height - 1;
    const inBounds = (p: { y: number }) => p.y >= CHIP_TOP && p.y + h <= CHIP_BOTTOM;
    const free = (p: { x: number; y: number }) => !chips.some((c) => intersects({ ...p, w, h }, c));
    const chosen =
      positions.find((p) => fitsBand(p) && inBounds(p) && free(p)) ?? positions.find((p) => inBounds(p) && free(p)) ?? null;
    if (!chosen) {
      omitted.push(bubble.coin.id);
      continue;
    }
    chips.push({
      id: bubble.coin.id,
      tier: band.tier,
      symbol: cand.symbol,
      score: cand.score,
      size: cand.size,
      symW: cand.symW,
      x: chosen.x,
      y: chosen.y,
      w,
      h,
    });
  }
  return { chips, omitted };
}

// --- Composition linter ---------------------------------------------------

export interface CompositionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositionBand {
  tier: string;
  y: number;
  height: number;
  bubbles: ReadonlyArray<{ id: string; cx: number; cy: number; r: number }>;
}

/**
 * Pure-geometry validation of a laid-out scene: chip-vs-chip overlap, chips
 * crossing the footer rule or the poster bounds, bands overflowing the footer,
 * bubbles escaping their stratum, and any non-finite coordinate. Returns one
 * string per violation; an empty array means the composition is sound.
 */
export function validateComposition(input: {
  bands: readonly CompositionBand[];
  chips: readonly CompositionRect[];
  footerRuleY?: number;
  bodyTop?: number;
}): string[] {
  const footerRuleY = input.footerRuleY ?? FOOTER_RULE_Y;
  const bodyTop = input.bodyTop ?? BODY_TOP;
  const violations: string[] = [];

  for (const band of input.bands) {
    for (const [label, value] of [
      ["y", band.y],
      ["height", band.height],
    ] as const) {
      if (!Number.isFinite(value)) violations.push(`band ${band.tier}: non-finite ${label} (${value})`);
    }
    if (band.y + band.height > footerRuleY - 10) {
      violations.push(`band ${band.tier}: overflows the footer rule (bottom ${(band.y + band.height).toFixed(1)} > ${footerRuleY - 10})`);
    }
    for (const bubble of band.bubbles) {
      if (!Number.isFinite(bubble.cx) || !Number.isFinite(bubble.cy) || !Number.isFinite(bubble.r)) {
        violations.push(`bubble ${bubble.id}: non-finite geometry (${bubble.cx}, ${bubble.cy}, r=${bubble.r})`);
        continue;
      }
      if (bubble.cy - bubble.r < band.y - 0.5 || bubble.cy + bubble.r > band.y + band.height + 0.5) {
        violations.push(`bubble ${bubble.id}: escapes band ${band.tier}`);
      }
    }
  }

  for (const chip of input.chips) {
    if (![chip.x, chip.y, chip.w, chip.h].every(Number.isFinite)) {
      violations.push(`chip ${chip.id}: non-finite geometry`);
      continue;
    }
    if (chip.y + chip.h > footerRuleY - 4 || chip.y < bodyTop - 8) {
      violations.push(`chip ${chip.id}: crosses the body bounds (y ${chip.y.toFixed(1)}..${(chip.y + chip.h).toFixed(1)})`);
    }
    if (chip.x < MARGIN_X - 8 || chip.x + chip.w > WIDTH - MARGIN_X + 8) {
      violations.push(`chip ${chip.id}: crosses the side margin (x ${chip.x.toFixed(1)}..${(chip.x + chip.w).toFixed(1)})`);
    }
  }
  for (let i = 0; i < input.chips.length; i++) {
    for (let j = i + 1; j < input.chips.length; j++) {
      if (intersects(input.chips[i], input.chips[j])) {
        violations.push(`chip overlap: ${input.chips[i].id} / ${input.chips[j].id}`);
      }
    }
  }
  return violations;
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
  if (!RENDERABLE_TEXT.test(opts.text)) {
    for (const char of opts.text) {
      if (!RENDERABLE_TEXT.test(char)) unsupportedGlyphs.add(char);
    }
  }
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

interface StampCopy {
  eyebrow: string;
  headline: string;
  issue: string | null;
}

// Daily and monthly diverge here and nowhere else in the composition.
function stampCopy(edition: Edition, issue: number | null, asOf: Date): StampCopy {
  if (edition === "monthly") {
    return {
      eyebrow: asOf.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }).toUpperCase(),
      headline: asOf.toISOString().slice(0, 4),
      issue: issue == null ? "PHAROS MONTHLY" : `PHAROS MONTHLY · NO. ${issue}`,
    };
  }
  return { eyebrow: "DATA AS OF", headline: asOf.toISOString().slice(0, 10), issue: null };
}

function buildSvg({
  bands,
  chips,
  logos,
  brandMark,
  methodologyVersion,
  gradedCount,
  notRatedCount,
  asOfSec,
  edition,
  issue,
  floorMcap,
}: {
  bands: readonly BandLayout[];
  chips: readonly PlacedChip[];
  logos: ReadonlyMap<string, string | null>;
  brandMark: string;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  asOfSec: number;
  edition: Edition;
  issue: number | null;
  floorMcap: number;
}): string {
  const asOf = new Date(asOfSec * 1000);
  const dateLabel = asOf.toISOString().slice(0, 10);
  const stamp = stampCopy(edition, issue, asOf);
  const totalMcap = bands.reduce((sum, band) => sum + band.totalMcap, 0);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`);
  parts.push(`<defs><style>text { font-kerning: normal; font-variant-numeric: tabular-nums; }</style>`);
  // CSS circle() clip-paths silently no-op on SVG images in Firefox; a real
  // clipPath in objectBoundingBox units crops every bubble regardless of size.
  parts.push(`<clipPath id="bubble-clip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>`);

  // Light editorial shell shared with the OG templates. The top rule takes the
  // grade-A green so green means exactly one thing on this poster.
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#f8f8fa"/>`);
  parts.push(`<rect width="${WIDTH}" height="4" fill="${TIER_COLORS.A}"/>`);

  // Masthead: beacon mark + the single frost-blue beam reaching the top rule.
  // Methodology and capture date live in the footer, stated once.
  const markSize = 32;
  const markX = MARGIN_X;
  const markY = 16;
  const markCx = markX + markSize / 2;
  parts.push(`<polygon points="${markCx - 2.5},${markY + 1} ${markCx + 2.5},${markY + 1} ${markCx + 1},4 ${markCx - 1},4" fill="${FROST_BLUE}"/>`);
  parts.push(`<image href="${brandMark}" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}"/>`);
  parts.push(svgText({ x: markX + markSize + 12, y: markY + markSize / 2 + 8, size: 21, text: "Pharos", font: "sans", weight: 700, spacing: "-0.3" }));
  if (stamp.issue) {
    parts.push(svgText({ x: WIDTH - MARGIN_X, y: markY + markSize / 2 + 6, size: 11, text: stamp.issue, weight: 700, fill: INK_SECONDARY, anchor: "end", spacing: "2.2" }));
  }
  parts.push(`<line x1="${MARGIN_X}" y1="64" x2="${WIDTH - MARGIN_X}" y2="64" stroke="${RULE}" stroke-width="1"/>`);

  // Title block. The stamp lockup is all mono: serif is the editorial voice,
  // mono the data voice, sans the brand lockup alone.
  parts.push(svgText({ x: MARGIN_X, y: 134, size: 54, text: "The Stablecoin Safety Map", font: "serif", weight: 500, spacing: "-0.5" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: 110, size: 11, text: stamp.eyebrow, weight: 700, fill: INK_SECONDARY, anchor: "end", spacing: "2.2" }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: 136, size: 20, text: stamp.headline, weight: 600, anchor: "end" }));

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
    // strata use the compact inline form. Rail stats are all 11px.
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
      parts.push(svgText({ x: railX + 34, y: band.y + band.height / 2 - 3, size: 11, text: `${tierRange(band.tier)} · ${band.totalCount} coins`, fill: INK_SECONDARY }));
      parts.push(svgText({ x: railX + 34, y: band.y + band.height / 2 + 12, size: 11, text: `${formatUsdCompact(band.totalMcap)} · ${share}%`, fill: INK_SECONDARY }));
    }

    // The headline stat owns the A stratum's reserved column: scarcity first,
    // every figure computed from the data being drawn.
    if (band.tier === "A") {
      const annX = FLOW_X + 16;
      const annCy = band.y + band.height / 2;
      parts.push(svgText({ x: annX, y: annCy - 18, size: 60, text: String(band.totalCount), font: "serif", weight: 600, fill: textColor, spacing: "-1" }));
      parts.push(svgText({ x: annX, y: annCy + 14, size: 17, text: `of ${gradedCount} stablecoins earn an A.`, font: "serif", weight: 500 }));
      parts.push(svgText({ x: annX, y: annCy + 38, size: 17, text: `They hold ${share}% of all supply.`, font: "serif", weight: 500 }));
    }

    // Bubbles: circle-clipped logos with a hairline keyline. Chips render on
    // a later layer so labels sit above neighboring bubbles.
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
          parts.push(svgText({ x: cx, y: cy + r * 0.36, size: Math.max(Math.round(r * 0.9), 7), text: mapLabel(coin.symbol).slice(0, 1), fill: INK_SECONDARY, anchor: "middle" }));
        }
      }
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="rgba(23,23,25,0.18)" stroke-width="1"/>`);
    }
  }

  // Chip layer: placed and collision-checked before render.
  for (const chip of chips) {
    const chipCy = chip.y + chip.h / 2;
    parts.push(`<rect x="${chip.x.toFixed(1)}" y="${chip.y.toFixed(1)}" width="${chip.w.toFixed(1)}" height="${chip.h}" rx="${chip.h / 2}" fill="#ffffff" fill-opacity="0.94" stroke="${HAIRLINE}" stroke-width="1"/>`);
    parts.push(svgText({ x: chip.x + 7, y: chipCy + chip.size * 0.36, size: chip.size, text: chip.symbol, weight: 600 }));
    parts.push(svgText({ x: chip.x + 7 + chip.symW, y: chipCy + chip.size * 0.36, size: chip.size, text: chip.score, weight: 650, fill: TIER_TEXT_COLORS[chip.tier] }));
  }

  // Footer: the poster's single informative strip. Everything the deck and the
  // masthead used to duplicate is stated here, once.
  parts.push(`<line x1="${MARGIN_X}" y1="${FOOTER_RULE_Y}" x2="${WIDTH - MARGIN_X}" y2="${FOOTER_RULE_Y}" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(svgText({ x: MARGIN_X, y: FOOTER_RULE_Y + 24, size: 19, text: "Watching the peg.", font: "serifItalic", weight: 500 }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: FOOTER_RULE_Y + 23, size: 15, text: "Every grade, every source -> pharos.watch", weight: 700, anchor: "end" }));
  const notes = [
    `Methodology v${methodologyVersion}`,
    `data as of ${dateLabel}`,
    // "N not rated" would imply N is the whole ungraded remainder; it is only
    // the in-scoring slice, so the footer says exactly that.
    `${gradedCount} graded stablecoins${notRatedCount > 0 ? `, ${notRatedCount} in scoring, not yet rated` : ""}`,
    `${formatUsdCompact(totalMcap)} mapped`,
    "sized by circulating supply, ordered by score",
    `coins under ~${formatUsdCompact(floorMcap)} shown at minimum size`,
  ];
  parts.push(svgText({ x: WIDTH / 2, y: FOOTER_RULE_Y + 42, size: 11, text: notes.join(" · "), fill: INK_SECONDARY, anchor: "middle" }));
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

// --- Emitted numbers ------------------------------------------------------

interface TierSummary {
  tier: Tier;
  range: string;
  count: number;
  mcap: number;
  share: number;
  leaders: Array<{ symbol: string; score: number; mcap: number }>;
}

function summarizeTiers(bands: readonly BandLayout[]): TierSummary[] {
  const totalMcap = bands.reduce((sum, band) => sum + band.totalMcap, 0);
  return bands.map((band) => ({
    tier: band.tier,
    range: tierRange(band.tier),
    count: band.totalCount,
    mcap: band.totalMcap,
    share: (band.totalMcap / totalMcap) * 100,
    leaders: [...band.bubbles]
      .sort((a, b) => b.coin.mcap - a.coin.mcap)
      .slice(0, 3)
      .map((bubble) => ({ symbol: mapLabel(bubble.coin.symbol), score: bubble.coin.score, mcap: bubble.coin.mcap })),
  }));
}

function buildAltText({
  tiers,
  stampLabel,
  gradedCount,
  notRatedCount,
  totalMcap,
  methodologyVersion,
  dateLabel,
}: {
  tiers: readonly TierSummary[];
  stampLabel: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcap: number;
  methodologyVersion: string;
  dateLabel: string;
}): string {
  const sentences = [
    `The Stablecoin Safety Map, ${stampLabel}, by Pharos.`,
    `All ${gradedCount} graded stablecoins in five safety tiers, each shown as its logo sized by circulating supply; ${formatUsdCompact(totalMcap)} mapped.`,
    `Methodology v${methodologyVersion}, data as of ${dateLabel}.`,
  ];
  for (const tier of tiers) {
    const leaders = tier.leaders.map((l) => `${l.symbol} ${l.score} (${formatUsdCompact(l.mcap)})`).join(", ");
    sentences.push(
      `${tier.tier} tier (score ${tier.range}): ${tier.count} coins, ${formatUsdCompact(tier.mcap)}, ${tier.share.toFixed(1)}% of all graded supply — led by ${leaders}.`,
    );
  }
  if (notRatedCount > 0) sentences.push(`${notRatedCount} coins in scoring, not yet rated.`);
  sentences.push("Full interactive rankings at pharos.watch.");
  return sentences.join(" ");
}

function buildTierTable(tiers: readonly TierSummary[]): string {
  const rows = tiers.map(
    (tier) =>
      `| ${tier.tier} | ${tier.range} | ${tier.count} | ${formatUsdCompact(tier.mcap)} | ${tier.share.toFixed(1)}% | ${tier.leaders
        .map((l) => `${l.symbol} ${l.score}`)
        .join(", ")} |`,
  );
  return ["| Tier | Score | Coins | Supply | Share | Largest |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

// --- Main -----------------------------------------------------------------

// §11.2b rule 2: a half-broken producer shows up as a census that moves too
// far overnight, not as a crash. Deliberately non-fatal when there is no prior
// snapshot — a first run has nothing to compare against and must still boot.
const MAX_GRADED_DROP = 0.02;
const MAX_NOT_RATED_MOVE = 5;

function assertSaneDeltas(path: string | null, gradedCount: number, notRatedCount: number): void {
  if (!path) {
    console.warn("[safety-score-map] No --previous-snapshot supplied — day-over-day delta guard skipped");
    return;
  }
  let previous: { counts?: { graded?: number; notRated?: number }; coins?: unknown[] };
  try {
    previous = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (err) {
    console.warn(`[safety-score-map] Could not read --previous-snapshot ${path} (${err instanceof Error ? err.message : String(err)}) — delta guard skipped`);
    return;
  }
  const priorGraded = previous.counts?.graded ?? (Array.isArray(previous.coins) ? previous.coins.length : null);
  const priorNotRated = previous.counts?.notRated ?? null;
  if (priorGraded == null) {
    console.warn(`[safety-score-map] --previous-snapshot ${path} carries no graded count — delta guard skipped`);
    return;
  }
  if (gradedCount < priorGraded * (1 - MAX_GRADED_DROP)) {
    throw new Error(
      `Graded count fell from ${priorGraded} to ${gradedCount} (>${MAX_GRADED_DROP * 100}%) since the previous snapshot — refusing to publish a shrunken census`,
    );
  }
  if (priorNotRated != null && Math.abs(notRatedCount - priorNotRated) > MAX_NOT_RATED_MOVE) {
    throw new Error(
      `Not-rated count moved from ${priorNotRated} to ${notRatedCount} (>${MAX_NOT_RATED_MOVE}) since the previous snapshot — the scoring producer looks half-broken`,
    );
  }
  console.log(`[safety-score-map] Delta guard OK vs previous snapshot (graded ${priorGraded} -> ${gradedCount}, not rated ${priorNotRated ?? "?"} -> ${notRatedCount})`);
}

function fitLayout(graded: readonly MapCoin[]): { bands: BandLayout[]; k: number; gravelFloor: number } {
  let diag: FitDiagnostic[] = [];
  // Scale is the first degradation axis; the gravel floor is the second, and
  // it is the one that matters once bubble count rather than bubble size is
  // what overflows the vertical budget.
  for (const gravelFloor of GRAVEL_FLOORS) {
    for (let scale = 1; scale >= 0.55; scale *= 0.96) {
      diag = [];
      const layout = layoutBands(graded, scale, gravelFloor, diag);
      if (layout) return layout;
    }
  }
  const detail = diag
    .map((d) => `${d.tier}: ${d.count} coins, usedWidth ${d.usedWidth.toFixed(0)}, innerH ${d.innerH.toFixed(0)}, over by ${d.deficit.toFixed(0)}px`)
    .join("; ");
  throw new Error(
    `Could not fit the bubble strata above the footer at any scale or gravel floor (tried ${GRAVEL_FLOORS.join("/")}). ${detail || "no diagnostics captured"}`,
  );
}

async function main(): Promise<void> {
  const { out, edition, issue, previousSnapshot } = parseCliArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const baseUrl = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;

  console.log(`[safety-score-map] Fetching live data from ${baseUrl} (edition: ${edition})`);
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

  // Freshness is asserted on the data, not left to a footer date nobody reads.
  const ageSec = Math.floor(Date.now() / 1000) - reportCards.asOfSec;
  if (!Number.isFinite(reportCards.asOfSec) || ageSec > MAX_DATA_AGE_SEC) {
    throw new Error(`Report-card capture is ${(ageSec / 3600).toFixed(1)}h old (max ${MAX_DATA_AGE_SEC / 3600}h) — refusing to render stale scores`);
  }

  const listById = new Map(list.peggedAssets.map((asset) => [asset.id, asset]));
  const graded: MapCoin[] = [];
  const unjoined: string[] = [];
  let notRatedCount = 0;
  for (const card of reportCards.cards) {
    const tier = card.grade.charAt(0) as Tier;
    if (card.grade === "NR" || card.score == null) {
      notRatedCount += 1;
      continue;
    }
    // A future grade letter outside A-F used to be silently counted as "not
    // rated" — a wrong public number with no error.
    if (!TIER_ORDER.includes(tier)) {
      throw new Error(`Unknown grade "${card.grade}" for ${card.id} — the tier map (${TIER_ORDER.join("/")}) is out of date`);
    }
    const row = listById.get(card.id);
    const mcap = row ? getCirculatingRaw(row) : 0;
    if (!row || !(mcap > 0)) {
      unjoined.push(card.id);
      console.warn(`[safety-score-map] ${card.id}: ${row ? "zero circulating supply" : "no list row"} — drawn at the size floor`);
    }
    graded.push({
      id: card.id,
      symbol: row?.symbol ?? card.id.toUpperCase(),
      grade: card.grade,
      score: card.score,
      tier,
      mcap,
    });
  }
  if (graded.length === 0) throw new Error("No graded coins returned — refusing to render an empty map");
  const joinCoverage = 1 - unjoined.length / graded.length;
  if (joinCoverage < MIN_JOIN_COVERAGE) {
    throw new Error(
      `Supply join coverage ${(joinCoverage * 100).toFixed(1)}% is below ${(MIN_JOIN_COVERAGE * 100).toFixed(0)}% (${unjoined.length}/${graded.length} unjoined) — the map would be drawing floors, not data`,
    );
  }
  assertSaneDeltas(previousSnapshot, graded.length, notRatedCount);

  const { bands, k, gravelFloor } = fitLayout(graded);
  // The cross-tier legibility floor, disclosed as a rule rather than a caveat:
  // below this supply every gravel bubble renders at the same minimum size.
  const floorMcap = (gravelFloor / k) ** 2;

  const topTwoIds = new Set(
    [...graded]
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 2)
      .map((coin) => coin.id),
  );
  const { chips, omitted } = placeChips(bands, topTwoIds);
  if (omitted.length > 0) {
    console.warn(`[safety-score-map] ${omitted.length} chips dropped for want of a collision-free slot: ${omitted.slice(0, 12).join(", ")}`);
  }
  const violations = validateComposition({
    bands: bands.map((band) => ({
      tier: band.tier,
      y: band.y,
      height: band.height,
      bubbles: band.bubbles.map((bubble) => ({ id: bubble.coin.id, cx: bubble.cx, cy: bubble.cy, r: bubble.r })),
    })),
    chips,
  });
  if (violations.length > 0) {
    throw new Error(`Composition validation failed:\n  ${violations.slice(0, 20).join("\n  ")}`);
  }

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
    chips,
    logos,
    brandMark,
    methodologyVersion: reportCards.methodology.version,
    gradedCount: graded.length,
    notRatedCount,
    asOfSec: reportCards.asOfSec,
    edition,
    issue,
    floorMcap,
  });
  if (unsupportedGlyphs.size > 0) {
    console.warn(`[safety-score-map] Text uses codepoints missing from the embedded fonts: ${[...unsupportedGlyphs].join(" ")}`);
  }

  // Archive naming uses the run date (UTC); the visible stamp uses asOfSec. A
  // Sep 1 run on Aug 31 data must not overwrite the August archive.
  //
  // One clock read feeds both, so `date` is always the UTC date of
  // `renderedAtSec` by construction — reading the clock again after the
  // screenshot would let a run straddling UTC midnight emit a mismatched pair,
  // and consumers key the dated archive off `date` (plan §11.2b rule 7).
  const renderedAtSec = Math.floor(Date.now() / 1000);
  const runDate = new Date(renderedAtSec * 1000).toISOString().slice(0, 10);
  const baseName = edition === "monthly" ? `safety-score-map-${runDate.slice(0, 7)}` : "safety-score-map-latest";
  const pngPath = out ? resolve(out) : resolve(OUT_DIR, `${baseName}.png`);
  const sidecar = (suffix: string) => pngPath.replace(/\.png$/, suffix);
  const svgPath = sidecar(".svg");
  const htmlPath = sidecar(".html");
  const manifestPath = sidecar(".manifest.json");

  // Refuse to publish backwards: a re-run of an old commit, or a delayed cron
  // racing a manual dispatch, must not overwrite a newer render.
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8")) as { renderedAt?: string };
    if (previous.renderedAt && Date.parse(previous.renderedAt) > Date.now()) {
      throw new Error(`Existing manifest at ${manifestPath} was rendered in the future (${previous.renderedAt}) — refusing to publish backwards`);
    }
  }

  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(svgPath, svg);
  writeFileSync(htmlPath, buildHtml(svg));

  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DEVICE_SCALE });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
    // document.fonts.ready resolves even when a face FAILS to load, and the
    // fallback metrics silently break monoWidth()'s exact math. Check each
    // family explicitly.
    const missingFonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const specs = ["16px 'Newsreader'", "italic 16px 'Newsreader'", "16px 'JetBrains Mono'", "16px 'Bricolage Grotesque'"];
      return specs.filter((spec) => !document.fonts.check(spec));
    });
    if (missingFonts.length > 0) throw new Error(`Fonts failed to load: ${missingFonts.join(", ")}`);
    await page.screenshot({
      path: pngPath,
      omitBackground: false,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      timeout: 30000,
    });
  } finally {
    await browser.close();
  }

  // The clip is in CSS pixels and the device scale multiplies it; assert the
  // raster really came out at 2x rather than trusting the flag.
  const rendered = await sharp(pngPath).metadata();
  if (rendered.width !== WIDTH * DEVICE_SCALE || rendered.height !== HEIGHT * DEVICE_SCALE) {
    throw new Error(`Expected a ${WIDTH * DEVICE_SCALE}x${HEIGHT * DEVICE_SCALE} raster, got ${rendered.width}x${rendered.height}`);
  }

  const asOf = new Date(reportCards.asOfSec * 1000);
  const dateLabel = asOf.toISOString().slice(0, 10);
  const stamp = stampCopy(edition, issue, asOf);
  const tiers = summarizeTiers(bands);
  const totalMcap = bands.reduce((sum, band) => sum + band.totalMcap, 0);
  const altText = buildAltText({
    tiers,
    stampLabel: edition === "monthly" ? `${stamp.eyebrow} ${stamp.headline}`.toLowerCase() : `data as of ${dateLabel}`,
    gradedCount: graded.length,
    notRatedCount,
    totalMcap,
    methodologyVersion: reportCards.methodology.version,
    dateLabel,
  });
  const table = buildTierTable(tiers);
  // One header shape, shared by the snapshot and the manifest: it is both the
  // movers baseline and the input the next run's delta guard reads back.
  const counts = {
    graded: graded.length,
    notRated: notRatedCount,
    unjoined: unjoined.length,
    chipsDrawn: chips.length,
    chipsDropped: omitted.length,
    byTier: Object.fromEntries(tiers.map((tier) => [tier.tier, tier.count])),
  };

  writeFileSync(
    sidecar(".alt.json"),
    `${JSON.stringify({ edition, date: runDate, asOfSec: reportCards.asOfSec, altText, table, tiers }, null, 2)}\n`,
  );
  writeFileSync(
    sidecar(".snapshot.json"),
    `${JSON.stringify(
      {
        edition,
        date: runDate,
        asOfSec: reportCards.asOfSec,
        renderedAtSec,
        methodologyVersion: reportCards.methodology.version,
        counts,
        coins: graded.map((coin) => ({ id: coin.id, score: coin.score, grade: coin.grade })),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        edition,
        date: runDate,
        renderedAt: new Date(renderedAtSec * 1000).toISOString(),
        renderedAtSec,
        asOfSec: reportCards.asOfSec,
        methodologyVersion: reportCards.methodology.version,
        counts,
        totalMcap,
        bytes: statSync(pngPath).size,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`[safety-score-map] Wrote ${pngPath} (${rendered.width}x${rendered.height}, ${graded.length} graded coins)`);
  console.log(`\n--- alt text ---\n${altText}\n`);
  console.log(`--- per-tier table ---\n${table}\n`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[safety-score-map] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
