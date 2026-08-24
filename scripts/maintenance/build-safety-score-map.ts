/**
 * Build the Safety Score map: a landscape Twitter-post-size (1600x900, rendered
 * at 2x) editorial infographic of the graded stablecoin universe.
 *
 * Composition (orbital map): every graded coin appears as its logo, sized by
 * circulating supply (area-proportional with a legibility floor), arranged in
 * concentric grade orbits around an A-tier core. Size carries the economic
 * story while distance from the core carries the safety tier; small markers
 * integrated between the paths identify each grade without a detached legend.
 *
 * Two editions share one composition:
 *   --edition=daily    stable output name with the capture date in the footer
 *                      and no issue furniture. Regenerated unattended and
 *                      published to /safety-scores/map.
 *   --edition=monthly  month-stamped archive name plus the monthly issue
 *                      lockup. Triggered deliberately and reviewed by a human.
 *
 * Archive/output naming uses the run date (UTC); visible date provenance uses
 * the report-card capture clock (asOfSec). Every number on the poster is
 * computed from the fetched data — no headline figure is ever a literal.
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
import { GRADE_RADAR_COLORS } from "@shared/lib/classification";
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
const BRAND_MARK = resolve(REPO_ROOT, "public/pharos-mark-on-dark.svg");
const LOGOS_JSON = resolve(REPO_ROOT, "data/logos.json");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const OUT_DIR = resolve(REPO_ROOT, "agents/safety-score-map");

const WIDTH = 1600;
const HEIGHT = 900;
const DEVICE_SCALE = 2;
const MARGIN_X = 64;
const FOOTER_RULE_Y = 864;
const BODY_TOP = 128;
const GALAXY_CX = 800;
const GALAXY_CY = 495;

// Data freshness ceiling for an unattended render: a stalled report-card
// producer must fail the job, not publish week-old scores under today's date.
const MAX_DATA_AGE_SEC = 48 * 3600;
// Below this share of graded cards joining a list row with real supply, the
// map is drawing floors instead of data.
const MIN_JOIN_COVERAGE = 0.95;

// Palette: a midnight editorial shell lets the classification colors read as
// orbital signals instead of spreadsheet rules.
const INK = "#f5f7fb";
const INK_SECONDARY = "#9aa6ba";
const HAIRLINE = "#2a3448";
const RULE = "#263044";
const FROST_BLUE = "#4bc4de";

// Letter-tier hex tokens come from the shared classification palette.
const TIER_ORDER = ["A", "B", "C", "D", "F"] as const;
type Tier = (typeof TIER_ORDER)[number];
const TIER_COLORS = GRADE_RADAR_COLORS;

interface OrbitZone {
  innerRx: number;
  innerRy: number;
  outerRx: number;
  outerRy: number;
}

// Closed, wide ellipses use the landscape canvas instead of concentrating the
// universe in its middle. Radial gaps keep adjacent tiers visually distinct.
const ORBIT_ZONES: Record<Tier, OrbitZone> = {
  A: { innerRx: 0, innerRy: 0, outerRx: 300, outerRy: 190 },
  B: { innerRx: 320, innerRy: 210, outerRx: 430, outerRy: 245 },
  C: { innerRx: 450, innerRy: 260, outerRx: 550, outerRy: 285 },
  D: { innerRx: 570, innerRy: 300, outerRx: 650, outerRy: 320 },
  F: { innerRx: 670, innerRy: 330, outerRx: 735, outerRy: 359 },
};

// Bubble sizing: area tracks circulating supply, floored for presence. The
// largest coin anchors the scale; the fit loop shrinks it until the strata
// stack above the footer.
const R_MAX_TARGET = 68;
const MIN_LOGO_SCALE = 1.25 * 1.25;
const R_MIN_A = 7 * MIN_LOGO_SCALE;
const GRAVEL_FLOORS = [5 * MIN_LOGO_SCALE] as const;
const BUBBLE_GAP = 2.5;

// Only these codepoints are covered by all four embedded faces. Anything else
// falls through to a machine-dependent glyph and can visibly change the map.
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
  zone: OrbitZone;
  bubbles: Bubble[];
  totalCount: number;
  totalMcap: number;
}

interface FitDiagnostic {
  tier: string;
  count: number;
  placed: number;
  radius: number;
}

function ellipseValue(x: number, y: number, rx: number, ry: number): number {
  return (x * x) / (rx * rx) + (y * y) / (ry * ry);
}

function circleFitsOrbit(zone: OrbitZone, cx: number, cy: number, r: number): boolean {
  const x = cx - GALAXY_CX;
  const y = cy - GALAXY_CY;
  const outerRx = zone.outerRx - r;
  const outerRy = zone.outerRy - r;
  if (!(outerRx > 0 && outerRy > 0) || ellipseValue(x, y, outerRx, outerRy) > 1) return false;
  if (zone.innerRx === 0) return true;
  return ellipseValue(x, y, zone.innerRx + r, zone.innerRy + r) >= 1;
}

function bubblesOverlap(a: Pick<Bubble, "cx" | "cy" | "r">, b: Pick<Bubble, "cx" | "cy" | "r">): boolean {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r + BUBBLE_GAP;
}

function snailCandidates(
  zone: OrbitZone,
  r: number,
  index: number,
  count: number,
): Array<{ x: number; y: number }> {
  const candidates: Array<{ x: number; y: number }> = [];
  if (index === 0) return [{ x: GALAXY_CX, y: GALAXY_CY }];
  const maxRx = zone.outerRx - r;
  const maxRy = zone.outerRy - r;

  // After the two central anchors, give every A asset a stable "district" on
  // one clockwise Paris-style escargot. Local alternates only rescue changes
  // in bubble size; they never restart the search from an arbitrary location.
  const progress = (index - 2) / Math.max(count - 3, 1);
  const baseRx = 105 + progress * 95;
  const baseRy = 85 + progress * 55;
  const baseAngle = 0.95 + progress * Math.PI * 2;
  for (let expansion = 0; expansion <= 18; expansion++) {
    for (let offsetStep = 0; offsetStep <= 14; offsetStep++) {
      const offsets = offsetStep === 0 ? [0] : [offsetStep * 0.008, -offsetStep * 0.008];
      for (const offset of offsets) {
        const theta = baseAngle + offset;
        candidates.push({
          x: GALAXY_CX + Math.min(maxRx, baseRx + expansion * 2) * Math.cos(theta),
          y: GALAXY_CY + Math.min(maxRy, baseRy + expansion * 1.4) * Math.sin(theta),
        });
      }
    }
  }
  return candidates;
}

function packEllipticalOrbit(
  radii: readonly number[],
  orbitRx: number,
  orbitRy: number,
  phase: number,
): Array<{ x: number; y: number }> | null {
  if (radii.length === 0) return [];

  // Sample the centerline densely enough to map equal arc lengths back onto
  // the ellipse. This prevents the crowded short-axis ends produced by equal
  // angle spacing and lets every tier complete the full closed path.
  const sampleCount = 4096;
  const cumulative = new Array<number>(sampleCount + 1).fill(0);
  let previousX = orbitRx;
  let previousY = 0;
  for (let i = 1; i <= sampleCount; i++) {
    const theta = (i / sampleCount) * Math.PI * 2;
    const x = orbitRx * Math.cos(theta);
    const y = orbitRy * Math.sin(theta);
    cumulative[i] = cumulative[i - 1] + Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }
  const perimeter = cumulative[sampleCount];
  const required = radii.map((radius, index) => radius + radii[(index + 1) % radii.length] + BUBBLE_GAP);
  const requiredLength = required.reduce((sum, distance) => sum + distance, 0);
  if (!Number.isFinite(perimeter) || requiredLength > perimeter) return null;
  const slack = (perimeter - requiredLength) / radii.length;

  const pointAtArc = (rawArc: number): { x: number; y: number } => {
    const arc = ((rawArc % perimeter) + perimeter) % perimeter;
    let low = 0;
    let high = sampleCount;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (cumulative[mid] <= arc) low = mid;
      else high = mid;
    }
    const span = cumulative[high] - cumulative[low];
    const fraction = span > 0 ? (arc - cumulative[low]) / span : 0;
    const theta = ((low + fraction) / sampleCount) * Math.PI * 2;
    return {
      x: GALAXY_CX + orbitRx * Math.cos(theta),
      y: GALAXY_CY + orbitRy * Math.sin(theta),
    };
  };

  const centers: Array<{ x: number; y: number }> = [];
  let arc = (((phase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2)) * perimeter;
  for (let i = 0; i < radii.length; i++) {
    centers.push(pointAtArc(arc));
    arc += required[i] + slack;
  }
  for (let i = 0; i < centers.length; i++) {
    const next = centers[(i + 1) % centers.length];
    if (Math.hypot(centers[i].x - next.x, centers[i].y - next.y) < required[i]) return null;
  }
  return centers;
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
  const placedAcrossTiers: Bubble[] = [];
  for (const tier of TIER_ORDER) {
    // Large assets claim the cleanest orbital positions first. The orbit itself
    // carries grade, so angle is intentionally decorative rather than a second
    // unlabelled score axis.
    const coins = graded
      .filter((coin) => coin.tier === tier)
      .sort((a, b) => b.mcap - a.mcap || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (coins.length === 0) continue;
    const zone = ORBIT_ZONES[tier];
    const bubbles: Bubble[] = [];
    const radii = coins.map(radiusOf);
    if (radii.some((radius) => !Number.isFinite(radius))) {
      const index = radii.findIndex((radius) => !Number.isFinite(radius));
      throw new Error(`Non-finite radius for ${coins[index].id} (mcap=${coins[index].mcap})`);
    }
    if (tier === "A") {
      for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        const r = radii[i];
        // USDT is first by supply and therefore takes the literal center. USDC
        // is tangent to it on the right; the remaining assets keep their
        // explicit district positions on the outward escargot.
        const candidates = i === 1
          ? [{ x: GALAXY_CX + radii[0] + r + BUBBLE_GAP, y: GALAXY_CY }]
          : snailCandidates(zone, r, i, coins.length);
        const point = candidates.find(({ x, y }) => {
          if (!circleFitsOrbit(zone, x, y, r)) return false;
          const candidate = { cx: x, cy: y, r };
          return !placedAcrossTiers.some((other) => bubblesOverlap(candidate, other));
        });
        if (!point) {
          diag?.push({ tier, count: coins.length, placed: bubbles.length, radius: r });
          return null;
        }
        const bubble = { coin, cx: point.x, cy: point.y, r };
        bubbles.push(bubble);
        placedAcrossTiers.push(bubble);
      }
    } else {
      const orbitRx = (zone.innerRx + zone.outerRx) / 2;
      const orbitRy = (zone.innerRy + zone.outerRy) / 2;
      const centers = packEllipticalOrbit(radii, orbitRx, orbitRy, TIER_ORDER.indexOf(tier) * 0.47 - Math.PI / 2);
      if (!centers) {
        diag?.push({ tier, count: coins.length, placed: 0, radius: Math.max(...radii) });
        return null;
      }
      for (let i = 0; i < coins.length; i++) {
        const bubble = { coin: coins[i], cx: centers[i].x, cy: centers[i].y, r: radii[i] };
        if (!circleFitsOrbit(zone, bubble.cx, bubble.cy, bubble.r)) {
          diag?.push({ tier, count: coins.length, placed: i, radius: bubble.r });
          return null;
        }
        if (placedAcrossTiers.some((other) => bubblesOverlap(bubble, other))) {
          diag?.push({ tier, count: coins.length, placed: i, radius: bubble.r });
          return null;
        }
        bubbles.push(bubble);
        placedAcrossTiers.push(bubble);
      }
    }
    bands.push({
      tier,
      zone,
      bubbles,
      totalCount: coins.length,
      totalMcap: coins.reduce((sum, coin) => sum + coin.mcap, 0),
    });
  }
  return { bands, k, gravelFloor };
}

function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
}

// --- Composition linter ---------------------------------------------------

export interface CompositionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositionOrbit {
  tier: string;
  zone: OrbitZone;
  bubbles: ReadonlyArray<{ id: string; cx: number; cy: number; r: number }>;
}

/**
 * Pure-geometry validation of a laid-out scene: chip-vs-chip overlap, chips
 * crossing the footer rule or poster bounds, bubbles escaping their assigned
 * orbit, bubble collisions, and any non-finite coordinate. Returns one string
 * per violation; an empty array means the composition is sound.
 */
export function validateComposition(input: {
  orbits: readonly CompositionOrbit[];
  chips: readonly CompositionRect[];
  footerRuleY?: number;
  bodyTop?: number;
}): string[] {
  const footerRuleY = input.footerRuleY ?? FOOTER_RULE_Y;
  const bodyTop = input.bodyTop ?? BODY_TOP;
  const violations: string[] = [];

  const allBubbles: Array<{ id: string; cx: number; cy: number; r: number }> = [];
  for (const orbit of input.orbits) {
    for (const [label, value] of Object.entries(orbit.zone)) {
      if (!Number.isFinite(value)) violations.push(`orbit ${orbit.tier}: non-finite ${label} (${value})`);
    }
    if (
      orbit.zone.innerRx < 0 ||
      orbit.zone.innerRy < 0 ||
      orbit.zone.outerRx <= orbit.zone.innerRx ||
      orbit.zone.outerRy <= orbit.zone.innerRy
    ) {
      violations.push(`orbit ${orbit.tier}: invalid inner/outer radii`);
    }
    if (
      GALAXY_CX - orbit.zone.outerRx < MARGIN_X - 8 ||
      GALAXY_CX + orbit.zone.outerRx > WIDTH - MARGIN_X + 8 ||
      GALAXY_CY - orbit.zone.outerRy < bodyTop - 8 ||
      GALAXY_CY + orbit.zone.outerRy > footerRuleY - 10
    ) {
      violations.push(`orbit ${orbit.tier}: crosses the body bounds`);
    }
    for (const bubble of orbit.bubbles) {
      if (!Number.isFinite(bubble.cx) || !Number.isFinite(bubble.cy) || !Number.isFinite(bubble.r)) {
        violations.push(`bubble ${bubble.id}: non-finite geometry (${bubble.cx}, ${bubble.cy}, r=${bubble.r})`);
        continue;
      }
      if (!circleFitsOrbit(orbit.zone, bubble.cx, bubble.cy, bubble.r)) {
        violations.push(`bubble ${bubble.id}: escapes orbit ${orbit.tier}`);
      }
      allBubbles.push(bubble);
    }
  }
  for (let i = 0; i < allBubbles.length; i++) {
    for (let j = i + 1; j < allBubbles.length; j++) {
      if (bubblesOverlap(allBubbles[i], allBubbles[j])) {
        violations.push(`bubble overlap: ${allBubbles[i].id} / ${allBubbles[j].id}`);
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
  logos,
  brandMark,
  methodologyVersion,
  gradedCount,
  asOfSec,
  edition,
  issue,
  floorMcap,
}: {
  bands: readonly BandLayout[];
  logos: ReadonlyMap<string, string | null>;
  brandMark: string;
  methodologyVersion: string;
  gradedCount: number;
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
  parts.push(`<radialGradient id="space" cx="50%" cy="54%" r="76%"><stop offset="0" stop-color="#18243a"/><stop offset="0.46" stop-color="#0c1220"/><stop offset="1" stop-color="#05070d"/></radialGradient>`);
  // CSS circle() clip-paths silently no-op on SVG images in Firefox; a real
  // clipPath in objectBoundingBox units crops every bubble regardless of size.
  parts.push(`<clipPath id="bubble-clip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>`);

  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#space)"/>`);
  parts.push(`<rect width="${WIDTH}" height="4" fill="${FROST_BLUE}"/>`);

  // A deterministic star field gives the orbital metaphor texture without
  // introducing random daily churn into a publication artifact.
  let starSeed = 0x50484152;
  for (let i = 0; i < 112; i++) {
    starSeed = (Math.imul(starSeed, 1664525) + 1013904223) >>> 0;
    const x = 42 + (starSeed % 1516);
    starSeed = (Math.imul(starSeed, 1664525) + 1013904223) >>> 0;
    const y = BODY_TOP + (starSeed % (FOOTER_RULE_Y - BODY_TOP - 8));
    starSeed = (Math.imul(starSeed, 1664525) + 1013904223) >>> 0;
    const radius = 0.45 + (starSeed % 14) / 10;
    const opacity = 0.12 + (starSeed % 32) / 100;
    parts.push(`<circle cx="${x}" cy="${y}" r="${radius.toFixed(1)}" fill="#dbeafe" fill-opacity="${opacity.toFixed(2)}"/>`);
  }

  // One-line masthead: brand lockup and map title share the same visual row.
  // Methodology and capture date live in the footer, stated once.
  const markSize = 40;
  const markX = MARGIN_X;
  const markY = 10;
  const markCx = markX + markSize / 2;
  parts.push(`<polygon points="${markCx - 2.5},${markY + 1} ${markCx + 2.5},${markY + 1} ${markCx + 1},4 ${markCx - 1},4" fill="${FROST_BLUE}"/>`);
  parts.push(`<image href="${brandMark}" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}"/>`);
  parts.push(svgText({ x: markX + markSize + 11, y: 40, size: 22, text: "Pharos", font: "sans", weight: 700, spacing: "-0.3" }));
  parts.push(`<line x1="217" y1="12" x2="217" y2="54" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(svgText({ x: 244, y: 50, size: 40, text: "The Stablecoin Safety Map", font: "serif", weight: 500, spacing: "-0.5" }));
  parts.push(svgText({ x: 246, y: 72, size: 9, text: "SAFETY GRAVITATES INWARD", weight: 700, fill: FROST_BLUE, spacing: "2.1" }));
  if (stamp.issue) {
    parts.push(svgText({ x: WIDTH - MARGIN_X, y: 40, size: 10, text: stamp.issue, weight: 700, fill: INK_SECONDARY, anchor: "end", spacing: "2.2" }));
  }
  parts.push(`<line x1="${MARGIN_X}" y1="92" x2="${WIDTH - MARGIN_X}" y2="92" stroke="${RULE}" stroke-width="1"/>`);

  // B–F are closed ranked galaxies: the line follows the exact deterministic
  // supply order used to place their stablecoins. A keeps its line-free
  // escargot so the center remains visually distinct.
  for (const band of bands) {
    if (band.tier === "A" || band.bubbles.length < 2) continue;
    const points = band.bubbles.map((bubble) => `${bubble.cx.toFixed(1)},${bubble.cy.toFixed(1)}`).join(" ");
    parts.push(`<polygon points="${points}" fill="none" stroke="${TIER_COLORS[band.tier]}" stroke-width="1.1" stroke-opacity="0.32" stroke-linejoin="round"/>`);
  }

  // Bubbles: circle-clipped logos with a narrow grade-color rim.
  for (const band of bands) {
    const color = TIER_COLORS[band.tier];
    for (const bubble of band.bubbles) {
      const { coin, cx, cy, r } = bubble;
      const logo = logos.get(coin.id) ?? null;
      const ringWidth = r >= 10 ? 2.2 : 1.3;
      const innerR = Math.max(r - ringWidth, r * 0.68);
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>`);
      if (logo) {
        const size = innerR * 2;
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${innerR.toFixed(1)}" fill="#ffffff"/>`);
        parts.push(
          `<g transform="translate(${(cx - innerR).toFixed(1)} ${(cy - innerR).toFixed(1)})"><image href="${logo}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" clip-path="url(#bubble-clip)"/></g>`,
        );
      } else {
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${innerR.toFixed(1)}" fill="${HAIRLINE}"/>`);
        if (r >= 6) {
          parts.push(svgText({ x: cx, y: cy + r * 0.36, size: Math.max(Math.round(r * 0.9), 7), text: mapLabel(coin.symbol).slice(0, 1), fill: INK_SECONDARY, anchor: "middle" }));
        }
      }
    }
  }

  // Small native markers sit in the breathing room just outside each path.
  // They identify orbit and census count without becoming a detached legend.
  const markerAngle = -2.5;
  for (const band of bands) {
    const ux = Math.cos(markerAngle);
    const uy = Math.sin(markerAngle);
    let x = GALAXY_CX + (band.zone.outerRx + 10) * ux;
    let y = GALAXY_CY + (band.zone.outerRy + 8) * uy;
    if (band.tier === "A") {
      // A occupies only part of its reserved core zone. Anchor its marker to
      // the escargot's real support edge so it stays close as membership and
      // supply sizes change, while retaining a safe logo-to-label gutter.
      const occupiedExtent = Math.max(
        ...band.bubbles.map((bubble) =>
          (bubble.cx - GALAXY_CX) * ux + (bubble.cy - GALAXY_CY) * uy + bubble.r,
        ),
      );
      x = GALAXY_CX + (occupiedExtent + 24) * ux;
      y = GALAXY_CY + (occupiedExtent + 24) * uy;
    }
    parts.push(svgText({ x, y: y + 3, size: 10, text: `${band.tier} · ${band.totalCount}`, fill: TIER_COLORS[band.tier], weight: 750, anchor: "middle", spacing: "1" }));
  }

  // Footer: the poster's single informative strip. Everything the deck and the
  // masthead used to duplicate is stated here, once.
  parts.push(`<line x1="${MARGIN_X}" y1="${FOOTER_RULE_Y}" x2="${WIDTH - MARGIN_X}" y2="${FOOTER_RULE_Y}" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(svgText({ x: MARGIN_X, y: FOOTER_RULE_Y + 17, size: 16, text: "Watching the peg.", font: "serifItalic", weight: 500 }));
  parts.push(svgText({ x: WIDTH - MARGIN_X, y: FOOTER_RULE_Y + 17, size: 13, text: "Every grade, every source -> pharos.watch", weight: 700, anchor: "end" }));
  const notes = [
    `Methodology v${methodologyVersion}`,
    dateLabel,
    `${gradedCount} graded`,
    `${formatUsdCompact(totalMcap)} mapped`,
    "area = supply",
    `minimum below ~${formatUsdCompact(floorMcap)}`,
    "orbit = safety tier",
  ];
  parts.push(svgText({ x: WIDTH / 2, y: FOOTER_RULE_Y + 31, size: 8, text: notes.join(" · "), fill: INK_SECONDARY, anchor: "middle" }));
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
  html, body { margin: 0; padding: 0; background: #05070d; }
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
    `All ${gradedCount} graded stablecoins in five concentric safety orbits, with USDT and USDC anchoring a line-free spiral A core, B, C, D, and F connected in supply-rank order, and each logo sized by circulating supply; ${formatUsdCompact(totalMcap)} mapped.`,
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
  // Large bubbles may shrink to protect the composition, but the publication
  // floor is fixed: recognizability must not silently degrade to make it fit.
  for (const gravelFloor of GRAVEL_FLOORS) {
    for (let scale = 1; scale >= 0.55; scale *= 0.96) {
      diag = [];
      const layout = layoutBands(graded, scale, gravelFloor, diag);
      if (layout) return layout;
    }
  }
  const detail = diag
    .map((d) => `${d.tier}: placed ${d.placed}/${d.count} coins before radius ${d.radius.toFixed(1)} stopped fitting`)
    .join("; ");
  throw new Error(
    `Could not fit the orbital map above the footer at any scale or gravel floor (tried ${GRAVEL_FLOORS.join("/")}). ${detail || "no diagnostics captured"}`,
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

  // Per-coin chips made the orbital edition read as an arbitrary label sample.
  // The composition now uses only native grade/count markers between paths.
  const chips: CompositionRect[] = [];
  const omitted: string[] = [];
  const violations = validateComposition({
    orbits: bands.map((band) => ({
      tier: band.tier,
      zone: band.zone,
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
    logos,
    brandMark,
    methodologyVersion: reportCards.methodology.version,
    gradedCount: graded.length,
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
    // fallback metrics visibly change the publication artifact. Check each
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
