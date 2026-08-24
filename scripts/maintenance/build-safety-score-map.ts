/**
 * Build the Safety Score map: a landscape Twitter-post-size (1600x900, rendered
 * at 2x) editorial infographic of the graded stablecoin universe.
 *
 * Composition (orbital map): every graded coin appears in one of five discrete
 * grade bands around an A-tier core. Bubble area is proportional to circulating
 * supply only above a per-tier legibility floor; smaller assets use a fixed
 * presence marker. A reserved chart key explains grade, score range, guide
 * pattern, and the dominant A-tier supply share. Both size floors remain in
 * the footer.
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
 *   - live PSI: the current display level and condition band shown beneath the
 *     map title, fetched during the render alongside report cards and supply
 *   - --previous-snapshot <path>: the prior run's .snapshot.json, which arms
 *     the day-over-day delta guard. Optional; absent or unreadable skips that
 *     guard with a warning so a first run can bootstrap. Freshness, finite
 *     geometry, and join coverage are asserted unconditionally.
 *
 * Outputs (alongside the PNG, sharing its basename):
 *   - .svg / .html   the rendered scene and its screenshot host
 *   - .alt.json      alt text plus the per-tier table, same numbers as the pixels
 *   - .snapshot.json header {edition, date, publicationStatus, asOfSec,
 *                    renderedAtSec, methodologyVersion, counts, mapSummary}
 *                    plus {id, symbol, score, grade, mcap} per graded coin
 *                    (movers baseline, and the next run's delta-guard input)
 *   - .manifest.json {date, asOfSec, renderedAtSec, counts, bytes}
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { firefox, type Page } from "playwright";
import sharp from "sharp";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { GRADE_RADAR_COLORS } from "@shared/lib/classification";
import { formatScore } from "@shared/lib/format";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { GRADE_THRESHOLDS, scoreToGrade } from "@shared/lib/report-card-core";
import { getCirculatingRaw } from "@shared/lib/supply";
import { SAFETY_GRADE_VALUES } from "@shared/types/report-card-grade";
import { escapeXml } from "../lib/og-svg.mts";
import {
  planAnnotations,
  validateAnnotationScene,
  type Annotation,
  type AnnotationScene,
  type PlacedAnnotation,
  type Rect,
} from "../lib/map-annotations";
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
const FOOTER_RULE_Y = 880;
const HEADER_RULE_Y = 86;
const HEADER_BODY_GAP = 12;
const BODY_TOP = HEADER_RULE_Y + HEADER_BODY_GAP;
const GALAXY_CX = 800;
const GALAXY_CY = 482;

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
const RULE = "#263044";
const FROST_BLUE = "#4bc4de";

// Letter-tier hex tokens come from the shared classification palette.
const TIER_ORDER = ["A", "B", "C", "D", "F"] as const;
type Tier = (typeof TIER_ORDER)[number];
const TIER_COLORS = GRADE_RADAR_COLORS;
const VALID_CARD_GRADES = new Set<string>([...SAFETY_GRADE_VALUES, "NR"]);

interface OrbitZone {
  innerRx: number;
  innerRy: number;
  outerRx: number;
  outerRy: number;
}

// The A core is deliberately compact. B begins immediately outside it, while
// the demand-derived B-F stack consumes the remaining radial budget outward.
const BASE_ORBIT_ZONES: Record<Tier, OrbitZone> = {
  A: { innerRx: 0, innerRy: 0, outerRx: 246, outerRy: 164 },
  B: { innerRx: 262, innerRy: 172, outerRx: 396, outerRy: 231 },
  C: { innerRx: 410, innerRy: 239, outerRx: 604, outerRy: 324 },
  D: { innerRx: 618, innerRy: 332, outerRx: 672, outerRy: 356 },
  F: { innerRx: 686, innerRy: 364, outerRx: 744, outerRy: 384 },
};
const OUTER_TIERS = ["B", "C", "D", "F"] as const;
const OUTER_INNER_RX = BASE_ORBIT_ZONES.B.innerRx;
const OUTER_INNER_RY = BASE_ORBIT_ZONES.B.innerRy;
const OUTER_RX = BASE_ORBIT_ZONES.F.outerRx;
const OUTER_RY = BASE_ORBIT_ZONES.F.outerRy;
const BAND_GAP_X = 14;
const BAND_GAP_Y = 8;
const BAND_SEMANTIC_MIN = 8;
const BAND_PACKING_EFFICIENCY = 0.72;
const SUBGRADE_LANE_TARGET_Y = 15;
const SUBGRADE_LANE_DEGRADE_STEPS = 16;
const SUBGRADE_LANE_REFERENCE_POPULATION = 40;
const SUBGRADE_LANE_MAX_DEMAND_FACTOR = 2;
const SUBGRADE_LANE_PACK_PHASES = 24;
const MAX_ANGULAR_GAP_MEAN_MULTIPLE = 3;

// The compact header keeps only the visual grammar needed to decode the map.
export const CHART_KEY_PANEL: Rect = { x: 800, y: 18, w: 736, h: 48 };
const MASTHEAD_LOCKUP: Rect = { x: MARGIN_X, y: 4, w: 714, h: 78 };
const FOOTER_PANEL: Rect = { x: MARGIN_X - 4, y: FOOTER_RULE_Y + 2, w: WIDTH - (MARGIN_X - 4) * 2, h: 16 };
const ANNOTATION_FRAME: Rect = { x: MARGIN_X - 8, y: 4, w: WIDTH - (MARGIN_X - 8) * 2, h: HEIGHT - 5 };

export const BAND_GUIDE_DASHARRAY: Readonly<Record<Tier, string | null>> = {
  A: "1 3",
  B: null,
  C: "9 5",
  D: "2 4",
  F: "12 4 2 4",
};

// Bubble sizing: area tracks circulating supply, floored for presence. The
// largest coin anchors the scale; the fit loop shrinks it until the strata
// stack above the footer.
const R_MAX_TARGET = 68;
const MIN_LOGO_SCALE = 1.25 * 1.25;
const R_MIN_A = 7 * MIN_LOGO_SCALE;
const GRAVEL_FLOORS = [5 * MIN_LOGO_SCALE] as const;
const BUBBLE_GAP = 2.5;

// Logo plate decisions are made from the transcoded RGBA raster, never from
// source markup. The annulus avoids transparent square corners while still
// distinguishing a full-bleed circular tile from a shaped mark.
const LOGO_ANNULUS_INNER_RADIUS = 0.72;
const LOGO_ANNULUS_OUTER_RADIUS = 0.94;
const LOGO_OPAQUE_ALPHA_FLOOR = 0.9;
const LOGO_FULL_BLEED_OPAQUE_RATIO = 0.9;
const LOGO_VISIBLE_ALPHA_FLOOR = 0.1;
const LOGO_LIGHT_LUMINANCE_FLOOR = 0.82;
const LOGO_LIGHT_INK_RATIO = 0.7;
const LOGO_LIGHT_PLATE = "#d9e2ec";
const LOGO_DARK_PLATE = "#111a29";

// Only these codepoints are covered by all four embedded faces. Anything else
// falls through to a machine-dependent glyph and can visibly change the map.
const RENDERABLE_TEXT = /^[\x20-\x7e·–—°€£¥]*$/;
const unsupportedGlyphs = new Set<string>();

interface ApiCard {
  id: string;
  score: number | null;
  grade: string;
}

interface ReportCardsResponse {
  cards: ApiCard[];
  methodology: { version: string };
  asOfSec: number;
  publicationHealth?: unknown;
  updatedAt?: number;
}

interface StablecoinsResponse {
  peggedAssets: Array<{ id: string; symbol: string; circulating?: Record<string, number> }>;
}

interface PsiResponse {
  current: {
    score: number;
    band: ConditionBand;
    avg24h?: number;
    avg24hBand?: ConditionBand;
    computedAt: number;
  };
}

export type MapPsiBasis = "24H AVG" | "RAW";

export interface MapPsi {
  score: number;
  band: ConditionBand;
  basis: MapPsiBasis;
  computedAt: number;
}

interface FetchJsonResult {
  body: unknown;
  publicationStatus: string | null;
}

type Edition = "daily" | "monthly";

interface MapCoin {
  id: string;
  symbol: string;
  grade: string;
  score: number;
  tier: Tier;
  mcap: number;
}

export type LogoPlate = "none" | "light" | "dark";

export interface LogoRenderData {
  dataUri: string;
  plate: LogoPlate;
}

type SubgradeLane = "plus" | "base" | "minus";

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

async function fetchJson(apiPath: string, apiKey: string, baseUrl: string): Promise<FetchJsonResult> {
  const { url, headers } = buildMaintenanceApiRequest(apiPath, apiKey, baseUrl);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${apiPath} returned ${res.status}`);
  return {
    body: await res.json(),
    publicationStatus: res.headers.get("X-Safety-Score-Status")?.trim().toLowerCase() ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReportCardsResponse(payload: unknown): ReportCardsResponse {
  if (!isRecord(payload) || !Array.isArray(payload.cards)) {
    throw new Error("Report-card response is malformed — expected a cards array");
  }
  if (!isRecord(payload.methodology) || typeof payload.methodology.version !== "string" || payload.methodology.version.length === 0) {
    throw new Error("Report-card response is malformed — methodology.version is missing");
  }
  if (typeof payload.asOfSec !== "number" || !Number.isFinite(payload.asOfSec) || !Number.isInteger(payload.asOfSec)) {
    throw new Error("Report-card response is malformed — asOfSec must be a finite integer");
  }
  if (payload.updatedAt !== undefined && (typeof payload.updatedAt !== "number" || !Number.isFinite(payload.updatedAt))) {
    throw new Error("Report-card response is malformed — updatedAt must be finite when present");
  }

  const ids = new Set<string>();
  const cards: ApiCard[] = [];
  for (const [index, rawCard] of payload.cards.entries()) {
    if (!isRecord(rawCard)) throw new Error(`Report-card response is malformed — cards[${index}] is not an object`);
    const id = rawCard.id;
    if (typeof id !== "string" || id.length === 0) throw new Error(`Report-card response is malformed — cards[${index}].id is missing`);
    if (ids.has(id)) throw new Error(`Duplicate report-card id "${id}" — refusing to build an ambiguous map`);
    ids.add(id);

    const grade = rawCard.grade;
    if (typeof grade !== "string" || !VALID_CARD_GRADES.has(grade)) {
      throw new Error(`Unknown grade "${String(grade)}" for ${id} — the tier map (${TIER_ORDER.join("/")}) is out of date`);
    }
    const score = rawCard.score;
    if (grade === "NR") {
      if (score !== null) throw new Error(`Score/grade disagreement for ${id}: NR cards must have a null score`);
    } else {
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error(`Invalid score for ${id}: expected a finite value in the 0-100 range`);
      }
      const expectedGrade = scoreToGrade(score);
      if (expectedGrade !== grade) {
        throw new Error(`Score/grade disagreement for ${id}: score ${score} maps to ${expectedGrade}, not ${grade}`);
      }
    }
    cards.push({ id, score: score as number | null, grade });
  }

  return {
    cards,
    methodology: { version: payload.methodology.version },
    asOfSec: payload.asOfSec,
    ...(payload.publicationHealth !== undefined ? { publicationHealth: payload.publicationHealth } : {}),
    ...(payload.updatedAt !== undefined ? { updatedAt: payload.updatedAt } : {}),
  };
}

function parseStablecoinsResponse(payload: unknown): StablecoinsResponse {
  if (!isRecord(payload) || !Array.isArray(payload.peggedAssets)) {
    throw new Error("Stablecoin response is malformed — expected a peggedAssets array");
  }
  const ids = new Set<string>();
  const peggedAssets: StablecoinsResponse["peggedAssets"] = [];
  for (const [index, rawAsset] of payload.peggedAssets.entries()) {
    if (!isRecord(rawAsset)) throw new Error(`Stablecoin response is malformed — peggedAssets[${index}] is not an object`);
    const id = rawAsset.id;
    const symbol = rawAsset.symbol;
    if (typeof id !== "string" || id.length === 0 || typeof symbol !== "string" || symbol.length === 0) {
      throw new Error(`Stablecoin response is malformed — peggedAssets[${index}] needs id and symbol`);
    }
    if (ids.has(id)) throw new Error(`Duplicate stablecoin id "${id}" — refusing to build an ambiguous supply join`);
    ids.add(id);

    const rawCirculating = rawAsset.circulating;
    if (rawCirculating !== undefined && rawCirculating !== null) {
      if (!isRecord(rawCirculating)) throw new Error(`Stablecoin response is malformed — ${id}.circulating is not an object`);
      for (const [bucket, value] of Object.entries(rawCirculating)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`Invalid circulating supply for ${id}.${bucket} — expected a finite number`);
        }
        if (value < 0) {
          throw new Error(`Negative circulating supply for ${id}.${bucket} — refusing to render a net-negative asset`);
        }
      }
    }
    peggedAssets.push({
      id,
      symbol,
      ...(rawCirculating !== undefined && rawCirculating !== null
        ? { circulating: rawCirculating as Record<string, number> }
        : {}),
    });
  }
  return { peggedAssets };
}

export function parsePsiResponse(payload: unknown): PsiResponse {
  if (!isRecord(payload) || !isRecord(payload.current)) {
    throw new Error("PSI response is malformed — expected a current reading");
  }
  const { current } = payload;
  const validateScore = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`PSI response is malformed — ${field} must be finite and in the 0-100 range`);
    }
    return value;
  };
  const validateBand = (value: unknown, field: string): ConditionBand => {
    if (typeof value !== "string" || !Object.hasOwn(PSI_HEX_COLORS, value)) {
      throw new Error(`PSI response is malformed — ${field} is not a recognized condition band`);
    }
    return value as ConditionBand;
  };

  const score = validateScore(current.score, "current.score");
  const band = validateBand(current.band, "current.band");
  if (typeof current.computedAt !== "number" || !Number.isFinite(current.computedAt) || !Number.isInteger(current.computedAt)) {
    throw new Error("PSI response is malformed — current.computedAt must be a finite integer");
  }
  if ((current.avg24h === undefined) !== (current.avg24hBand === undefined)) {
    throw new Error("PSI response is malformed — current.avg24h and current.avg24hBand must appear together");
  }

  return {
    current: {
      score,
      band,
      ...(current.avg24h !== undefined
        ? {
            avg24h: validateScore(current.avg24h, "current.avg24h"),
            avg24hBand: validateBand(current.avg24hBand, "current.avg24hBand"),
          }
        : {}),
      computedAt: current.computedAt,
    },
  };
}

export function selectMapPsi(current: PsiResponse["current"]): MapPsi {
  return {
    score: current.avg24h ?? current.score,
    band: current.avg24hBand ?? current.band,
    basis: current.avg24h !== undefined ? "24H AVG" : "RAW",
    computedAt: current.computedAt,
  };
}

export function buildPsiSubtitle(psi: Pick<MapPsi, "score" | "band" | "basis">): string {
  return `PSI ${formatScore(psi.score)} · ${psi.band} · ${psi.basis}`;
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

/**
 * Missing logos still need a deterministic, readable presence mark. Keep the
 * displayed initial inside the embedded ASCII font contract even when the
 * source symbol is empty or made entirely of unsupported codepoints.
 */
function asciiInitial(text: string): string {
  const transliterated = text.replace(/₮/g, "T");
  const ascii = transliterated.match(/[A-Za-z0-9]/)?.[0];
  if (ascii) return ascii.toUpperCase();
  let hash = 0;
  for (const char of transliterated) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return String.fromCharCode(65 + (hash % 26));
}

// Grade-band score range projected from the methodology policy thresholds.
function tierRange(tier: Tier): string {
  const mins = GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) === tier).map((t) => t.min);
  const min = Math.min(...mins);
  const higher = GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) !== tier && t.min > min).map((t) => t.min);
  const max = higher.length > 0 ? Math.min(...higher) - 1 : 100;
  return `${min}–${max}`;
}

export function classifyLogoPlate(rgba: Uint8Array, width: number, height: number): LogoPlate {
  let annulusPixels = 0;
  let opaqueAnnulusPixels = 0;
  let visibleWeight = 0;
  let lightInkWeight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const alpha = rgba[index + 3] / 255;
      const normalizedX = (x + 0.5 - width / 2) / (width / 2);
      const normalizedY = (y + 0.5 - height / 2) / (height / 2);
      const normalizedRadius = Math.hypot(normalizedX, normalizedY);
      if (normalizedRadius >= LOGO_ANNULUS_INNER_RADIUS && normalizedRadius <= LOGO_ANNULUS_OUTER_RADIUS) {
        annulusPixels += 1;
        if (alpha >= LOGO_OPAQUE_ALPHA_FLOOR) opaqueAnnulusPixels += 1;
      }
      if (alpha < LOGO_VISIBLE_ALPHA_FLOOR) continue;
      const luminance = (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2]) / 255;
      visibleWeight += alpha;
      if (luminance >= LOGO_LIGHT_LUMINANCE_FLOOR) lightInkWeight += alpha;
    }
  }

  const opaqueAnnulusRatio = annulusPixels > 0 ? opaqueAnnulusPixels / annulusPixels : 0;
  if (opaqueAnnulusRatio >= LOGO_FULL_BLEED_OPAQUE_RATIO) return "light";
  const lightInkRatio = visibleWeight > 0 ? lightInkWeight / visibleWeight : 0;
  return lightInkRatio >= LOGO_LIGHT_INK_RATIO ? "dark" : "none";
}

export async function loadLogoDataUri(publicLogoPath: string, sizePx: number): Promise<LogoRenderData | null> {
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
    let raster: ReturnType<typeof sharp>;
    if (Math.abs(srcW / srcH - 1) <= 0.03) {
      raster = pipeline.resize(target, target, { fit: "cover" });
    } else {
      // A letterboxed source is already tangent to the inscribed circle at its
      // widest axis, so the inset only needs to cover anti-aliasing: at 8% the
      // hero bubble floated in a visible halo.
      const pad = Math.max(1, Math.round(target * 0.02));
      const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
      raster = pipeline
        .resize(target - pad * 2, target - pad * 2, { fit: "contain", background: transparent })
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: transparent });
    }
    const [png, sampled] = await Promise.all([
      raster.clone().png().toBuffer(),
      raster.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    return {
      dataUri: `data:image/png;base64,${png.toString("base64")}`,
      plate: classifyLogoPlate(sampled.data, sampled.info.width, sampled.info.height),
    };
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
  laneOffsetY: number;
  totalCount: number;
  totalMcap: number;
}

interface FitDiagnostic {
  tier: string;
  count: number;
  placed: number;
  radius: number;
  reason?: string;
}

function ellipseValue(x: number, y: number, rx: number, ry: number): number {
  return (x * x) / (rx * rx) + (y * y) / (ry * ry);
}

function approximateEllipsePerimeter(rx: number, ry: number): number {
  const h = ((rx - ry) ** 2) / ((rx + ry) ** 2);
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export function radiusForMcap(tier: Tier, mcap: number, k: number, gravelFloor: number): number {
  const floor = tier === "A" ? R_MIN_A : gravelFloor;
  return Math.max(floor, k * Math.sqrt(Math.max(mcap, 0)));
}

export type DemandOrbitZoneResult =
  | { ok: true; zones: Record<Tier, OrbitZone>; requiredThickness: Record<Tier, number> }
  | { ok: false; detail: string; requiredThickness: Record<Tier, number> };

/**
 * Allocate the bounded B-F radial span from the actual bubble footprint. The
 * area term accounts for census demand while 2r + BAND_SEMANTIC_MIN guarantees
 * a visually meaningful thickness around the largest mark in each band. The
 * bands are then stacked from the compact A core to the outer map bound; C
 * receives any remaining thickness because it carries the largest census.
 */
export function computeDemandOrbitZones(
  radiiByTier: Readonly<Record<Tier, readonly number[]>>,
  modifierLanesByTier: Readonly<Partial<Record<Tier, boolean>>> = {},
): DemandOrbitZoneResult {
  const baseThickness = Object.fromEntries(TIER_ORDER.map((tier) => [tier, 0])) as Record<Tier, number>;
  for (const tier of OUTER_TIERS) {
    const radii = radiiByTier[tier];
    if (radii.some((radius) => !Number.isFinite(radius) || radius < 0)) {
      return { ok: false, detail: `Band ${tier} has an invalid radius demand`, requiredThickness: baseThickness };
    }
    const footprint = radii.reduce((sum, radius) => sum + Math.PI * (radius + BUBBLE_GAP / 2) ** 2, 0);
    const baseline = BASE_ORBIT_ZONES[tier];
    const perimeter = approximateEllipsePerimeter(
      (baseline.innerRx + baseline.outerRx) / 2,
      (baseline.innerRy + baseline.outerRy) / 2,
    );
    const largestDiameter = radii.length > 0 ? Math.max(...radii) * 2 : 0;
    baseThickness[tier] = Math.max(
      BAND_SEMANTIC_MIN,
      largestDiameter + BAND_SEMANTIC_MIN,
      footprint / (perimeter * BAND_PACKING_EFFICIENCY) + BAND_SEMANTIC_MIN,
    );
  }

  const availableThickness = OUTER_RY - OUTER_INNER_RY - BAND_GAP_Y * (OUTER_TIERS.length - 1);
  const availableThicknessX = OUTER_RX - OUTER_INNER_RX - BAND_GAP_X * (OUTER_TIERS.length - 1);
  const baseTotal = OUTER_TIERS.reduce((sum, tier) => sum + baseThickness[tier], 0);
  if (baseTotal > availableThickness + 1e-9) {
    return {
      ok: false,
      detail: `Outer bands require ${baseTotal.toFixed(1)}px of short-axis thickness but only ${availableThickness.toFixed(1)}px is available`,
      requiredThickness: baseThickness,
    };
  }

  for (let laneStep = SUBGRADE_LANE_DEGRADE_STEPS; laneStep >= 0; laneStep--) {
    const laneScale = laneStep / SUBGRADE_LANE_DEGRADE_STEPS;
    const requiredThickness = { ...baseThickness };
    for (const tier of OUTER_TIERS) {
      if (modifierLanesByTier[tier]) {
        const demandFactor = Math.min(
          SUBGRADE_LANE_MAX_DEMAND_FACTOR,
          Math.sqrt(radiiByTier[tier].length / SUBGRADE_LANE_REFERENCE_POPULATION),
        );
        requiredThickness[tier] += SUBGRADE_LANE_TARGET_Y * 2 * demandFactor * laneScale;
      }
    }
    const requiredTotal = OUTER_TIERS.reduce((sum, tier) => sum + requiredThickness[tier], 0);
    if (requiredTotal > availableThickness + 1e-9) continue;

    // Consume the entire short-axis budget. The surplus is not empty padding:
    // it widens C, whose census and modifier lanes need the most radial room.
    const allocatedThickness = { ...requiredThickness };
    allocatedThickness.C += availableThickness - requiredTotal;
    const allocatedTotal = OUTER_TIERS.reduce((sum, tier) => sum + allocatedThickness[tier], 0);
    const xScale = availableThicknessX / allocatedTotal;
    const zones = { A: { ...BASE_ORBIT_ZONES.A } } as Record<Tier, OrbitZone>;
    let innerRx = OUTER_INNER_RX;
    let innerRy = OUTER_INNER_RY;
    for (const [index, tier] of OUTER_TIERS.entries()) {
      const thicknessY = allocatedThickness[tier];
      const thicknessX = thicknessY * xScale;
      const isLast = index === OUTER_TIERS.length - 1;
      zones[tier] = {
        innerRx,
        innerRy,
        outerRx: isLast ? OUTER_RX : innerRx + thicknessX,
        outerRy: isLast ? OUTER_RY : innerRy + thicknessY,
      };
      innerRx += thicknessX + BAND_GAP_X;
      innerRy += thicknessY + BAND_GAP_Y;
    }
    return { ok: true, zones, requiredThickness };
  }
  return { ok: false, detail: "Outer bands cannot retain their bounded extents and semantic gaps", requiredThickness: baseThickness };
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

export function centerHeroPair(leftRadius: number, rightRadius: number): readonly [number, number] {
  const distance = leftRadius + rightRadius + BUBBLE_GAP;
  const leftArea = leftRadius ** 2;
  const rightArea = rightRadius ** 2;
  const totalArea = leftArea + rightArea;
  return [
    GALAXY_CX - distance * rightArea / totalArea,
    GALAXY_CX + distance * leftArea / totalArea,
  ];
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
  if (radii.length === 1) {
    return [{ x: GALAXY_CX + orbitRx * Math.cos(phase), y: GALAXY_CY + orbitRy * Math.sin(phase) }];
  }

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

export function subgradeLaneForGrade(grade: string): SubgradeLane {
  if (grade.endsWith("+")) return "plus";
  if (grade.endsWith("-")) return "minus";
  return "base";
}

function subgradeLaneDirection(grade: string): -1 | 0 | 1 {
  const lane = subgradeLaneForGrade(grade);
  return lane === "plus" ? -1 : lane === "minus" ? 1 : 0;
}

function interleaveSubgradeLanes(coins: readonly MapCoin[]): MapCoin[] {
  const laneOrder: readonly SubgradeLane[] = ["plus", "base", "minus"];
  const buckets = new Map(laneOrder.map((lane) => [
    lane,
    coins.filter((coin) => subgradeLaneForGrade(coin.grade) === lane),
  ]));
  const populated = laneOrder.filter((lane) => buckets.get(lane)!.length > 0);
  if (populated.length <= 1) return [...coins];

  // Weighted fair queuing keeps each modifier population present throughout
  // the full turn instead of exhausting the smallest bucket into a bare arc.
  // Bucket order remains supply order; laneOrder is the stable tie-break.
  const weights = new Map(populated.map((lane) => [lane, buckets.get(lane)!.length]));
  const deficits = new Map(populated.map((lane) => [lane, 0]));
  const used = new Map(populated.map((lane) => [lane, 0]));
  const result: MapCoin[] = [];
  while (result.length < coins.length) {
    for (const lane of populated) deficits.set(lane, deficits.get(lane)! + weights.get(lane)!);
    const lane = populated
      .filter((candidate) => used.get(candidate)! < weights.get(candidate)!)
      .sort((a, b) => deficits.get(b)! - deficits.get(a)! || laneOrder.indexOf(a) - laneOrder.indexOf(b))[0]!;
    const index = used.get(lane)!;
    result.push(buckets.get(lane)![index]);
    used.set(lane, index + 1);
    deficits.set(lane, deficits.get(lane)! - coins.length);
  }
  return result;
}

export interface SubgradeLanePlacement {
  centers: Array<{ x: number; y: number }>;
  offsetY: number;
}

function packSubgradeLaneOrbit(
  radii: readonly number[],
  directions: readonly (-1 | 0 | 1)[],
  orbitRx: number,
  orbitRy: number,
  offsetX: number,
  offsetY: number,
  referencePhase: number,
): Array<{ x: number; y: number }> | null {
  const point = (index: number, theta: number) => ({
    x: GALAXY_CX + (orbitRx + directions[index] * offsetX) * Math.cos(theta),
    y: GALAXY_CY + (orbitRy + directions[index] * offsetY) * Math.sin(theta),
  });
  const requiredGap = (from: number, to: number, theta: number): number | null => {
    const start = point(from, theta);
    const requiredDistance = radii[from] + radii[to] + BUBBLE_GAP;
    let high = Math.PI / 512;
    while (high <= Math.PI / 2 && Math.hypot(start.x - point(to, theta + high).x, start.y - point(to, theta + high).y) < requiredDistance) {
      high *= 2;
    }
    if (high > Math.PI / 2) return null;
    let low = 0;
    for (let iteration = 0; iteration < 32; iteration++) {
      const mid = (low + high) / 2;
      const candidate = point(to, theta + mid);
      if (Math.hypot(start.x - candidate.x, start.y - candidate.y) < requiredDistance) low = mid;
      else high = mid;
    }
    return high;
  };

  for (let phaseStep = 0; phaseStep < SUBGRADE_LANE_PACK_PHASES; phaseStep++) {
    const phase = referencePhase + (phaseStep / SUBGRADE_LANE_PACK_PHASES) * Math.PI * 2;
    const gaps: number[] = [];
    let theta = phase;
    let complete = true;
    for (let index = 0; index < radii.length - 1; index++) {
      const gap = requiredGap(index, index + 1, theta);
      if (gap == null) {
        complete = false;
        break;
      }
      gaps.push(gap);
      theta += gap;
    }
    if (!complete) continue;
    const closingGap = requiredGap(radii.length - 1, 0, theta);
    if (closingGap == null) continue;
    const requiredAngle = theta + closingGap - phase;
    if (requiredAngle > Math.PI * 2) continue;
    const slack = (Math.PI * 2 - requiredAngle) / radii.length;
    const placed: Array<{ x: number; y: number }> = [];
    theta = phase;
    for (let index = 0; index < radii.length; index++) {
      placed.push(point(index, theta));
      if (index < gaps.length) theta += gaps[index] + slack;
    }
    let overlaps = false;
    for (let i = 0; i < placed.length && !overlaps; i++) {
      for (let j = 0; j < i; j++) {
        if (bubblesOverlap(
          { cx: placed[i].x, cy: placed[i].y, r: radii[i] },
          { cx: placed[j].x, cy: placed[j].y, r: radii[j] },
        )) {
          overlaps = true;
          break;
        }
      }
    }
    if (!overlaps) return placed;
  }
  return null;
}

export function placeSubgradeRadialLanes(
  centers: readonly { x: number; y: number }[],
  radii: readonly number[],
  grades: readonly string[],
  zone: OrbitZone,
  occupied: readonly Pick<Bubble, "cx" | "cy" | "r">[] = [],
): SubgradeLanePlacement | null {
  if (centers.length !== radii.length || centers.length !== grades.length) return null;
  const orbitRx = (zone.innerRx + zone.outerRx) / 2;
  const orbitRy = (zone.innerRy + zone.outerRy) / 2;
  const halfX = (zone.outerRx - zone.innerRx) / 2;
  const halfY = (zone.outerRy - zone.innerRy) / 2;
  const directions = grades.map(subgradeLaneDirection);
  if (directions.every((direction) => direction === 0)) return { centers: [...centers], offsetY: 0 };

  const modifierClearances = radii
    .map((radius, index) => directions[index] === 0 ? Number.POSITIVE_INFINITY : halfY - radius - BUBBLE_GAP / 2);
  const boundedTarget = Math.max(0, Math.min(SUBGRADE_LANE_TARGET_Y, ...modifierClearances));
  const first = centers[0];
  const referencePhase = Math.atan2((first.y - GALAXY_CY) / orbitRy, (first.x - GALAXY_CX) / orbitRx);
  for (let step = SUBGRADE_LANE_DEGRADE_STEPS; step > 0; step--) {
    const offsetY = boundedTarget * (step / SUBGRADE_LANE_DEGRADE_STEPS);
    const offsetX = halfY > 0 ? offsetY * (halfX / halfY) : 0;
    const placed = packSubgradeLaneOrbit(radii, directions, orbitRx, orbitRy, offsetX, offsetY, referencePhase);
    if (!placed) continue;
    let valid = true;
    for (let i = 0; i < placed.length && valid; i++) {
      if (!circleFitsOrbit(zone, placed[i].x, placed[i].y, radii[i])) {
        valid = false;
        break;
      }
      const bubble = { cx: placed[i].x, cy: placed[i].y, r: radii[i] };
      if (occupied.some((other) => bubblesOverlap(bubble, other))) {
        valid = false;
        break;
      }
      for (let j = 0; j < i; j++) {
        if (bubblesOverlap(bubble, { cx: placed[j].x, cy: placed[j].y, r: radii[j] })) {
          valid = false;
          break;
        }
      }
    }
    if (valid) return { centers: placed, offsetY };
  }

  // Angular coverage is invariant. If no separated radial-lane arrangement
  // fits, collapse the band onto the already-even centerline rather than
  // consuming its distributed slack and leaving a bare arc.
  for (let i = 0; i < centers.length; i++) {
    if (!circleFitsOrbit(zone, centers[i].x, centers[i].y, radii[i])) return null;
    const bubble = { cx: centers[i].x, cy: centers[i].y, r: radii[i] };
    if (occupied.some((other) => bubblesOverlap(bubble, other))) return null;
    for (let j = 0; j < i; j++) {
      if (bubblesOverlap(bubble, { cx: centers[j].x, cy: centers[j].y, r: radii[j] })) return null;
    }
  }
  return { centers: [...centers], offsetY: 0 };
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
  const radiusOf = (coin: MapCoin) => radiusForMcap(coin.tier, coin.mcap, k, gravelFloor);
  const radiiByTier = Object.fromEntries(TIER_ORDER.map((tier) => [
    tier,
    graded.filter((coin) => coin.tier === tier).map(radiusOf),
  ])) as Record<Tier, number[]>;
  const modifierLanesByTier = Object.fromEntries(TIER_ORDER.map((tier) => [
    tier,
    graded.some((coin) => coin.tier === tier && subgradeLaneForGrade(coin.grade) !== "base"),
  ])) as Record<Tier, boolean>;
  const zoneResult = computeDemandOrbitZones(radiiByTier, modifierLanesByTier);
  if (!zoneResult.ok) {
    diag?.push({ tier: "B-F", count: OUTER_TIERS.reduce((sum, tier) => sum + radiiByTier[tier].length, 0), placed: 0, radius: Math.max(...OUTER_TIERS.flatMap((tier) => radiiByTier[tier]), 0), reason: zoneResult.detail });
    return null;
  }

  const bands: BandLayout[] = [];
  const placedAcrossTiers: Bubble[] = [];
  for (const tier of TIER_ORDER) {
    // Supply order is retained inside each published sub-grade. Outer tiers
    // interleave those discrete populations around the guide so adjacent
    // marks can separate radially without turning angle into another metric.
    const supplySorted = graded
      .filter((coin) => coin.tier === tier)
      .sort((a, b) => b.mcap - a.mcap || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const coins = tier === "A" ? supplySorted : interleaveSubgradeLanes(supplySorted);
    if (coins.length === 0) continue;
    const zone = zoneResult.zones[tier];
    const bubbles: Bubble[] = [];
    let laneOffsetY = 0;
    const radii = coins.map(radiusOf);
    if (radii.some((radius) => !Number.isFinite(radius))) {
      const index = radii.findIndex((radius) => !Number.isFinite(radius));
      throw new Error(`Non-finite radius for ${coins[index].id} (mcap=${coins[index].mcap})`);
    }
    if (tier === "A") {
      const heroPairX = radii.length >= 2 ? centerHeroPair(radii[0], radii[1]) : null;
      for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        const r = radii[i];
        // The two supply leaders are tangent across an area-weighted centre,
        // so their unequal circles read as one balanced hero cluster. The
        // remaining assets keep their explicit outward escargot districts.
        const candidates = heroPairX && i < 2
          ? [{ x: heroPairX[i], y: GALAXY_CY }]
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
      const packedCenters = packEllipticalOrbit(radii, orbitRx, orbitRy, TIER_ORDER.indexOf(tier) * 0.47 - Math.PI / 2);
      const lanePlacement = packedCenters
        ? placeSubgradeRadialLanes(packedCenters, radii, coins.map((coin) => coin.grade), zone, placedAcrossTiers)
        : null;
      if (!lanePlacement) {
        diag?.push({ tier, count: coins.length, placed: 0, radius: Math.max(...radii) });
        return null;
      }
      const centers = lanePlacement.centers;
      laneOffsetY = lanePlacement.offsetY;
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
      laneOffsetY,
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

export interface AngularDistribution {
  count: number;
  meanGap: number;
  maxGap: number;
}

export function measureAngularDistribution(orbit: CompositionOrbit): AngularDistribution | null {
  if (orbit.zone.innerRx <= 0 || orbit.bubbles.length < 2) return null;
  const guideRx = (orbit.zone.innerRx + orbit.zone.outerRx) / 2;
  const guideRy = (orbit.zone.innerRy + orbit.zone.outerRy) / 2;
  if (![guideRx, guideRy].every((value) => Number.isFinite(value) && value > 0)) return null;
  const angles = orbit.bubbles
    .map((bubble) => Math.atan2((bubble.cy - GALAXY_CY) / guideRy, (bubble.cx - GALAXY_CX) / guideRx))
    .sort((a, b) => a - b);
  if (!angles.every(Number.isFinite)) return null;
  const fullTurn = Math.PI * 2;
  const gaps = angles.map((angle, index) => {
    const next = angles[(index + 1) % angles.length];
    return ((next - angle + fullTurn) % fullTurn);
  });
  return {
    count: angles.length,
    meanGap: fullTurn / angles.length,
    maxGap: Math.max(...gaps),
  };
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
      if (bubble.cy - bubble.r < bodyTop) {
        violations.push(`bubble ${bubble.id}: crosses the ${HEADER_BODY_GAP}px header clearance`);
      }
      allBubbles.push(bubble);
    }
    const angularDistribution = measureAngularDistribution(orbit);
    if (
      angularDistribution &&
      angularDistribution.maxGap > angularDistribution.meanGap * MAX_ANGULAR_GAP_MEAN_MULTIPLE
    ) {
      const toDegrees = 180 / Math.PI;
      violations.push(
        `orbit ${orbit.tier}: angular gap ${
          (angularDistribution.maxGap * toDegrees).toFixed(1)
        }deg exceeds ${MAX_ANGULAR_GAP_MEAN_MULTIPLE}x mean ${
          (angularDistribution.meanGap * toDegrees).toFixed(1)
        }deg`,
      );
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

function annotationSceneForBands(bands: readonly BandLayout[], annotations: readonly PlacedAnnotation[] = []): AnnotationScene {
  const circles = bands.flatMap((band) => band.bubbles.map((bubble) => ({
    id: bubble.coin.id,
    cx: bubble.cx,
    cy: bubble.cy,
    r: bubble.r,
    role: "bubble" as const,
  })));
  return {
    frame: ANNOTATION_FRAME,
    circles,
    rectangles: [{ id: "masthead-lockup", ...MASTHEAD_LOCKUP, role: "obstacle" }],
    lines: [
      { id: "header-rule", x1: MARGIN_X, y1: HEADER_RULE_Y, x2: WIDTH - MARGIN_X, y2: HEADER_RULE_Y, role: "decoration" },
      { id: "footer-rule", x1: MARGIN_X, y1: FOOTER_RULE_Y, x2: WIDTH - MARGIN_X, y2: FOOTER_RULE_Y, role: "decoration" },
    ],
    orbits: bands.map((band) => ({
      id: `band-${band.tier}`,
      cx: GALAXY_CX,
      cy: GALAXY_CY,
      ...band.zone,
      circleIds: band.bubbles.map((bubble) => bubble.coin.id),
    })),
    reservedRegions: [
      { id: "chart-key-panel", ...CHART_KEY_PANEL, allowedClassIds: ["chart-key"] },
      { id: "footer-panel", ...FOOTER_PANEL, allowedClassIds: ["footer"] },
    ],
    annotations,
  };
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

export function renderPsiStatus(psi: MapPsi, x: number, baselineY: number): string {
  const color = PSI_HEX_COLORS[psi.band];
  const score = formatScore(psi.score);
  return [
    `<g data-psi-status="true" data-psi-band="${psi.band}" data-psi-score="${score}" data-psi-basis="${psi.basis}" data-psi-color="${color}" data-psi-computed-at="${psi.computedAt}">`,
    `<circle data-psi-band-marker="true" cx="${x + 4}" cy="${baselineY - 3.5}" r="3.5" fill="${color}"/>`,
    svgText({ x: x + 14, y: baselineY, size: 10.5, text: buildPsiSubtitle(psi), weight: 750, fill: INK, spacing: "0.25" }),
    `</g>`,
  ].join("");
}

interface StampCopy {
  eyebrow: string;
  headline: string;
  issue: string | null;
}

interface FloorMcapByTier {
  a: number;
  other: number;
}

interface ChartKeyTier {
  tier: Tier;
  range: string;
  count: number;
  share: number;
  mcap: number;
}

interface ChartKeyData {
  tiers: readonly ChartKeyTier[];
  totalMcap: number;
  floorMcapByTier: FloorMcapByTier;
  floorRadiusByTier: { a: number; other: number };
  lanes: SubgradeLaneSummary;
}

interface SubgradeLaneSummary {
  counts: Record<SubgradeLane, number>;
  splitTiers: Tier[];
  baseOnlyTiers: Tier[];
}

export function supplyMassBarWidth(tierMcap: number, totalMcap: number, trackWidth: number): number {
  return totalMcap > 0 ? (tierMcap / totalMcap) * trackWidth : 0;
}

function publicationAnnotationRequests(): Annotation[] {
  const candidate = (id: string, x: number, y: number) => [{
    id: `${id}:fixed`,
    anchor: { x, y },
    horizontal: "start" as const,
    vertical: "top" as const,
  }];
  return [
    {
      id: "grade-key",
      classId: "chart-key",
      priority: 300,
      required: true,
      bounds: { w: CHART_KEY_PANEL.w - 8, h: 20 },
      candidates: candidate("grade-key", CHART_KEY_PANEL.x + 4, CHART_KEY_PANEL.y + 2),
    },
    {
      id: "supply-mass-rail",
      classId: "chart-key",
      priority: 290,
      required: true,
      bounds: { w: CHART_KEY_PANEL.w - 8, h: 15 },
      candidates: candidate("supply-mass-rail", CHART_KEY_PANEL.x + 4, CHART_KEY_PANEL.y + 26),
    },
    {
      id: "footer-encoding",
      classId: "footer",
      priority: 270,
      required: true,
      bounds: { w: FOOTER_PANEL.w, h: 16 },
      candidates: candidate("footer-encoding", FOOTER_PANEL.x, FOOTER_PANEL.y),
    },
  ];
}

function annotationById(annotations: readonly PlacedAnnotation[], id: string): PlacedAnnotation {
  const annotation = annotations.find((item) => item.id === id);
  if (!annotation) throw new Error(`Required annotation ${id} was not returned by the planner`);
  return annotation;
}

function annotationGroup(annotation: PlacedAnnotation, body: string): string {
  const { x, y, w, h } = annotation.bounds;
  return `<g data-annotation-id="${annotation.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none"/>${body}</g>`;
}

function renderChartKey(annotations: readonly PlacedAnnotation[], data: ChartKeyData): string {
  const parts: string[] = [];
  parts.push(`<rect x="${CHART_KEY_PANEL.x}" y="${CHART_KEY_PANEL.y}" width="${CHART_KEY_PANEL.w}" height="${CHART_KEY_PANEL.h}" rx="5" fill="#08101d" fill-opacity="0.94" stroke="${RULE}" stroke-width="1"/>`);

  const grade = annotationById(annotations, "grade-key");
  const gradeParts: string[] = [];
  const gradeX = grade.bounds.x + 4;
  const gradeY = grade.bounds.y;
  const gradeStartX = gradeX + 108;
  const gradeCellWidth = 123;
  gradeParts.push(svgText({ x: gradeX, y: gradeY + 14, size: 10.5, text: "inner -> safer", weight: 700, fill: FROST_BLUE, spacing: "0.4" }));
  for (const [index, tier] of data.tiers.entries()) {
    const x = gradeStartX + index * gradeCellWidth;
    const dasharray = BAND_GUIDE_DASHARRAY[tier.tier];
    gradeParts.push(`<line x1="${x}" y1="${gradeY + 7}" x2="${x + 14}" y2="${gradeY + 7}" stroke="${TIER_COLORS[tier.tier]}" stroke-width="2"${dasharray ? ` stroke-dasharray="${dasharray}" stroke-linecap="round"` : ""}/>`);
    gradeParts.push(svgText({ x: x + 20, y: gradeY + 14, size: 11, text: tier.tier, weight: 750, fill: TIER_COLORS[tier.tier] }));
    gradeParts.push(svgText({ x: x + 38, y: gradeY + 14, size: 10.5, text: tier.range, weight: 650, fill: INK }));
  }
  parts.push(annotationGroup(grade, gradeParts.join("")));

  const rail = annotationById(annotations, "supply-mass-rail");
  const railParts: string[] = [];
  const railX = rail.bounds.x + 4;
  const railY = rail.bounds.y;
  const aTier = data.tiers.find((tier) => tier.tier === "A");
  if (!aTier) throw new Error("Chart key is missing its A tier");
  const trackX = railX + 218;
  const trackWidth = 494;
  railParts.push(svgText({ x: railX, y: railY + 11, size: 10.5, text: `A: ${aTier.count} COINS / ${aTier.share.toFixed(1)}% OF SUPPLY`, weight: 700, fill: INK_SECONDARY, spacing: "0.2" }));
  railParts.push(`<rect x="${trackX}" y="${railY + 3}" width="${trackWidth}" height="7" rx="3.5" fill="#202a3b"/>`);
  let segmentX = trackX;
  for (const tier of data.tiers) {
    const barWidth = supplyMassBarWidth(tier.mcap, data.totalMcap, trackWidth);
    railParts.push(`<rect data-mass-tier="${tier.tier}" data-track-width="${trackWidth}" data-tier-mcap="${tier.mcap}" data-total-mcap="${data.totalMcap}" x="${segmentX}" y="${railY + 3}" width="${barWidth}" height="7" fill="${TIER_COLORS[tier.tier]}"/>`);
    segmentX += barWidth;
  }
  parts.push(annotationGroup(rail, railParts.join("")));

  return parts.join("\n");
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
  psi,
  methodologyVersion,
  gradedCount,
  asOfSec,
  edition,
  issue,
  floorMcapByTier,
  chartKey,
  annotations,
}: {
  bands: readonly BandLayout[];
  logos: ReadonlyMap<string, LogoRenderData | null>;
  brandMark: string;
  psi: MapPsi;
  methodologyVersion: string;
  gradedCount: number;
  asOfSec: number;
  edition: Edition;
  issue: number | null;
  floorMcapByTier: FloorMcapByTier;
  chartKey: ChartKeyData;
  annotations: readonly PlacedAnnotation[];
}): string {
  const asOf = new Date(asOfSec * 1000);
  const stamp = stampCopy(edition, issue, asOf);

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

  // The enlarged brand mark, wordmark, divider and title form one measured
  // lockup; the 48px chart grammar rail remains clear.
  const markSize = 72;
  const markX = MARGIN_X;
  const markY = 8;
  const markCx = markX + markSize / 2;
  const beaconHalfWidth = markSize * 0.0625;
  const wordmarkX = markX + markSize + 12;
  const dividerX = 244;
  const titleX = 268;
  const titleBaselineY = 50;
  const kickerX = 270;
  const kickerBaselineY = 72;
  parts.push(`<g data-masthead-lockup="true" data-lockup-x="${MASTHEAD_LOCKUP.x}" data-lockup-y="${MASTHEAD_LOCKUP.y}" data-lockup-w="${MASTHEAD_LOCKUP.w}" data-lockup-h="${MASTHEAD_LOCKUP.h}" data-mark-size="${markSize}" data-mark-x="${markX}" data-mark-y="${markY}" data-wordmark-x="${wordmarkX}" data-divider-x="${dividerX}" data-title-x="${titleX}" data-title-baseline-y="${titleBaselineY}" data-kicker-x="${kickerX}" data-kicker-baseline-y="${kickerBaselineY}" data-header-rule-y="${HEADER_RULE_Y}">`);
  parts.push(`<polygon points="${markCx - beaconHalfWidth},${markY + 1} ${markCx + beaconHalfWidth},${markY + 1} ${markCx + markSize * 0.025},4 ${markCx - markSize * 0.025},4" fill="${FROST_BLUE}"/>`);
  parts.push(`<image href="${brandMark}" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}"/>`);
  parts.push(svgText({ x: wordmarkX, y: 50, size: 22, text: "Pharos", font: "sans", weight: 700, spacing: "-0.3" }));
  parts.push(`<line x1="${dividerX}" y1="12" x2="${dividerX}" y2="76" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(svgText({ x: titleX, y: titleBaselineY, size: 34, text: "The Stablecoin Safety Map", font: "serif", weight: 500, spacing: "-0.5" }));
  if (stamp.issue) {
    parts.push(svgText({ x: 735, y: kickerBaselineY, size: 10.5, text: stamp.issue, weight: 700, fill: INK_SECONDARY, anchor: "end", spacing: "1.6" }));
  }
  parts.push(`</g>`);
  parts.push(renderChartKey(annotations, chartKey));
  parts.push(`<line x1="${MARGIN_X}" y1="${HEADER_RULE_Y}" x2="${WIDTH - MARGIN_X}" y2="${HEADER_RULE_Y}" stroke="${RULE}" stroke-width="1"/>`);

  // B–F get a quiet band guide from the zone centerline. The guide carries no
  // data-point or rank order, and A remains intentionally line-free.
  for (const band of bands) {
    if (band.tier === "A") continue;
    const rx = (band.zone.innerRx + band.zone.outerRx) / 2;
    const ry = (band.zone.innerRy + band.zone.outerRy) / 2;
    const color = TIER_COLORS[band.tier];
    const dasharray = BAND_GUIDE_DASHARRAY[band.tier];
    const pattern = dasharray ? ` stroke-dasharray="${dasharray}" stroke-linecap="round"` : "";
    parts.push(`<ellipse data-band-guide="${band.tier}" data-inner-rx="${band.zone.innerRx.toFixed(2)}" data-inner-ry="${band.zone.innerRy.toFixed(2)}" data-outer-rx="${band.zone.outerRx.toFixed(2)}" data-outer-ry="${band.zone.outerRy.toFixed(2)}" data-lane-offset-y="${band.laneOffsetY.toFixed(2)}" cx="${GALAXY_CX}" cy="${GALAXY_CY}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${color}" stroke-width="7" stroke-opacity="0.045"${pattern}/>`);
    parts.push(`<ellipse cx="${GALAXY_CX}" cy="${GALAXY_CY}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.15" stroke-opacity="0.24"${pattern}/>`);
  }

  // Bubbles: rasterized, circle-clipped logos. Recognizable transparent marks
  // sit bare on the field; plates and floor-sized marks retain the grade rim.
  for (const band of bands) {
    const color = TIER_COLORS[band.tier];
    parts.push(`<g data-band-zone="${band.tier}" data-inner-rx="${band.zone.innerRx.toFixed(2)}" data-inner-ry="${band.zone.innerRy.toFixed(2)}" data-outer-rx="${band.zone.outerRx.toFixed(2)}" data-outer-ry="${band.zone.outerRy.toFixed(2)}" data-lane-offset-y="${band.laneOffsetY.toFixed(2)}">`);
    for (const bubble of band.bubbles) {
      const { coin, cx, cy, r } = bubble;
      const logo = logos.get(coin.id) ?? null;
      const floorRadius = band.tier === "A" ? chartKey.floorRadiusByTier.a : chartKey.floorRadiusByTier.other;
      const showGradeRim = logo?.plate !== "none" || r <= floorRadius + 1e-6;
      const ringWidth = showGradeRim ? (r >= 10 ? 2.2 : 1.3) : 0;
      const innerR = ringWidth > 0 ? Math.max(r - ringWidth, r * 0.68) : r;
      if (logo) {
        const size = innerR * 2;
        if (logo.plate !== "none") {
          const plateColor = logo.plate === "dark" ? LOGO_DARK_PLATE : LOGO_LIGHT_PLATE;
          parts.push(`<circle data-logo-plate="${coin.id}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${innerR.toFixed(1)}" fill="${plateColor}"/>`);
        }
        parts.push(
          `<g transform="translate(${(cx - innerR).toFixed(1)} ${(cy - innerR).toFixed(1)})"><image data-logo-id="${coin.id}" data-plate="${logo.plate}" href="${logo.dataUri}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" clip-path="url(#bubble-clip)"/></g>`,
        );
      } else {
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${innerR.toFixed(1)}" fill="#07111f"/>`);
        parts.push(svgText({ x: cx, y: cy + r * 0.36, size: Math.max(Math.round(r * 0.9), 10.5), text: asciiInitial(coin.symbol), fill: INK, anchor: "middle", weight: 750 }));
      }
      if (showGradeRim) {
        parts.push(`<circle data-grade-rim="${coin.id}" data-grade="${coin.grade}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r - ringWidth / 2).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${ringWidth.toFixed(1)}"/>`);
      }
    }
    parts.push(`</g>`);
  }

  // Footer: PSI, encoding disclosure and screenshot-contestable provenance
  // share one compact baseline. The masthead remains the publication signature.
  parts.push(`<line x1="${MARGIN_X}" y1="${FOOTER_RULE_Y}" x2="${WIDTH - MARGIN_X}" y2="${FOOTER_RULE_Y}" stroke="${RULE}" stroke-width="1"/>`);
  const encoding = annotationById(annotations, "footer-encoding");
  const captureTime = asOf.toISOString().slice(0, 16).replace("T", " ");
  const provenanceText = [
    `Captured ${captureTime} UTC`,
    `Methodology v${methodologyVersion}`,
    `${gradedCount} graded`,
  ].join(" · ");
  parts.push(annotationGroup(encoding, [
    renderPsiStatus(psi, encoding.bounds.x + 4, encoding.bounds.y + 12),
    svgText({
      x: encoding.bounds.x + 208,
      y: encoding.bounds.y + 12,
      size: 11.5,
      text: `· Area tracks supply above ~${formatUsdCompact(floorMcapByTier.a)} (A) / ~${formatUsdCompact(floorMcapByTier.other)} (B-F); below = marker`,
      fill: INK,
    }),
    svgText({ x: encoding.bounds.x + encoding.bounds.w - 4, y: encoding.bounds.y + 12, size: 10.5, text: provenanceText, fill: INK_SECONDARY, anchor: "end" }),
  ].join("")));
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

async function validateRenderedAnnotations(
  page: Page,
  scene: AnnotationScene,
  planned: readonly PlacedAnnotation[],
): Promise<void> {
  const rendered = await page.evaluate(() => Array.from(document.querySelectorAll<SVGGElement>("g[data-annotation-id]")).map((node) => {
    const box = node.getBBox();
    return { id: node.dataset.annotationId ?? "", x: box.x, y: box.y, w: box.width, h: box.height };
  }));
  const renderedById = new Map(rendered.map((item) => [item.id, item]));
  if (renderedById.size !== planned.length) {
    throw new Error(`Rendered annotation count ${renderedById.size} does not match planned count ${planned.length}`);
  }
  const tolerance = 0.5;
  const masthead = await page.evaluate(() => {
    const node = document.querySelector<SVGGElement>("g[data-masthead-lockup]");
    if (!node) return null;
    const box = node.getBBox();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  });
  if (!masthead) throw new Error("Rendered masthead lockup is missing");
  if (
    masthead.x < MASTHEAD_LOCKUP.x - tolerance || masthead.y < MASTHEAD_LOCKUP.y - tolerance ||
    masthead.x + masthead.w > MASTHEAD_LOCKUP.x + MASTHEAD_LOCKUP.w + tolerance ||
    masthead.y + masthead.h > MASTHEAD_LOCKUP.y + MASTHEAD_LOCKUP.h + tolerance
  ) {
    throw new Error(
      `Rendered masthead escaped its reserved bounds (${masthead.x.toFixed(1)},${masthead.y.toFixed(1)} ` +
      `${masthead.w.toFixed(1)}x${masthead.h.toFixed(1)} vs ${MASTHEAD_LOCKUP.x},${MASTHEAD_LOCKUP.y} ` +
      `${MASTHEAD_LOCKUP.w}x${MASTHEAD_LOCKUP.h})`,
    );
  }
  if (intersects(masthead, CHART_KEY_PANEL)) {
    throw new Error("Rendered masthead collides with the compact chart-key rail");
  }
  const measured = planned.map((annotation) => {
    const box = renderedById.get(annotation.id);
    if (!box) throw new Error(`Rendered annotation ${annotation.id} is missing`);
    const expected = annotation.bounds;
    if (
      box.x < expected.x - tolerance || box.y < expected.y - tolerance ||
      box.x + box.w > expected.x + expected.w + tolerance ||
      box.y + box.h > expected.y + expected.h + tolerance
    ) {
      throw new Error(
        `Rendered annotation ${annotation.id} escaped its planned bounds ` +
        `(${box.x.toFixed(1)},${box.y.toFixed(1)} ${box.w.toFixed(1)}x${box.h.toFixed(1)} vs ` +
        `${expected.x.toFixed(1)},${expected.y.toFixed(1)} ${expected.w.toFixed(1)}x${expected.h.toFixed(1)})`,
      );
    }
    return { ...annotation, bounds: { x: box.x, y: box.y, w: box.w, h: box.h } };
  });
  const violations = validateAnnotationScene({ ...scene, annotations: measured }, {
    bubbleGap: BUBBLE_GAP,
    labelGap: 1,
    leaderGap: 1,
  });
  if (violations.length > 0) {
    throw new Error(`Rendered annotation validation failed:\n  ${violations.slice(0, 20).map((item) => item.message).join("\n  ")}`);
  }
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

function summarizeMapCoins(coins: readonly MapCoin[]): TierSummary[] {
  const totalMcap = coins.reduce((sum, coin) => sum + coin.mcap, 0);
  const byTier = new Map<Tier, MapCoin[]>(TIER_ORDER.map((tier) => [tier, coins.filter((coin) => coin.tier === tier)]));
  return TIER_ORDER.map((tier) => {
    const tierCoins = byTier.get(tier) ?? [];
    const tierMcap = tierCoins.reduce((sum, coin) => sum + coin.mcap, 0);
    return {
      tier,
      range: tierRange(tier),
      count: tierCoins.length,
      mcap: tierMcap,
      share: totalMcap > 0 ? (tierMcap / totalMcap) * 100 : 0,
      leaders: [...tierCoins]
        .sort((a, b) => b.mcap - a.mcap || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, 3)
        .map((coin) => ({ symbol: mapLabel(coin.symbol), score: coin.score, mcap: coin.mcap })),
    };
  });
}

function summarizeSubgradeLanes(coins: readonly MapCoin[]): SubgradeLaneSummary {
  const outerCoins = coins.filter((coin) => coin.tier !== "A");
  const counts: Record<SubgradeLane, number> = { plus: 0, base: 0, minus: 0 };
  for (const coin of outerCoins) counts[subgradeLaneForGrade(coin.grade)] += 1;
  const splitTiers: Tier[] = [];
  const baseOnlyTiers: Tier[] = [];
  for (const tier of OUTER_TIERS) {
    const lanes = new Set(outerCoins.filter((coin) => coin.tier === tier).map((coin) => subgradeLaneForGrade(coin.grade)));
    if (lanes.size > 1) splitTiers.push(tier);
    else if (lanes.size === 1 && lanes.has("base")) baseOnlyTiers.push(tier);
  }
  return { counts, splitTiers, baseOnlyTiers };
}

interface MapSummary {
  date: string;
  asOfSec: number;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcapUsd: number;
  floorMcapByTier: FloorMcapByTier;
  tiers: Array<{
    tier: Tier;
    range: string;
    count: number;
    mcapUsd: number;
    sharePct: number;
    leaders: Array<{ symbol: string; score: number; mcapUsd: number }>;
  }>;
}

function buildMapSummary({
  date,
  asOfSec,
  methodologyVersion,
  gradedCount,
  notRatedCount,
  totalMcap,
  floorMcapByTier,
  tiers,
}: {
  date: string;
  asOfSec: number;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcap: number;
  floorMcapByTier: FloorMcapByTier;
  tiers: readonly TierSummary[];
}): MapSummary {
  return {
    date,
    asOfSec,
    methodologyVersion,
    gradedCount,
    notRatedCount,
    totalMcapUsd: totalMcap,
    floorMcapByTier,
    tiers: tiers.map((tier) => ({
      tier: tier.tier,
      range: tier.range,
      count: tier.count,
      mcapUsd: tier.mcap,
      sharePct: tier.share,
      leaders: tier.leaders.slice(0, 3).map((leader) => ({
        symbol: leader.symbol,
        score: leader.score,
        mcapUsd: leader.mcap,
      })),
    })),
  };
}

function buildAltText({
  tiers,
  lanes,
  psi,
  stampLabel,
  gradedCount,
  notRatedCount,
  totalMcap,
  floorMcapByTier,
  methodologyVersion,
  dateLabel,
}: {
  tiers: readonly TierSummary[];
  lanes: SubgradeLaneSummary;
  psi: MapPsi;
  stampLabel: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcap: number;
  floorMcapByTier: FloorMcapByTier;
  methodologyVersion: string;
  dateLabel: string;
}): string {
  const sentences = [
    `The Stablecoin Safety Map, ${stampLabel}, by Pharos.`,
    `${buildPsiSubtitle(psi)} at render time.`,
    `All ${gradedCount} graded stablecoins in five discrete grade bands: A at the centre, then B, C, D, and F outward; orbit = grade band, not a continuous score; bubble area tracks circulating supply above a per-tier minimum marker (A below ~${formatUsdCompact(floorMcapByTier.a)}, B-F below ~${formatUsdCompact(floorMcapByTier.other)}); assets below those thresholds share a fixed presence marker; ${formatUsdCompact(totalMcap)} mapped.`,
    `Published sub-grades set bounded radial lanes${lanes.splitTiers.length > 0 ? ` in ${lanes.splitTiers.join(" and ")}` : ""}: plus grades sit slightly inward, unmodified grades sit on the guide, and minus grades sit slightly outward${lanes.baseOnlyTiers.length > 0 ? `; ${lanes.baseOnlyTiers.join(" and ")} contain only unmodified grades and remain on the guide` : ""}.`,
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

interface SnapshotCoin {
  id: string;
  symbol: string;
  score: number;
  grade: string;
  mcap: number;
}

interface PreviousSnapshot {
  publicationStatus: string;
  counts: {
    graded: number;
    notRated: number;
    unjoined: number;
    missingLogos: number;
    byTier: Record<Tier, number>;
  };
  mapSummary: MapSummary;
  coins: SnapshotCoin[];
}

interface CurrentDeltaState {
  gradedCount: number;
  notRatedCount: number;
  missingLogoCount: number | null;
  coins: readonly SnapshotCoin[];
  tiers: readonly TierSummary[];
}

function malformedSnapshot(path: string, reason: string): never {
  throw new Error(`--previous-snapshot ${path} is malformed: ${reason} — refusing to skip the delta guard`);
}

function nonNegativeInteger(value: unknown, label: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) malformedSnapshot(path, `${label} must be a non-negative integer`);
  return value as number;
}

function parseSnapshotCoin(value: unknown, index: number, path: string): SnapshotCoin {
  if (!isRecord(value)) malformedSnapshot(path, `coins[${index}] is not an object`);
  if (typeof value.id !== "string" || value.id.length === 0) malformedSnapshot(path, `coins[${index}].id is missing`);
  if (typeof value.symbol !== "string" || value.symbol.length === 0) malformedSnapshot(path, `coins[${index}].symbol is missing`);
  if (typeof value.grade !== "string" || !SAFETY_GRADE_VALUES.includes(value.grade as (typeof SAFETY_GRADE_VALUES)[number])) {
    malformedSnapshot(path, `coins[${index}].grade is invalid`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    malformedSnapshot(path, `coins[${index}].score is outside 0-100`);
  }
  if (scoreToGrade(value.score) !== value.grade) malformedSnapshot(path, `coins[${index}] has a score/grade disagreement`);
  if (typeof value.mcap !== "number" || !Number.isFinite(value.mcap) || value.mcap < 0) {
    malformedSnapshot(path, `coins[${index}].mcap must be a non-negative finite number`);
  }
  return {
    id: value.id,
    symbol: value.symbol,
    score: value.score,
    grade: value.grade,
    mcap: value.mcap,
  };
}

function parseSnapshotMapSummary(value: unknown, path: string): MapSummary {
  if (!isRecord(value)) malformedSnapshot(path, "mapSummary is missing");
  if (typeof value.date !== "string" || value.date.length === 0) malformedSnapshot(path, "mapSummary.date is invalid");
  if (typeof value.asOfSec !== "number" || !Number.isFinite(value.asOfSec) || !Number.isInteger(value.asOfSec)) malformedSnapshot(path, "mapSummary.asOfSec is invalid");
  if (typeof value.methodologyVersion !== "string" || value.methodologyVersion.length === 0) malformedSnapshot(path, "mapSummary.methodologyVersion is invalid");
  const gradedCount = nonNegativeInteger(value.gradedCount, "mapSummary.gradedCount", path);
  const notRatedCount = nonNegativeInteger(value.notRatedCount, "mapSummary.notRatedCount", path);
  if (typeof value.totalMcapUsd !== "number" || !Number.isFinite(value.totalMcapUsd) || value.totalMcapUsd < 0) malformedSnapshot(path, "mapSummary.totalMcapUsd is invalid");
  if (!isRecord(value.floorMcapByTier)) malformedSnapshot(path, "mapSummary.floorMcapByTier is missing");
  if (typeof value.floorMcapByTier.a !== "number" || !Number.isFinite(value.floorMcapByTier.a) || value.floorMcapByTier.a <= 0) malformedSnapshot(path, "mapSummary.floorMcapByTier.a is invalid");
  if (typeof value.floorMcapByTier.other !== "number" || !Number.isFinite(value.floorMcapByTier.other) || value.floorMcapByTier.other <= 0) malformedSnapshot(path, "mapSummary.floorMcapByTier.other is invalid");
  if (!Array.isArray(value.tiers) || value.tiers.length !== TIER_ORDER.length) malformedSnapshot(path, "mapSummary.tiers must contain every grade band");

  const seenTiers = new Set<string>();
  const tiers: MapSummary["tiers"] = [];
  for (const [index, rawTier] of value.tiers.entries()) {
    if (!isRecord(rawTier) || typeof rawTier.tier !== "string" || !TIER_ORDER.includes(rawTier.tier as Tier)) {
      malformedSnapshot(path, `mapSummary.tiers[${index}].tier is invalid`);
    }
    const tier = rawTier.tier as Tier;
    if (seenTiers.has(tier)) malformedSnapshot(path, `mapSummary.tiers contains duplicate ${tier}`);
    seenTiers.add(tier);
    if (typeof rawTier.range !== "string" || rawTier.range.length === 0) malformedSnapshot(path, `mapSummary.tiers[${index}].range is invalid`);
    const count = nonNegativeInteger(rawTier.count, `mapSummary.tiers[${index}].count`, path);
    if (typeof rawTier.mcapUsd !== "number" || !Number.isFinite(rawTier.mcapUsd) || rawTier.mcapUsd < 0) malformedSnapshot(path, `mapSummary.tiers[${index}].mcapUsd is invalid`);
    if (typeof rawTier.sharePct !== "number" || !Number.isFinite(rawTier.sharePct) || rawTier.sharePct < 0) malformedSnapshot(path, `mapSummary.tiers[${index}].sharePct is invalid`);
    if (!Array.isArray(rawTier.leaders) || rawTier.leaders.length > 3) malformedSnapshot(path, `mapSummary.tiers[${index}].leaders is invalid`);
    const leaders = rawTier.leaders.map((rawLeader, leaderIndex) => {
      if (!isRecord(rawLeader) || typeof rawLeader.symbol !== "string" || rawLeader.symbol.length === 0) malformedSnapshot(path, `mapSummary.tiers[${index}].leaders[${leaderIndex}] is invalid`);
      if (typeof rawLeader.score !== "number" || !Number.isFinite(rawLeader.score) || rawLeader.score < 0 || rawLeader.score > 100) malformedSnapshot(path, `mapSummary.tiers[${index}].leaders[${leaderIndex}].score is invalid`);
      if (typeof rawLeader.mcapUsd !== "number" || !Number.isFinite(rawLeader.mcapUsd) || rawLeader.mcapUsd < 0) malformedSnapshot(path, `mapSummary.tiers[${index}].leaders[${leaderIndex}].mcapUsd is invalid`);
      return { symbol: rawLeader.symbol, score: rawLeader.score, mcapUsd: rawLeader.mcapUsd };
    });
    tiers.push({ tier, range: rawTier.range, count, mcapUsd: rawTier.mcapUsd, sharePct: rawTier.sharePct, leaders });
  }
  if (seenTiers.size !== TIER_ORDER.length) malformedSnapshot(path, "mapSummary.tiers is missing a grade band");
  return {
    date: value.date,
    asOfSec: value.asOfSec,
    methodologyVersion: value.methodologyVersion,
    gradedCount,
    notRatedCount,
    totalMcapUsd: value.totalMcapUsd,
    floorMcapByTier: { a: value.floorMcapByTier.a, other: value.floorMcapByTier.other },
    tiers,
  };
}

function readPreviousSnapshot(path: string): PreviousSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (err) {
    const code = isRecord(err) && typeof err.code === "string" ? err.code : null;
    if (code === "ENOENT") {
      console.warn(`[safety-score-map] Could not read --previous-snapshot ${path} (file not found) — delta guard skipped`);
      return null;
    }
    if (err instanceof SyntaxError) malformedSnapshot(path, "JSON could not be parsed");
    throw new Error(`[safety-score-map] Could not read --previous-snapshot ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) malformedSnapshot(path, "root must be an object");
  if (raw.publicationStatus !== "current") malformedSnapshot(path, "publicationStatus must be current");
  const counts = raw.counts;
  if (!isRecord(counts)) malformedSnapshot(path, "counts is missing");
  const graded = nonNegativeInteger(counts.graded, "counts.graded", path);
  const notRated = nonNegativeInteger(counts.notRated, "counts.notRated", path);
  const unjoined = nonNegativeInteger(counts.unjoined, "counts.unjoined", path);
  const missingLogos = nonNegativeInteger(counts.missingLogos, "counts.missingLogos", path);
  const rawByTier = counts.byTier;
  if (!isRecord(rawByTier)) malformedSnapshot(path, "counts.byTier is missing");
  const byTier = Object.fromEntries(TIER_ORDER.map((tier) => {
    if (!(tier in rawByTier)) malformedSnapshot(path, `counts.byTier.${tier} is missing`);
    return [tier, nonNegativeInteger(rawByTier[tier], `counts.byTier.${tier}`, path)];
  })) as Record<Tier, number>;
  if (Object.keys(rawByTier).some((tier) => !TIER_ORDER.includes(tier as Tier))) malformedSnapshot(path, "counts.byTier contains an unknown tier");
  if (Object.values(byTier).reduce((sum, count) => sum + count, 0) !== graded) malformedSnapshot(path, "counts.byTier does not sum to counts.graded");
  if (unjoined > graded || missingLogos > graded) malformedSnapshot(path, "counts has an impossible census value");

  if (!Array.isArray(raw.coins)) malformedSnapshot(path, "coins is missing");
  const coins = raw.coins.map((coin, index) => parseSnapshotCoin(coin, index, path));
  if (coins.length !== graded) malformedSnapshot(path, "coins length does not match counts.graded");
  const coinIds = new Set<string>();
  for (const coin of coins) {
    if (coinIds.has(coin.id)) malformedSnapshot(path, `coins contains duplicate ${coin.id}`);
    coinIds.add(coin.id);
  }
  const mapSummary = parseSnapshotMapSummary(raw.mapSummary, path);
  if (mapSummary.gradedCount !== graded || mapSummary.notRatedCount !== notRated) malformedSnapshot(path, "mapSummary counts disagree with counts");
  const summaryByTier = new Map(mapSummary.tiers.map((tier) => [tier.tier, tier]));
  for (const tier of TIER_ORDER) {
    if (summaryByTier.get(tier)!.count !== byTier[tier]) malformedSnapshot(path, `mapSummary.${tier} count disagrees with counts.byTier`);
  }
  const totalSummaryMcap = mapSummary.tiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  if (Math.abs(totalSummaryMcap - mapSummary.totalMcapUsd) > Math.max(1, mapSummary.totalMcapUsd * 1e-9)) malformedSnapshot(path, "mapSummary tier supply does not sum to totalMcapUsd");
  return { publicationStatus: "current", counts: { graded, notRated, unjoined, missingLogos, byTier }, mapSummary, coins };
}

function assertSaneDeltas(path: string | null, current: CurrentDeltaState): void {
  if (!path) {
    console.warn("[safety-score-map] No --previous-snapshot supplied — day-over-day delta guard skipped");
    return;
  }
  const previous = readPreviousSnapshot(path);
  if (!previous) return;
  const priorGraded = previous.counts.graded;
  const priorNotRated = previous.counts.notRated;
  if (current.gradedCount < priorGraded * (1 - MAX_GRADED_DROP)) {
    throw new Error(
      `Graded count fell from ${priorGraded} to ${current.gradedCount} (>${MAX_GRADED_DROP * 100}%) since the previous snapshot — refusing to publish a shrunken census`,
    );
  }
  if (Math.abs(current.notRatedCount - priorNotRated) > MAX_NOT_RATED_MOVE) {
    throw new Error(
      `Not-rated count moved from ${priorNotRated} to ${current.notRatedCount} (>${MAX_NOT_RATED_MOVE}) since the previous snapshot — the scoring producer looks half-broken`,
    );
  }

  const currentByTier = new Map(current.tiers.map((tier) => [tier.tier, tier]));
  for (const tier of TIER_ORDER) {
    const priorCount = previous.counts.byTier[tier];
    const currentCount = currentByTier.get(tier)!.count;
    const allowedMove = Math.max(2, Math.ceil(priorCount * MAX_GRADED_DROP));
    if (Math.abs(currentCount - priorCount) > allowedMove) {
      throw new Error(`Tier ${tier} count moved from ${priorCount} to ${currentCount} (> ${allowedMove}) since the previous snapshot — refusing an unexplained reclassification`);
    }

    const priorTier = previous.mapSummary.tiers.find((entry) => entry.tier === tier)!;
    const currentTier = currentByTier.get(tier)!;
    const mcapDelta = Math.abs(currentTier.mcap - priorTier.mcapUsd);
    if (mcapDelta > Math.max(1, priorTier.mcapUsd * 0.25)) {
      throw new Error(`Tier ${tier} supply moved from ${priorTier.mcapUsd} to ${currentTier.mcap} (>25%) since the previous snapshot — refusing an unexplained supply shift`);
    }
    const priorLeader = previous.mapSummary.tiers.find((entry) => entry.tier === tier)!.leaders[0];
    const currentLeader = currentTier.leaders[0];
    if ((priorLeader == null) !== (currentLeader == null) || (priorLeader != null && currentLeader != null && priorLeader.symbol !== currentLeader.symbol)) {
      throw new Error(`Tier ${tier} leader changed since the previous snapshot — refusing an unexplained leader shift`);
    }
    if (priorLeader != null && currentLeader != null && Math.abs(currentLeader.mcap - priorLeader.mcapUsd) > Math.max(1, priorLeader.mcapUsd * 0.25)) {
      throw new Error(`Tier ${tier} leader supply moved from ${priorLeader.mcapUsd} to ${currentLeader.mcap} (>25%) since the previous snapshot — refusing an unexplained leader shift`);
    }
  }

  const priorById = new Map(previous.coins.map((coin) => [coin.id, coin]));
  const currentById = new Map(current.coins.map((coin) => [coin.id, coin]));
  const allIds = new Set([...priorById.keys(), ...currentById.keys()]);
  const joinChanges = [...allIds].filter((id) => {
    const priorJoined = (priorById.get(id)?.mcap ?? 0) > 0;
    const currentJoined = (currentById.get(id)?.mcap ?? 0) > 0;
    return priorJoined !== currentJoined;
  });
  if (joinChanges.length > 0) {
    throw new Error(`Supply join identity changed for ${joinChanges.length} coin(s) since the previous snapshot (${joinChanges.slice(0, 5).join(", ")}) — refusing to publish an ambiguous census`);
  }
  const gradeTransitions = [...allIds].filter((id) => {
    const prior = priorById.get(id);
    const next = currentById.get(id);
    return prior != null && next != null && prior.grade !== next.grade;
  });
  const maxGradeTransitions = Math.max(5, Math.ceil(priorGraded * 0.1));
  if (gradeTransitions.length > maxGradeTransitions) {
    throw new Error(`Per-coin grade transitions moved ${gradeTransitions.length} assets (> ${maxGradeTransitions}) since the previous snapshot — the scoring producer looks half-broken`);
  }
  if (current.missingLogoCount != null && previous.counts.missingLogos !== current.missingLogoCount) {
    throw new Error(`Missing-logo count moved from ${previous.counts.missingLogos} to ${current.missingLogoCount} since the previous snapshot — refusing an unexplained asset change`);
  }
  console.log(`[safety-score-map] Delta guard OK vs previous snapshot (graded ${priorGraded} -> ${current.gradedCount}, not rated ${priorNotRated} -> ${current.notRatedCount})`);
}

function assertMissingLogoDelta(path: string | null, missingLogoCount: number): void {
  if (!path) return;
  const previous = readPreviousSnapshot(path);
  if (!previous) return;
  if (previous.counts.missingLogos !== missingLogoCount) {
    throw new Error(`Missing-logo count moved from ${previous.counts.missingLogos} to ${missingLogoCount} since the previous snapshot — refusing an unexplained asset change`);
  }
}

function fitLayout(graded: readonly MapCoin[]): { bands: BandLayout[]; k: number; gravelFloor: number } {
  let diag: FitDiagnostic[] = [];
  // Large bubbles may shrink to protect the composition, but the publication
  // floor is fixed: recognizability must not silently degrade to make it fit.
  for (const gravelFloor of GRAVEL_FLOORS) {
    for (let scale = 1; scale >= 0.55; scale *= 0.96) {
      diag = [];
      const layout = layoutBands(graded, scale, gravelFloor, diag);
      if (layout) {
        const annotationViolations = validateAnnotationScene(annotationSceneForBands(layout.bands), {
          bubbleGap: BUBBLE_GAP,
          labelGap: 1,
          leaderGap: 1,
        });
        const compositionViolations = validateComposition({
          orbits: layout.bands.map((band) => ({
            tier: band.tier,
            zone: band.zone,
            bubbles: band.bubbles.map((bubble) => ({ id: bubble.coin.id, cx: bubble.cx, cy: bubble.cy, r: bubble.r })),
          })),
          // Header/footer reservations are owned by the annotation scene; the
          // body has no detached panel left for the orbital layout to dodge.
          chips: [],
        });
        if (annotationViolations.length === 0 && compositionViolations.length === 0) return layout;
        const details = [...annotationViolations.map((item) => `${item.code}: ${item.ids.join(" / ")}`), ...compositionViolations];
        diag.push({ tier: "scene", count: graded.length, placed: 0, radius: 0, reason: details.slice(0, 3).join(", ") });
      }
    }
  }
  const detail = diag
    .map((d) => d.reason ?? `${d.tier}: placed ${d.placed}/${d.count} coins before radius ${d.radius.toFixed(1)} stopped fitting`)
    .join("; ");
  throw new Error(
    `Could not fit the orbital map above the footer at any scale or gravel floor (tried ${GRAVEL_FLOORS.join("/")}). ${detail || "no diagnostics captured"}`,
  );
}

async function main(): Promise<void> {
  const { out, edition, issue, previousSnapshot } = parseCliArgs(process.argv.slice(2));
  unsupportedGlyphs.clear();
  const apiKey = loadApiKey();
  const baseUrl = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;

  console.log(`[safety-score-map] Fetching live data from ${baseUrl} (edition: ${edition})`);
  const [reportCardsResult, listResult, psiResult] = await Promise.all([
    fetchJson(API_PATHS.reportCardsV9(), apiKey, baseUrl),
    fetchJson(API_PATHS.stablecoins(), apiKey, baseUrl),
    fetchJson(API_PATHS.stabilityIndex(), apiKey, baseUrl),
  ]);
  const reportCards = parseReportCardsResponse(reportCardsResult.body);
  const list = parseStablecoinsResponse(listResult.body);
  const psiResponse = parsePsiResponse(psiResult.body);
  const psi = selectMapPsi(psiResponse.current);
  if (reportCardsResult.publicationStatus !== "current") {
    throw new Error(`Report-card publication status is "${reportCardsResult.publicationStatus ?? "missing"}" — refusing to render a non-current capture`);
  }

  // Freshness is asserted on the data, not left to a footer date nobody reads.
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - reportCards.asOfSec;
  if (ageSec < 0) {
    throw new Error(`Report-card capture is ${(ageSec / 3600).toFixed(1)}h old — refusing to render a future-dated capture`);
  }
  if (ageSec >= MAX_DATA_AGE_SEC) {
    throw new Error(`Report-card capture is ${(ageSec / 3600).toFixed(1)}h old (must be under ${MAX_DATA_AGE_SEC / 3600}h) — refusing to render stale scores`);
  }
  const psiAgeSec = nowSec - psi.computedAt;
  if (psiAgeSec < 0) {
    throw new Error(`PSI reading is ${(psiAgeSec / 60).toFixed(1)}m old — refusing to render a future-dated level`);
  }
  if (psiAgeSec >= API_FRESHNESS_MAX_AGE_SEC.stabilityIndex) {
    throw new Error(`PSI reading is ${(psiAgeSec / 60).toFixed(1)}m old (must be under ${API_FRESHNESS_MAX_AGE_SEC.stabilityIndex / 60}m) — refusing to render a stale level`);
  }

  const listById = new Map(list.peggedAssets.map((asset) => [asset.id, asset]));
  const graded: MapCoin[] = [];
  const unjoined: string[] = [];
  let notRatedCount = 0;
  for (const card of reportCards.cards) {
    const tier = card.grade.charAt(0) as Tier;
    if (card.grade === "NR") {
      notRatedCount += 1;
      continue;
    }
    // The response parser has already rejected unknown grade letters, score
    // disagreements, and null scores before this classification branch.
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
      score: card.score as number,
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

  const tiers = summarizeMapCoins(graded);
  const lanes = summarizeSubgradeLanes(graded);
  const totalMcap = graded.reduce((sum, coin) => sum + coin.mcap, 0);
  assertSaneDeltas(previousSnapshot, {
    gradedCount: graded.length,
    notRatedCount,
    missingLogoCount: null,
    coins: graded,
    tiers,
  });

  const { bands, k, gravelFloor } = fitLayout(graded);
  const floorMcapByTier: FloorMcapByTier = {
    a: (R_MIN_A / k) ** 2,
    other: (gravelFloor / k) ** 2,
  };
  const chartKey: ChartKeyData = {
    tiers,
    totalMcap,
    floorMcapByTier,
    floorRadiusByTier: {
      a: radiusForMcap("A", floorMcapByTier.a, k, gravelFloor),
      other: radiusForMcap("F", floorMcapByTier.other, k, gravelFloor),
    },
    lanes,
  };
  const annotationScene = annotationSceneForBands(bands);
  const annotationPlan = planAnnotations({
    ...annotationScene,
    annotationRequests: publicationAnnotationRequests(),
  }, {
    // The chart key is a fixed-size composite annotation. Its complete SVG
    // group is measured with getBBox() in Firefox before the screenshot.
    measureText: (annotationId) => {
      throw new Error(`Annotation ${annotationId} unexpectedly requested unmeasured text bounds`);
    },
    bubbleGap: BUBBLE_GAP,
    labelGap: 1,
    leaderGap: 1,
  });
  if (!annotationPlan.ok) {
    throw new Error(`Required chart annotation placement failed: ${annotationPlan.failure.detail}\n  ${annotationPlan.violations.slice(0, 20).map((item) => item.message).join("\n  ")}`);
  }
  const annotations = annotationPlan.placed;

  const logosById = JSON.parse(readFileSync(LOGOS_JSON, "utf8")) as Record<string, string>;
  const logos = new Map<string, LogoRenderData | null>();
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
  assertMissingLogoDelta(previousSnapshot, missingLogos.length);

  const asOf = new Date(reportCards.asOfSec * 1000);
  const dateLabel = asOf.toISOString().slice(0, 10);
  const stamp = stampCopy(edition, issue, asOf);
  const altText = buildAltText({
    tiers,
    lanes,
    psi,
    stampLabel: edition === "monthly" ? `${stamp.eyebrow} ${stamp.headline}`.toLowerCase() : `data as of ${dateLabel}`,
    gradedCount: graded.length,
    notRatedCount,
    totalMcap,
    floorMcapByTier,
    methodologyVersion: reportCards.methodology.version,
    dateLabel,
  });

  const brandMark = `data:image/svg+xml;base64,${readFileSync(BRAND_MARK).toString("base64")}`;
  const svg = buildSvg({
    bands,
    logos,
    brandMark,
    psi,
    methodologyVersion: reportCards.methodology.version,
    gradedCount: graded.length,
    asOfSec: reportCards.asOfSec,
    edition,
    issue,
    floorMcapByTier,
    chartKey,
    annotations,
  });
  if (unsupportedGlyphs.size > 0) {
    throw new Error(`[safety-score-map] Text uses codepoints missing from the embedded fonts: ${[...unsupportedGlyphs].join(" ")} — refusing to render an unsupported glyph`);
  }

  // Archive naming uses the run date (UTC); the visible stamp uses asOfSec. A
  // Sep 1 run on Aug 31 data must not overwrite the August archive.
  //
  // One clock read feeds both, so `date` is always the UTC date of
  // `renderedAtSec` by construction — reading the clock again after the
  // screenshot would let a run straddle UTC midnight emit a mismatched pair,
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
      const specs = ["16px 'Newsreader'", "italic 16px 'Newsreader'", "16px 'JetBrains Mono'", "16px 'Bricolage Grotesque'"];
      await Promise.all(specs.map((spec) => document.fonts.load(spec)));
      await document.fonts.ready;
      return specs.filter((spec) => !document.fonts.check(spec));
    });
    if (missingFonts.length > 0) throw new Error(`Fonts failed to load: ${missingFonts.join(", ")}`);
    await validateRenderedAnnotations(page, annotationScene, annotations);
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

  const table = buildTierTable(tiers);
  const mapSummary = buildMapSummary({
    date: runDate,
    asOfSec: reportCards.asOfSec,
    methodologyVersion: reportCards.methodology.version,
    gradedCount: graded.length,
    notRatedCount,
    totalMcap,
    floorMcapByTier,
    tiers,
  });
  // One header shape, shared by the snapshot and the manifest: it is both the
  // movers baseline and the input the next run's delta guard reads back.
  const counts = {
    graded: graded.length,
    notRated: notRatedCount,
    unjoined: unjoined.length,
    missingLogos: missingLogos.length,
    chipsDrawn: annotations.length,
    chipsDropped: annotationPlan.dropped.length,
    byTier: Object.fromEntries(tiers.map((tier) => [tier.tier, tier.count])),
  };

  writeFileSync(
    sidecar(".alt.json"),
    `${JSON.stringify({ edition, date: runDate, asOfSec: reportCards.asOfSec, psi, altText, table, tiers }, null, 2)}\n`,
  );
  writeFileSync(
    sidecar(".snapshot.json"),
    `${JSON.stringify(
      {
        edition,
        date: runDate,
        publicationStatus: reportCardsResult.publicationStatus,
        asOfSec: reportCards.asOfSec,
        renderedAtSec,
        methodologyVersion: reportCards.methodology.version,
        ...(reportCards.updatedAt !== undefined ? { updatedAt: reportCards.updatedAt } : {}),
        ...(reportCards.publicationHealth !== undefined ? { publicationHealth: reportCards.publicationHealth } : {}),
        counts,
        mapSummary,
        coins: graded.map((coin) => ({ id: coin.id, symbol: coin.symbol, score: coin.score, grade: coin.grade, mcap: coin.mcap })),
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
        publicationStatus: reportCardsResult.publicationStatus,
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
