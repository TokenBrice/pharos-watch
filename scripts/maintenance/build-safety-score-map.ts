/**
 * Build the Safety Score map: a landscape Twitter-post-size (1600x900, rendered
 * at 2x) editorial infographic of the graded stablecoin universe.
 *
 * Composition (orbital map): every graded coin appears in one of five discrete
 * grade bands around an A-tier core. Bubble area is proportional to circulating
 * supply only above a per-tier legibility floor; smaller assets use a fixed
 * presence marker. Each band is labelled in place at top centre; the largest
 * coins carry name chips; the title, headline A-tier share, supply key and
 * provenance sit in the four corners the inscribed ellipse leaves empty.
 *
 * Two editions share one composition:
 *   --edition=daily    stable output name with the capture date in the masthead
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
 *
 * Outputs (alongside the PNG, sharing its basename):
 *   - .svg / .html   the rendered scene and its screenshot host
 *   - .alt.json      alt text plus the per-tier table, same numbers as the pixels
 *   - .manifest.json publication provenance, counts, and the public map summary
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { firefox, type Page } from "playwright";
import sharp from "sharp";
import type { ZodType } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC, isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { GRADE_RADAR_COLORS } from "@shared/lib/classification";
import { detailSnapshotSourceUpdatedAt, parseDetailSnapshotSourceClock } from "@shared/lib/detail-snapshot-inputs";
import { formatSafetyMapUsd as formatUsdCompact, formatScore } from "@shared/lib/format";
import { getDisplayedPsi, getDisplayedPsiBasis } from "@shared/lib/psi-view-model";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/classification";
import { V9_GRADE_THRESHOLDS } from "@shared/lib/report-card-core";
import { admitSupplyBuckets, getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinListResponseSchema, type StablecoinListResponse } from "@shared/types/market";
import type { DigestSafetyMapSummary } from "@shared/types/digest-safety-map-contract";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "@shared/types/report-cards-v9";
import { StabilityIndexResponseSchema, type StabilityIndexCurrent } from "@shared/types/stability";
import { buildSvgBrowserDocument, escapeXml } from "../lib/og-svg.mts";
import {
  validateAnnotationScene,
  type AnnotationScene,
  type PlacedAnnotation,
  type Rect,
} from "../lib/map-annotations";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { buildMaintenanceApiRequest, DEFAULT_MAINTENANCE_API_BASE_URL } from "../lib/maintenance-api";
import { CliUsageError } from "../lib/cli-args.mjs";

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
const MARGIN_X = 48;
// No header or footer strip: the chrome lives in the four corners the
// inscribed ellipse leaves empty, so the orbital field may run to this edge
// clearance at the top and bottom of the canvas.
const EDGE_CLEARANCE = 14;
const BODY_TOP = EDGE_CLEARANCE;
const BODY_BOTTOM = HEIGHT - EDGE_CLEARANCE;
const GALAXY_CX = 800;
const GALAXY_CY = 450;

// Below this share of graded cards joining a list row with real supply, the
// map is drawing floors instead of data.
const MIN_JOIN_COVERAGE = 0.95;

// Palette: a midnight editorial shell lets the classification colors read as
// orbital signals instead of spreadsheet rules.
const INK = "#f5f7fb";
const INK_SECONDARY = "#9aa6ba";
const INK_DECK = "#c3ccda";
const FIELD = "#0a1220";
const NAME_CHIP = "#e8eef6";

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

// The A core is sized from what it holds (see `layoutCore`); this is the
// default used when no core has been laid out yet. B begins just outside the
// core, and the demand-derived B-F stack consumes the remaining radial budget
// out to the fixed outer bound. The B-F baselines only seed perimeter
// estimates for the thickness model.
export const DEFAULT_CORE_ZONE: OrbitZone = { innerRx: 0, innerRy: 0, outerRx: 184, outerRy: 116 };
const CORE_ASPECT = 1.62;
const CORE_MIN_RY = 64;
const CORE_MAX_ZONE: OrbitZone = { innerRx: 0, innerRy: 0, outerRx: 330, outerRy: 204 };
const CORE_PADDING = 8;
const CORE_BAND_GAP_X = 16;
const CORE_BAND_GAP_Y = 10;
const BASE_ORBIT_ZONES: Record<Tier, OrbitZone> = {
  A: DEFAULT_CORE_ZONE,
  B: { innerRx: 200, innerRy: 126, outerRx: 340, outerRy: 200 },
  C: { innerRx: 354, innerRy: 208, outerRx: 540, outerRy: 300 },
  D: { innerRx: 554, innerRy: 308, outerRx: 626, outerRy: 346 },
  F: { innerRx: 640, innerRy: 354, outerRx: 724, outerRy: 396 },
};
const OUTER_TIERS = ["B", "C", "D", "F"] as const;
type OuterTier = (typeof OUTER_TIERS)[number];
const OUTER_RX = BASE_ORBIT_ZONES.F.outerRx;
const OUTER_RY = BASE_ORBIT_ZONES.F.outerRy;
// Each outer band's largest mark sits on a long-axis vertex, the widest point
// of its annulus. Adjacent bands alternate sides so stacked supply giants
// balance across the centre instead of piling up on one flank.
const OUTER_ANCHOR_PHASE: Readonly<Record<OuterTier, number>> = {
  B: 0,
  C: Math.PI,
  D: 0,
  F: Math.PI,
};
// Every grade's label sits at top centre, so the five pills read as one
// vertical A-to-F scale running out from the core.
const GRADE_LABEL_THETA = Math.PI * 1.5;
const BAND_GAP_X = 14;
const BAND_GAP_Y = 8;
const BAND_SEMANTIC_MIN = 8;
const BAND_PACKING_EFFICIENCY = 0.72;
const SUBGRADE_LANE_TARGET_Y = 15;
const SUBGRADE_LANE_DEGRADE_STEPS = 16;
const SUBGRADE_LANE_REFERENCE_POPULATION = 40;
const SUBGRADE_LANE_MAX_DEMAND_FACTOR = 2;
const MAX_EMPTY_ARC_MEAN_MULTIPLE = 3;
const RING_ARC_SAFETY = 1;
const MAX_GUIDES_PER_GRADE = 5;
const MAX_GUIDE_SPLITS = 12;

// Corner chrome. Each block is a reserved region (or masthead obstacle)
// inflated toward the map by CORNER_CLEARANCE so no mark crowds the type.
const CORNER_CLEARANCE = 18;
const CORNER_BLOCK_W = 300;
export const CHART_KEY_PANEL: Rect = { x: WIDTH - MARGIN_X - 282, y: 16, w: 282, h: 106 };
const SUPPLY_KEY_PANEL: Rect = { x: MARGIN_X, y: 790, w: CORNER_BLOCK_W, h: 94 };
const FOOTER_PANEL: Rect = { x: WIDTH - MARGIN_X - CORNER_BLOCK_W, y: 790, w: CORNER_BLOCK_W, h: 94 };
// The two-line title steps in with the ellipse curve: the long first line
// sits above the shorter second line and deck.
const MASTHEAD_EYEBROW: Rect = { x: MARGIN_X - 2, y: 16, w: 500, h: 30 };
const MASTHEAD_LOCKUP: Rect = { x: MARGIN_X - 2, y: 46, w: 352, h: 50 };
const MASTHEAD_TAIL: Rect = { x: MARGIN_X - 2, y: 96, w: 214, h: 66 };
const ANNOTATION_FRAME: Rect = { x: MARGIN_X - 16, y: 4, w: WIDTH - (MARGIN_X - 16) * 2, h: HEIGHT - 8 };

/**
 * Every corner block as the scene sees it: obstacles and reserved regions,
 * inflated toward the map. All of them lie outside the outer ellipse, and
 * every mark lies inside it, so no layout can ever crowd the corner type.
 */
export function chromeKeepOuts(): Array<Rect & { id: string }> {
  return [
    { id: "masthead-eyebrow", ...MASTHEAD_EYEBROW, w: MASTHEAD_EYEBROW.w + CORNER_CLEARANCE },
    { id: "masthead-lockup", ...MASTHEAD_LOCKUP, w: MASTHEAD_LOCKUP.w + CORNER_CLEARANCE },
    // The deck sits well above the field, so the tail keeps less clearance below.
    { id: "masthead-tail", ...MASTHEAD_TAIL, w: MASTHEAD_TAIL.w + CORNER_CLEARANCE, h: MASTHEAD_TAIL.h + CORNER_CLEARANCE / 2 },
    { id: "chart-key-panel", ...inflateTowardMap(CHART_KEY_PANEL, CORNER_CLEARANCE) },
    { id: "supply-key-panel", ...inflateTowardMap(SUPPLY_KEY_PANEL, CORNER_CLEARANCE) },
    { id: "footer-panel", ...inflateTowardMap(FOOTER_PANEL, CORNER_CLEARANCE) },
  ];
}

function inflateTowardMap(rect: Rect, clearance: number): Rect {
  const left = rect.x + rect.w / 2 > GALAXY_CX;
  const top = rect.y + rect.h / 2 < GALAXY_CY;
  return {
    x: left ? rect.x - clearance : rect.x,
    y: top ? rect.y : rect.y - clearance,
    w: rect.w + clearance,
    h: rect.h + clearance,
  };
}

export const BAND_GUIDE_DASHARRAY: Readonly<Record<Tier, string | null>> = {
  A: "1 3",
  B: null,
  C: "9 5",
  D: "2 4",
  F: "12 4 2 4",
};

// Bubble sizing: area tracks circulating supply, floored for presence. The
// largest coin anchors the scale; the fit loop shrinks it until the strata
// fit the bounded field.
const R_MAX_TARGET = 68;
const MIN_LOGO_SCALE = 1.8;
export const R_MIN_A = 7 * MIN_LOGO_SCALE;
// The fitter prefers the readable floor and steps down to the previous
// publication floor only when the census outgrows it; the floor in use is
// always computed into the disclosed size threshold.
const FALLBACK_LOGO_SCALE = 1.25 * 1.25;
export const GRAVEL_FLOORS = [5 * MIN_LOGO_SCALE, 5 * FALLBACK_LOGO_SCALE] as const;
const BUBBLE_GAP = 2.5;

// In-map type. Pills and chips are sized from deterministic advance
// estimates before render, then measured in the browser: rendered text that
// escapes its pill fails the build.
const GRADE_PILL_H = 26;
const LEADER_TAG_H = 16;
const HERO_CHIP_H = 24;
const HERO_CHIP_MIN_R = 30;
const HERO_CHIP_GAP = 5;
const SLOT_GAP = 3;
const CORE_LABEL_CLEARANCE = 6;
// Clearance kept between a label pill and its guide's edges.
const LABEL_GUIDE_MARGIN = 6;
const MONO_ADVANCE = 0.6;

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
const LOGO_DARK_INK_LUMINANCE_CEILING = 0.25;
const LOGO_DARK_INK_RATIO = 0.5;
const LOGO_LIGHT_PLATE = "#d9e2ec";

// Only these codepoints are covered by all four embedded faces. Anything else
// falls through to a machine-dependent glyph and can visibly change the map.
const RENDERABLE_TEXT = /^[\x20-\x7e·–—°€£¥]*$/;
const unsupportedGlyphs = new Set<string>();

type MapReportCard = Pick<ReportCardsV9CurrentResponse["cards"][number], "id" | "score"> & {
  grade: NonNullable<ReportCardsV9CurrentResponse["cards"][number]["grade"]>;
};
type MapStablecoin = Pick<StablecoinListResponse["peggedAssets"][number], "id" | "symbol" | "circulating">;
type MapPsiCurrent = Pick<StabilityIndexCurrent, "score" | "band" | "avg24h" | "avg24hBand" | "computedAt">;

export type MapPsiBasis = "24H AVG" | "RAW";

export interface MapPsi {
  score: number;
  band: ConditionBand;
  basis: MapPsiBasis;
  computedAt: number;
}

interface MapTransportFreshness {
  sourceUpdatedAtSec: number | null;
  sourceClock: "x-data-updated-at" | "http-date-age" | null;
  sourceHeaders: Record<"X-Data-Updated-At" | "X-Data-Age" | "Date" | "Age" | "Warning", string | null>;
  reason: string | null;
}

interface MapSupplyFreshness extends MapTransportFreshness {
  status: "fresh" | "stale" | "future" | "unavailable";
  assessedAtSec: number;
  ageSec: number | null;
  maxAgeSec: number;
}

interface FetchJsonResult {
  body: unknown;
  publicationStatus: string | null;
  transportFreshness: MapTransportFreshness;
}

type Edition = "daily" | "monthly";

interface MapCoin {
  id: string;
  symbol: string;
  grade: string;
  score: number;
  tier: Tier;
  mcap: number | null;
  supplyUnavailableReason?: string | null;
}
export function projectSafetyMapCoin(
  card: { id: string; grade: string; score: number },
  row: { symbol: string; circulating?: Record<string, number> } | undefined,
): MapCoin {
  const admission = admitSupplyBuckets(row?.circulating);
  const mcap = getCirculatingRawOrNull(row);
  const supplyUnavailableReason = mcap !== null ? null : !row ? "missing-list-row"
    : admission.status === "invalid" ? admission.reason : "absent";
  return { ...card, symbol: row?.symbol ?? card.id.toUpperCase(), tier: card.grade.charAt(0) as Tier,
    mcap, supplyUnavailableReason };
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
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
      edition: { type: "string" },
      issue: { type: "string" },
    },
  });
  if (values.out != null && !/\.png$/.test(values.out)) {
    throw new CliUsageError("--out must name a file ending in lowercase .png");
  }
  const edition = values.edition ?? "daily";
  if (edition !== "daily" && edition !== "monthly") {
    throw new Error(`--edition must be "daily" or "monthly" (got "${edition}")`);
  }
  let issue: number | null = null;
  if (values.issue != null) {
    issue = Number(values.issue);
    if (!Number.isInteger(issue) || issue < 1) throw new Error(`--issue must be a positive integer (got "${values.issue}")`);
  }
  return { out: values.out ?? null, edition, issue };
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

function readMapTransportFreshness(headers: Headers): MapTransportFreshness {
  const sourceHeaders = {
    "X-Data-Updated-At": headers.get("X-Data-Updated-At"),
    "X-Data-Age": headers.get("X-Data-Age"),
    Date: headers.get("Date"),
    Age: headers.get("Age"),
    Warning: headers.get("Warning"),
  };
  const unavailable = (reason: string): MapTransportFreshness => ({
    sourceHeaders, sourceUpdatedAtSec: null, sourceClock: null, reason,
  });
  for (const name of ["X-Data-Updated-At", "X-Data-Age", "Age"] as const) {
    const value = sourceHeaders[name];
    if (value !== null && parseDetailSnapshotSourceClock(value) === null) return unavailable(`invalid-${name.toLowerCase()}`);
  }
  const dateMs = Date.parse(sourceHeaders.Date ?? "");
  if (sourceHeaders.Date !== null && (!Number.isFinite(dateMs) || dateMs < 0)) return unavailable("invalid-date");
  const absoluteClock = sourceHeaders["X-Data-Updated-At"];
  if (absoluteClock === null) {
    // Date alone describes a response, not the source generation. Missing
    // source provenance must never become a request-time source clock.
    if (sourceHeaders.Date === null || sourceHeaders["X-Data-Age"] === null) return unavailable("missing-source-provenance");
    const reconstructed = dateMs / 1000 - Number(sourceHeaders.Age ?? 0) - Number(sourceHeaders["X-Data-Age"]);
    if (!Number.isFinite(reconstructed) || reconstructed < 0) return unavailable("invalid-source-clock");
  }
  let clockHeaders = headers;
  if (absoluteClock === null && sourceHeaders.Age === null) {
    // Preserve the raw absent header while making the map's existing
    // zero-edge-residence policy explicit to the stricter shared helper.
    clockHeaders = new Headers(headers);
    clockHeaders.set("Age", "0");
  }
  const sourceUpdatedAtMs = detailSnapshotSourceUpdatedAt(undefined, clockHeaders);
  if (sourceUpdatedAtMs === null) return unavailable("invalid-source-clock");
  return {
    sourceHeaders,
    sourceUpdatedAtSec: sourceUpdatedAtMs / 1000,
    sourceClock: absoluteClock === null ? "http-date-age" : "x-data-updated-at",
    reason: null,
  };
}

function assessMapSupplyFreshness(transport: MapTransportFreshness, assessedAtSec: number): MapSupplyFreshness {
  const ageSec = transport.sourceUpdatedAtSec === null ? null : assessedAtSec - transport.sourceUpdatedAtSec;
  const maxAgeSec = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
  const staleWarning = transport.sourceHeaders.Warning !== null && isFreshnessWarningHeader(transport.sourceHeaders.Warning);
  const status = staleWarning ? "stale"
    : ageSec === null ? "unavailable" : ageSec < 0 ? "future" : ageSec >= maxAgeSec ? "stale" : "fresh";
  const reason = staleWarning ? "stale-warning"
    : transport.reason ?? (status === "future" ? "future-source-clock" : status === "stale" ? "source-too-old" : null);
  return { ...transport, assessedAtSec, ageSec, maxAgeSec, status, reason };
}

async function fetchJson(apiPath: string, apiKey: string, baseUrl: string): Promise<FetchJsonResult> {
  const { url, headers } = buildMaintenanceApiRequest(apiPath, apiKey, baseUrl);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${apiPath} returned ${res.status}`);
  return {
    body: await res.json(),
    publicationStatus: res.headers.get("X-Safety-Score-Status")?.trim().toLowerCase() ?? null,
    transportFreshness: readMapTransportFreshness(res.headers),
  };
}

function parseCanonicalPayload<T>(label: string, schema: ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new Error(formatCanonicalSchemaError(label, parsed.error));
}

function formatCanonicalSchemaError(label: string, error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${label} response is malformed${path} — ${issue?.message ?? "canonical schema rejected it"}`;
}

export function parseMapReportCards(payload: unknown): {
  cards: MapReportCard[];
  methodologyVersion: string;
  asOfSec: number;
  updatedAt: number;
  publicationHealth: ReportCardsV9CurrentResponse["publicationHealth"];
} {
  const response = parseCanonicalPayload("Report-card", ReportCardsV9CurrentResponseSchema, payload);
  const cards = response.cards.map((card) => {
    // Technical gaps have no grade; they cannot enter any rendered grade band.
    if (card.ratingStatus === "pipeline-gap") return null;
    return { id: card.id, score: card.score, grade: card.grade! };
  }).filter((card): card is MapReportCard => card !== null);

  return {
    cards,
    methodologyVersion: response.methodology.version,
    asOfSec: response.asOfSec,
    updatedAt: response.updatedAt,
    publicationHealth: response.publicationHealth,
  };
}

export function parseMapStablecoins(payload: unknown): { peggedAssets: MapStablecoin[] } {
  const response = parseCanonicalPayload("Stablecoin", StablecoinListResponseSchema, payload);
  const ids = new Set<string>();
  const peggedAssets = response.peggedAssets.map((asset, index) => {
    if (asset.id.length === 0 || asset.symbol.length === 0) {
      throw new Error(`Stablecoin response is malformed — peggedAssets[${index}] needs id and symbol`);
    }
    if (ids.has(asset.id)) throw new Error(`Duplicate stablecoin id "${asset.id}" — refusing to build an ambiguous supply join`);
    ids.add(asset.id);
    // No per-bucket numeric revalidation here: StablecoinListResponseSchema's
    // SupplyBucketsSchema (z.record(z.string(), z.number().finite().nonnegative()))
    // already rejects negative and non-finite buckets before parseCanonicalPayload
    // returns, so the former Number.isFinite/value < 0 checks were unreachable.
    return { id: asset.id, symbol: asset.symbol, circulating: asset.circulating };
  });
  return { peggedAssets };
}

export function parseMapPsi(payload: unknown): MapPsiCurrent {
  const response = parseCanonicalPayload("PSI", StabilityIndexResponseSchema, payload);
  if (response.current === null) {
    throw new Error("PSI response is malformed — expected a current reading");
  }
  const { current } = response;
  const validateScore = (value: number, field: string): void => {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`PSI response is malformed — ${field} must be finite and in the 0-100 range`);
    }
  };
  const validateBand = (value: string, field: string): void => {
    if (!Object.hasOwn(PSI_HEX_COLORS, value)) {
      throw new Error(`PSI response is malformed — ${field} is not a recognized condition band`);
    }
  };

  validateScore(current.score, "current.score");
  validateBand(current.band, "current.band");
  if (!Number.isFinite(current.computedAt) || !Number.isInteger(current.computedAt)) {
    throw new Error("PSI response is malformed — current.computedAt must be a finite integer");
  }
  if ((current.avg24h === undefined) !== (current.avg24hBand === undefined)) {
    throw new Error("PSI response is malformed — current.avg24h and current.avg24hBand must appear together");
  }
  if (current.avg24h !== undefined && current.avg24hBand !== undefined) {
    validateScore(current.avg24h, "current.avg24h");
    validateBand(current.avg24hBand, "current.avg24hBand");
  }
  return {
    score: current.score,
    band: current.band,
    ...(current.avg24h !== undefined ? { avg24h: current.avg24h } : {}),
    ...(current.avg24hBand !== undefined ? { avg24hBand: current.avg24hBand } : {}),
    computedAt: current.computedAt,
  };
}

export function selectMapPsi(current: MapPsiCurrent): MapPsi {
  const displayed = getDisplayedPsi(current);
  return {
    score: displayed.score,
    band: displayed.band as ConditionBand,
    basis: getDisplayedPsiBasis(current) === "rolling 24h avg" ? "24H AVG" : "RAW",
    computedAt: current.computedAt,
  };
}

export function buildPsiSubtitle(psi: Pick<MapPsi, "score" | "band" | "basis">): string {
  return `PSI ${formatScore(psi.score)} · ${psi.band} · ${psi.basis}`;
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
  const mins = V9_GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) === tier).map((t) => t.min);
  const min = Math.min(...mins);
  const higher = V9_GRADE_THRESHOLDS.filter((t) => t.grade.charAt(0) !== tier && t.min > min).map((t) => t.min);
  const max = higher.length > 0 ? Math.min(...higher) - 1 : 100;
  return `${min}–${max}`;
}

export function classifyLogoPlate(rgba: Uint8Array, width: number, height: number): LogoPlate {
  let annulusPixels = 0;
  let opaqueAnnulusPixels = 0;
  let visibleWeight = 0;
  let lightInkWeight = 0;
  let darkInkWeight = 0;
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
      if (luminance < LOGO_DARK_INK_LUMINANCE_CEILING) darkInkWeight += alpha;
    }
  }

  const opaqueAnnulusRatio = annulusPixels > 0 ? opaqueAnnulusPixels / annulusPixels : 0;
  if (opaqueAnnulusRatio >= LOGO_FULL_BLEED_OPAQUE_RATIO) return "light";
  const lightInkRatio = visibleWeight > 0 ? lightInkWeight / visibleWeight : 0;
  if (lightInkRatio >= LOGO_LIGHT_INK_RATIO) return "dark";
  // A shaped mark drawn mostly in dark ink vanishes on the midnight field, so
  // it gets the light plate a full-bleed tile already carries.
  const darkInkRatio = visibleWeight > 0 ? darkInkWeight / visibleWeight : 0;
  return darkInkRatio >= LOGO_DARK_INK_RATIO ? "light" : "none";
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

export type MapSlotKind = "grade-label" | "leader-tag" | "hero-chip";

/**
 * In-map type that owns geometry: a grade label or leader tag reserves its
 * own arc on a guide, and a hero chip reserves room below its coin in the
 * core. Every slot is an obstacle in the annotation scene, so no mark or
 * other label may touch it.
 */
export interface MapSlot {
  id: string;
  kind: MapSlotKind;
  tier: Tier;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Arc half-extent along its guide, so the bare-arc linter counts it as occupied. */
  arcHalf?: number;
  /** Where on the guide that arc was reserved; a hung tag may sit just off it. */
  arcCenter?: { x: number; y: number };
  /** Grade labels: score range and census. Tags and chips: symbol and score. */
  primary: string;
  secondary: string;
}

interface BandLayout {
  tier: Tier;
  zone: OrbitZone;
  bubbles: Bubble[];
  slots: MapSlot[];
  laneOffsetY: number;
  totalCount: number;
  totalMcap: number;
}

interface FitDiagnostic {
  /** The outer grade whose guide ran out of room, when a split could help. */
  openTier?: OuterTier;
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

export function radiusForMcap(tier: Tier, mcap: number | null, k: number, gravelFloor: number): number {
  const floor = tier === "A" ? R_MIN_A : gravelFloor;
  return mcap === null ? floor : Math.max(floor, k * Math.sqrt(Math.max(mcap, 0)));
}

export type DemandOrbitZoneResult =
  | { ok: true; zones: Record<Tier, OrbitZone>; ringZones: Record<Tier, OrbitZone[]>; requiredThickness: Record<Tier, number> }
  | { ok: false; detail: string; requiredThickness: Record<Tier, number>; openTier?: OuterTier };

function splitPopulation<T>(items: readonly T[], count: number): T[][] {
  const groups = Array.from({ length: count }, () => [] as T[]);
  items.forEach((item, index) => groups[index % count].push(item));
  return groups;
}

function splitBandZone(zone: OrbitZone, thicknesses: readonly number[]): OrbitZone[] {
  const total = thicknesses.reduce((sum, value) => sum + value, 0);
  let fraction = 0;
  return thicknesses.map((thickness) => {
    const start = fraction;
    fraction += thickness / total;
    return {
      innerRx: zone.innerRx + (zone.outerRx - zone.innerRx) * start,
      innerRy: zone.innerRy + (zone.outerRy - zone.innerRy) * start,
      outerRx: zone.innerRx + (zone.outerRx - zone.innerRx) * fraction,
      outerRy: zone.innerRy + (zone.outerRy - zone.innerRy) * fraction,
    };
  });
}

/**
 * Allocate the bounded B-F radial span from the actual bubble footprint. The
 * area term accounts for census demand while 2r + BAND_SEMANTIC_MIN guarantees
 * a visually meaningful thickness around every mark. The bands are then
 * stacked from the compact A core to the outer map bound; C receives the
 * remaining thickness because it carries the largest census.
 *
 * The short-axis thickness only has to hold a band's runner-up mark. Its
 * largest mark is anchored on a long-axis vertex (`OUTER_ANCHOR_PHASE`), where
 * every band is `longAxisRatio` times thicker because the allocation always
 * spends the whole short-axis budget. Charging a supply giant's diameter to
 * the short axis instead would reserve that width around the entire ring and
 * leave two giants in different outer bands (USDT in B and USDC in C on
 * 2026-09-28) unplaceable at any scale.
 *
 * Dense bands may use multiple concentric guides of the same grade. Each
 * guide retains its own complete census and is linted independently; the
 * grade-band stack still stays inside the fixed poster body.
 */
export interface GuideSlotDemand {
  /** Width of the grade label pill carried, flat, at top centre of the first guide. */
  labelWidth?: number;
  /** Per guide, the arc half-extents of its leader tags, packed exactly like marks. */
  tagArcHalves?: readonly (readonly number[])[];
}

export function computeDemandOrbitZones(
  radiiByTier: Readonly<Record<Tier, readonly number[]>>,
  modifierLanesByTier: Readonly<Partial<Record<Tier, boolean>>> = {},
  ringCounts: Readonly<Partial<Record<Tier, number>>> = {},
  core: OrbitZone = DEFAULT_CORE_ZONE,
  slotDemand: Readonly<Partial<Record<Tier, GuideSlotDemand>>> = {},
): DemandOrbitZoneResult {
  const outerInnerRx = core.outerRx + CORE_BAND_GAP_X;
  const outerInnerRy = core.outerRy + CORE_BAND_GAP_Y;
  const availableThickness = OUTER_RY - outerInnerRy - BAND_GAP_Y * (OUTER_TIERS.length - 1);
  const availableThicknessX = OUTER_RX - outerInnerRx - BAND_GAP_X * (OUTER_TIERS.length - 1);
  const longAxisRatio = availableThicknessX / availableThickness;
  const baseThickness = Object.fromEntries(TIER_ORDER.map((tier) => [tier, 0])) as Record<Tier, number>;
  const rings = {} as Record<(typeof OUTER_TIERS)[number], { radii: number[][]; thicknesses: number[] }>;
  for (const tier of OUTER_TIERS) {
    const radii = radiiByTier[tier];
    if (radii.some((radius) => !Number.isFinite(radius) || radius < 0)) {
      return { ok: false, detail: `Band ${tier} has an invalid radius demand`, requiredThickness: baseThickness };
    }
    const groups = splitPopulation([...radii].sort((a, b) => b - a), ringCounts[tier] ?? 1);
    const baseline = BASE_ORBIT_ZONES[tier];
    const perimeter = approximateEllipsePerimeter(
      (baseline.innerRx + baseline.outerRx) / 2,
      (baseline.innerRy + baseline.outerRy) / 2,
    );
    const thicknesses = groups.map((group) => {
      const footprint = group.reduce((sum, radius) => sum + Math.PI * (radius + BUBBLE_GAP / 2) ** 2, 0);
      const largest = group[0] ?? 0;
      const runnerUp = group[1] ?? 0;
      return Math.max(
        BAND_SEMANTIC_MIN,
        (largest * 2) / longAxisRatio + BAND_SEMANTIC_MIN,
        runnerUp * 2 + BAND_SEMANTIC_MIN,
        footprint / (perimeter * BAND_PACKING_EFFICIENCY) + BAND_SEMANTIC_MIN,
      );
    });
    baseThickness[tier] = thicknesses.reduce((sum, value) => sum + value, 0);
    rings[tier] = { radii: groups, thicknesses };
  }

  // A flat pill at top centre of a curved guide needs the guide's outer edge
  // to clear its corners, which sag by the guide's curvature across the
  // pill's width. Measured at the innermost position the stack could give the
  // guide: surplus only moves guides outward, where the sag is smaller.
  let stackRx = outerInnerRx;
  let stackRy = outerInnerRy;
  for (const tier of OUTER_TIERS) {
    const labelWidth = slotDemand[tier]?.labelWidth;
    if (labelWidth !== undefined && rings[tier].thicknesses.length > 0) {
      const reach = labelWidth / 2 / stackRx;
      const sag = reach >= 1 ? Number.POSITIVE_INFINITY : stackRy * (1 - Math.sqrt(1 - reach ** 2));
      rings[tier].thicknesses[0] = Math.max(rings[tier].thicknesses[0], GRADE_PILL_H + 2 * sag + LABEL_GUIDE_MARGIN);
      baseThickness[tier] = rings[tier].thicknesses.reduce((sum, value) => sum + value, 0);
    }
    stackRx += baseThickness[tier] * longAxisRatio + BAND_GAP_X;
    stackRy += baseThickness[tier] + BAND_GAP_Y;
  }

  const baseTotal = OUTER_TIERS.reduce((sum, tier) => sum + baseThickness[tier], 0);
  if (baseTotal > availableThickness + 1e-9) {
    return {
      ok: false,
      detail: `Outer bands require ${baseTotal.toFixed(1)}px of short-axis thickness but only ${availableThickness.toFixed(1)}px is available`,
      requiredThickness: baseThickness,
    };
  }

  // Spending the whole short-axis budget is what makes every band exactly
  // `longAxisRatio` times thicker on its long axis than on its short axis.
  const stack = (thickness: Readonly<Record<Tier, number>>): Record<Tier, OrbitZone> => {
    const zones = { A: { ...core } } as Record<Tier, OrbitZone>;
    let innerRx = outerInnerRx;
    let innerRy = outerInnerRy;
    for (const [index, tier] of OUTER_TIERS.entries()) {
      const thicknessY = thickness[tier];
      const thicknessX = thicknessY * longAxisRatio;
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
    return zones;
  };
  // Bound chord-to-arc correction per mark, not widestPair * census. The
  // correction is convex in pair distance, so Jensen bounds every cyclic
  // order by the sum of arcs for (2 * radius + gap). A single supply giant
  // must not charge its curvature correction to hundreds of small markers.
  const ringShortfall = (entries: readonly number[], zone: OrbitZone, flatArcHalves: readonly number[] = []): number => {
    if (entries.length + flatArcHalves.length < 2) return 0;
    const guideRx = (zone.innerRx + zone.outerRx) / 2;
    const guideRy = (zone.innerRy + zone.outerRy) / 2;
    const tightestRadius = Math.min(guideRx, guideRy) ** 2 / Math.max(guideRx, guideRy);
    let demand = 0;
    for (const radius of entries) demand += pairArc(radius * 2 + BUBBLE_GAP, tightestRadius, false);
    // A flat entry's pairs cost their straight extent, which never exceeds
    // the curved bound its neighbour already carries.
    for (const half of flatArcHalves) demand += half * 2 + BUBBLE_GAP;
    // The packer walks a sampled polyline a hair shorter than the analytic
    // perimeter, so a guide closed exactly at the limit would not pack.
    return demand + RING_ARC_SAFETY - approximateEllipsePerimeter(guideRx, guideRy);
  };
  const ringZonesFor = (zones: Readonly<Record<Tier, OrbitZone>>): Record<Tier, OrbitZone[]> => ({
    A: [zones.A],
    ...Object.fromEntries(OUTER_TIERS.map((tier) => [tier, splitBandZone(zones[tier], rings[tier].thicknesses)])),
  }) as Record<Tier, OrbitZone[]>;
  const firstOpenRing = (zones: Readonly<Record<Tier, OrbitZone>>) => {
    const ringZones = ringZonesFor(zones);
    return OUTER_TIERS.flatMap((tier) => rings[tier].radii.map((radii, index) => ({
      tier,
      // Labels and tags are entries of their guide, under the same bound.
      shortfall: ringShortfall(
        [...radii, ...(slotDemand[tier]?.tagArcHalves?.[index] ?? [])],
        ringZones[tier][index],
        index === 0 && slotDemand[tier]?.labelWidth !== undefined ? [slotDemand[tier]!.labelWidth! / 2 + SLOT_GAP] : [],
      ),
    }))).find(({ shortfall }) => shortfall > 0);
  };

  let ringFailure: string | null = null;
  let openTier: OuterTier | undefined;
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

    // The surplus is not empty padding: it widens C, whose census and
    // modifier lanes need the most radial room, after B has taken the least
    // share that moves every guide ring out to its census circumference.
    const surplus = availableThickness - requiredTotal;
    const withBShare = (shareB: number) => stack({
      ...requiredThickness,
      B: requiredThickness.B + shareB,
      C: requiredThickness.C + surplus - shareB,
    });
    const widestOpen = firstOpenRing(withBShare(surplus));
    if (widestOpen) {
      ringFailure = `Band ${widestOpen.tier} needs ${widestOpen.shortfall.toFixed(1)}px more guide circumference than the bounded map can give its census`;
      openTier = widestOpen.tier;
      continue;
    }
    let closed = surplus;
    if (!firstOpenRing(withBShare(0))) {
      closed = 0;
    } else {
      let open = 0;
      while (closed - open > 1e-3) {
        const middle = (open + closed) / 2;
        if (firstOpenRing(withBShare(middle))) open = middle;
        else closed = middle;
      }
    }
    const zones = withBShare(closed);
    return { ok: true, zones, ringZones: ringZonesFor(zones), requiredThickness };
  }
  return {
    ok: false,
    detail: ringFailure ?? "Outer bands cannot retain their bounded extents and semantic gaps",
    requiredThickness: baseThickness,
    ...(openTier ? { openTier } : {}),
  };
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

/**
 * `BUBBLE_GAP` is the *minimum legal* separation, so a pair sitting at exactly
 * that distance must pass. `centerHeroPair` builds the A-tier leaders at
 * precisely `r0 + r1 + BUBBLE_GAP`, but it reconstructs that separation from two
 * independent area-weighted divisions, which lands 1-2 ULP below the sum for
 * roughly 44% of radius pairs. A strict `<` therefore rejected a pair the layout
 * had just built to spec, and because the rejection depends on the rounding of
 * that day's supply values it made a successful render a coin flip: the poster
 * published on 2026-08-21 through 2026-08-24 and then could not fit at any scale
 * on 2026-08-25. The relative epsilon is ~1e-7px at these coordinates -- far
 * below one device pixel, and seven orders of magnitude above the observed
 * floating-point deficit.
 */
export function bubblesOverlap(a: Pick<Bubble, "cx" | "cy" | "r">, b: Pick<Bubble, "cx" | "cy" | "r">): boolean {
  const minimumSeparation = a.r + b.r + BUBBLE_GAP;
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < minimumSeparation * (1 - 1e-9);
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

// --- In-map type ----------------------------------------------------------

// Deterministic advance estimates; the browser measures the real glyphs and
// fails the build if any text escapes its pill (`validateRenderedAnnotations`).
function monoWidth(text: string, size: number): number {
  return text.length * size * MONO_ADVANCE;
}

function sansBoldWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += size * (/[A-Z0-9$]/.test(char) ? 0.66 : char === " " ? 0.3 : 0.56);
  return width;
}

// The bare census keeps pills narrow (curvature sag grows with the square of
// pill width); the headline's "n of N graded stablecoins" teaches the unit.
function censusText(count: number): string {
  return `${count}`;
}

export function gradeLabelSlot(tier: Tier, count: number, cx: number, cy: number): MapSlot {
  const primary = tierRange(tier);
  const secondary = censusText(count);
  const w = Math.ceil(14 + 13 + 9 + monoWidth(primary, 13) + 12 + monoWidth(secondary, 11.5) + 14);
  return { id: `grade-label:${tier}`, kind: "grade-label", tier, x: cx - w / 2, y: cy - GRADE_PILL_H / 2, w, h: GRADE_PILL_H, primary, secondary };
}

function nameSlot(kind: "leader-tag" | "hero-chip", coin: MapCoin, cx: number, cy: number): MapSlot {
  const primary = mapLabel(coin.symbol);
  const secondary = formatScore(coin.score, { trimInteger: true });
  const size = kind === "hero-chip" ? 15 : 11;
  const h = kind === "hero-chip" ? HERO_CHIP_H : LEADER_TAG_H;
  const w = Math.ceil(sansBoldWidth(`${primary} ${secondary}`, size) + size * 0.5 + h);
  return { id: `${kind}:${coin.id}`, kind, tier: coin.tier, x: cx - w / 2, y: cy - h / 2, w, h, primary, secondary };
}

function rectCircleOverlap(rect: Rect, circle: Pick<Bubble, "cx" | "cy" | "r">, gap = 0): boolean {
  const nearestX = Math.max(rect.x, Math.min(circle.cx, rect.x + rect.w));
  const nearestY = Math.max(rect.y, Math.min(circle.cy, rect.y + rect.h));
  return Math.hypot(circle.cx - nearestX, circle.cy - nearestY) < circle.r + gap;
}

function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** A rectangle lies in an annulus when its whole outline does. */
function rectFitsOrbit(zone: OrbitZone, rect: Rect): boolean {
  const samples = 6;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    for (const [x, y] of [
      [rect.x + rect.w * t, rect.y],
      [rect.x + rect.w * t, rect.y + rect.h],
      [rect.x, rect.y + rect.h * t],
      [rect.x + rect.w, rect.y + rect.h * t],
    ] as const) {
      const dx = x - GALAXY_CX;
      const dy = y - GALAXY_CY;
      if (ellipseValue(dx, dy, zone.outerRx, zone.outerRy) > 1) return false;
      if (zone.innerRx > 0 && ellipseValue(dx, dy, zone.innerRx, zone.innerRy) < 1) return false;
    }
  }
  return true;
}

// --- The A core -----------------------------------------------------------

interface CoreLayout {
  zone: OrbitZone;
  bubbles: Bubble[];
  slots: MapSlot[];
}

function coreZoneOfSize(ry: number): OrbitZone {
  return { innerRx: 0, innerRy: 0, outerRx: ry * CORE_ASPECT, outerRy: ry };
}

/**
 * The A core is one body, not a district map: the two supply leaders sit as
 * a tangent hero pair across an area-weighted centre, each large coin carries
 * a name chip just below it, the A label tops the pair, and every other A
 * coin walks straight out from the pair along its own fixed bearing until it
 * clears everything placed before it. Bearings alternate either side of the
 * label, largest first, so the cluster stays balanced. The core is then
 * sized to hold exactly what it holds, which is where B begins.
 */
export function layoutCore(coins: readonly MapCoin[], radii: readonly number[]): CoreLayout | null {
  const bubbles: Bubble[] = [];
  const slots: MapSlot[] = [];
  const clear = (bubble: Pick<Bubble, "cx" | "cy" | "r">, chip: MapSlot | null) =>
    circleFitsOrbit(CORE_MAX_ZONE, bubble.cx, bubble.cy, bubble.r) &&
    !bubbles.some((other) => bubblesOverlap(bubble, other)) &&
    !slots.some((slot) => rectCircleOverlap(slot, bubble, CORE_LABEL_CLEARANCE)) &&
    (!chip || (
      rectFitsOrbit(CORE_MAX_ZONE, chip) &&
      !bubbles.some((other) => rectCircleOverlap(chip, other, CORE_LABEL_CLEARANCE)) &&
      !slots.some((slot) => rectsOverlap(slot, chip, SLOT_GAP))
    ));
  const chipFor = (coin: MapCoin, cx: number, cy: number, r: number) =>
    r >= HERO_CHIP_MIN_R ? nameSlot("hero-chip", coin, cx, cy + r + HERO_CHIP_GAP + HERO_CHIP_H / 2) : null;
  const place = (coin: MapCoin, cx: number, cy: number, r: number): boolean => {
    const chip = chipFor(coin, cx, cy, r);
    if (!clear({ cx, cy, r }, chip)) return false;
    bubbles.push({ coin, cx, cy, r });
    if (chip) slots.push(chip);
    return true;
  };

  const heroCount = Math.min(2, coins.length);
  const heroX = heroCount === 2 ? centerHeroPair(radii[0], radii[1]) : [GALAXY_CX];
  for (let i = 0; i < heroCount; i++) {
    if (!place(coins[i], heroX[i], GALAXY_CY, radii[i])) return null;
  }
  const heroTop = heroCount > 0 ? Math.min(...bubbles.map((bubble) => bubble.cy - bubble.r)) : GALAXY_CY;
  const label = gradeLabelSlot("A", coins.length, GALAXY_CX, heroCount > 0 ? heroTop - SLOT_GAP * 3 - GRADE_PILL_H / 2 : GALAXY_CY);
  if (bubbles.some((bubble) => rectCircleOverlap(label, bubble, CORE_LABEL_CLEARANCE))) return null;
  slots.push(label);

  const satellites = coins.length - heroCount;
  const cone = 0.5;
  const span = Math.PI * 2 - cone * 2;
  for (let i = 0; i < satellites; i++) {
    // Rank 0 just right of the label, rank 1 just left, and so on round.
    const step = Math.floor(i / 2);
    const fromRight = i % 2 === 0;
    const pairs = Math.ceil(satellites / 2);
    const offset = span * ((step + 0.5) / (pairs * 2));
    const theta = -Math.PI / 2 + (fromRight ? cone + offset : -cone - offset);
    const index = heroCount + i;
    let placed = false;
    for (let distance = 0; distance <= CORE_MAX_ZONE.outerRy && !placed; distance += 0.5) {
      placed = place(
        coins[index],
        GALAXY_CX + distance * CORE_ASPECT * Math.cos(theta),
        GALAXY_CY + distance * Math.sin(theta),
        radii[index],
      );
    }
    if (!placed) return null;
  }

  // Smallest core of the fixed aspect that holds every mark and slot.
  const holds = (zone: OrbitZone) =>
    bubbles.every((bubble) => circleFitsOrbit(zone, bubble.cx, bubble.cy, bubble.r)) &&
    slots.every((slot) => rectFitsOrbit(zone, slot));
  let low = CORE_MIN_RY;
  let high = CORE_MAX_ZONE.outerRy;
  if (!holds(coreZoneOfSize(high))) return null;
  if (!holds(coreZoneOfSize(low))) {
    while (high - low > 0.25) {
      const middle = (low + high) / 2;
      if (holds(coreZoneOfSize(middle))) high = middle;
      else low = middle;
    }
    low = high;
  }
  return { zone: coreZoneOfSize(Math.min(CORE_MAX_ZONE.outerRy, low + CORE_PADDING)), bubbles, slots };
}

interface EllipseArcSampler {
  perimeter: number;
  /** Arc length from theta 0, measured along the ellipse rather than a circle. */
  arcAtTheta(theta: number): number;
  thetaAtArc(arc: number): number;
  pointAtArc(arc: number): { x: number; y: number };
}

/**
 * Sample an ellipse centerline densely enough to convert between angle and
 * true arc length in both directions. Equal angles are not equal distances on
 * an ellipse, so both placement and the emptiness linter need this rather than
 * a mean-radius approximation.
 */
function createEllipseArcSampler(rx: number, ry: number): EllipseArcSampler {
  const sampleCount = 4096;
  const fullTurn = Math.PI * 2;
  const cumulative = new Array<number>(sampleCount + 1).fill(0);
  let previousX = rx;
  let previousY = 0;
  for (let i = 1; i <= sampleCount; i++) {
    const theta = (i / sampleCount) * fullTurn;
    const x = rx * Math.cos(theta);
    const y = ry * Math.sin(theta);
    cumulative[i] = cumulative[i - 1]! + Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }
  const perimeter = cumulative[sampleCount]!;
  const thetaAtArc = (rawArc: number): number => {
    const arc = ((rawArc % perimeter) + perimeter) % perimeter;
    let low = 0;
    let high = sampleCount;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (cumulative[mid]! <= arc) low = mid;
      else high = mid;
    }
    const span = cumulative[high]! - cumulative[low]!;
    const fraction = span > 0 ? (arc - cumulative[low]!) / span : 0;
    return ((low + fraction) / sampleCount) * fullTurn;
  };
  return {
    perimeter,
    arcAtTheta(theta: number): number {
      const turns = ((theta % fullTurn) + fullTurn) % fullTurn;
      const position = (turns / fullTurn) * sampleCount;
      const low = Math.min(sampleCount - 1, Math.floor(position));
      return cumulative[low]! + (position - low) * (cumulative[low + 1]! - cumulative[low]!);
    },
    thetaAtArc,
    pointAtArc(arc: number): { x: number; y: number } {
      const theta = thetaAtArc(arc);
      return { x: GALAXY_CX + rx * Math.cos(theta), y: GALAXY_CY + ry * Math.sin(theta) };
    },
  };
}

/**
 * Guide arc a neighbouring pair needs. Marks get the chord-to-arc allowance of
 * the guide's tightest bend. A flat entry (a grade label, pinned at top centre
 * where the guide is at its flattest) is charged its straight extent; its
 * exact rectangle is checked against every mark once placed.
 */
function pairArc(distance: number, tightestRadius: number, flat: boolean): number {
  if (flat) return distance;
  return distance >= 2 * tightestRadius ? Number.POSITIVE_INFINITY : 2 * tightestRadius * Math.asin(distance / (2 * tightestRadius));
}

export interface OrbitAnchor {
  /** Entry index pinned to this angle. */
  index: number;
  theta: number;
}

/**
 * Pack a cyclic sequence of entries round an ellipse with some entries pinned
 * to fixed angles: the supply leader on a long-axis vertex and, on a grade's
 * first guide, its label at top centre. Between consecutive anchors the
 * entries share that segment's surplus arc equally, so no segment pools slack
 * into a bare arc. Each neighbour gets its own chord-to-arc curvature
 * allowance instead of the largest pair's allowance everywhere.
 */
export function packAnchoredOrbit(
  radii: readonly number[],
  orbitRx: number,
  orbitRy: number,
  anchors: readonly OrbitAnchor[],
  flat: ReadonlySet<number> = new Set(),
): Array<{ x: number; y: number }> | null {
  const count = radii.length;
  if (count === 0) return [];
  const sampler = createEllipseArcSampler(orbitRx, orbitRy);
  const sorted = [...anchors].sort((left, right) => left.index - right.index);
  if (sorted.length === 0 || sorted.some((anchor, index) => anchor.index < 0 || anchor.index >= count || anchor.index === sorted[index - 1]?.index)) return null;
  if (count === 1) return [sampler.pointAtArc(sampler.arcAtTheta(sorted[0].theta))];

  const required = radii.map((radius, index) => radius + radii[(index + 1) % count]! + BUBBLE_GAP);
  const tightestRadius = Math.min(orbitRx, orbitRy) ** 2 / Math.max(orbitRx, orbitRy);
  const requiredArcs = required.map((distance, index) => pairArc(distance, tightestRadius, flat.has(index) || flat.has((index + 1) % count)));
  if (requiredArcs.some((arc) => !Number.isFinite(arc)) || !Number.isFinite(sampler.perimeter)) return null;

  const arcs = new Array<number>(count);
  for (const [position, from] of sorted.entries()) {
    const to = sorted[(position + 1) % sorted.length]!;
    const startArc = sampler.arcAtTheta(from.theta);
    const steps = sorted.length === 1 ? count : (to.index - from.index + count) % count;
    const span = sorted.length === 1
      ? sampler.perimeter
      : (sampler.arcAtTheta(to.theta) - startArc + sampler.perimeter) % sampler.perimeter;
    let needed = 0;
    for (let step = 0; step < steps; step++) needed += requiredArcs[(from.index + step) % count]!;
    if (needed > span) return null;
    const slack = (span - needed) / steps;
    let arc = startArc;
    for (let step = 0; step < steps; step++) {
      const index = (from.index + step) % count;
      arcs[index] = arc;
      arc += requiredArcs[index]! + slack;
    }
  }
  const centers = arcs.map((arc) => sampler.pointAtArc(arc));
  for (let i = 0; i < count; i++) {
    const next = centers[(i + 1) % count]!;
    if (Math.hypot(centers[i]!.x - next.x, centers[i]!.y - next.y) < required[i]! * (1 - 1e-9)) return null;
  }
  return centers;
}

/**
 * Choose where a fixed-angle entry (the grade label) joins a sequence whose
 * entry 0 is already pinned: the insertion that leaves the two segments'
 * per-gap slack most nearly equal, so the label does not crowd one side of
 * the ring and strand the other. `blocked` positions are never chosen. The
 * inserted entry is flat (see `pairArc`).
 */
export function chooseAnchorInsertion(
  radii: readonly number[],
  insertRadius: number,
  orbitRx: number,
  orbitRy: number,
  leaderTheta: number,
  insertTheta: number,
  blocked: ReadonlySet<number> = new Set(),
): number | null {
  const count = radii.length;
  const sampler = createEllipseArcSampler(orbitRx, orbitRy);
  const tightestRadius = Math.min(orbitRx, orbitRy) ** 2 / Math.max(orbitRx, orbitRy);
  const arcFor = (a: number, b: number, flat = false) => pairArc(a + b + BUBBLE_GAP, tightestRadius, flat);
  const leaderArc = sampler.arcAtTheta(leaderTheta);
  const firstSpan = (sampler.arcAtTheta(insertTheta) - leaderArc + sampler.perimeter) % sampler.perimeter;
  const secondSpan = sampler.perimeter - firstSpan;
  const pairArcs = radii.map((radius, index) => arcFor(radius, radii[(index + 1) % count]!));
  const prefix = [0];
  for (const arc of pairArcs) prefix.push(prefix[prefix.length - 1]! + arc);
  let best: { position: number; imbalance: number } | null = null;
  // Inserting at `position` puts the entry between radii[position - 1] and
  // radii[position % count]; positions run 1..count.
  for (let position = 1; position <= count; position++) {
    if (blocked.has(position)) continue;
    const before = radii[position - 1]!;
    const after = radii[position % count]!;
    const firstNeed = prefix[position - 1]! + arcFor(before, insertRadius, true);
    const secondNeed = prefix[count]! - prefix[position]! + arcFor(insertRadius, after, true);
    const firstSlack = (firstSpan - firstNeed) / position;
    const secondSlack = (secondSpan - secondNeed) / (count - position + 1);
    if (!(firstSlack >= 0 && secondSlack >= 0)) continue;
    const imbalance = Math.abs(firstSlack - secondSlack);
    if (!best || imbalance < best.imbalance) best = { position, imbalance };
  }
  return best?.position ?? null;
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

/**
 * Radial lanes displace each mark along its own parametric angle, so the
 * packed arc positions - including every pinned anchor and the equal
 * edge-to-edge slack between them - survive the lane offset unchanged.
 */
function displaceSubgradeLanes(
  centers: readonly { x: number; y: number }[],
  directions: readonly (-1 | 0 | 1)[],
  orbitRx: number,
  orbitRy: number,
  offsetX: number,
  offsetY: number,
): Array<{ x: number; y: number }> {
  return centers.map((center, index) => {
    const direction = directions[index]!;
    if (direction === 0) return { ...center };
    const theta = Math.atan2((center.y - GALAXY_CY) / orbitRy, (center.x - GALAXY_CX) / orbitRx);
    return {
      x: GALAXY_CX + (orbitRx + direction * offsetX) * Math.cos(theta),
      y: GALAXY_CY + (orbitRy + direction * offsetY) * Math.sin(theta),
    };
  });
}

export function placeSubgradeRadialLanes(
  centers: readonly { x: number; y: number }[],
  radii: readonly number[],
  grades: readonly string[],
  zone: OrbitZone,
  occupied: readonly Pick<Bubble, "cx" | "cy" | "r">[] = [],
  fitRadii: readonly number[] = radii,
): SubgradeLanePlacement | null {
  if (centers.length !== radii.length || centers.length !== grades.length || fitRadii.length !== radii.length) return null;
  const orbitRx = (zone.innerRx + zone.outerRx) / 2;
  const orbitRy = (zone.innerRy + zone.outerRy) / 2;
  const halfX = (zone.outerRx - zone.innerRx) / 2;
  const halfY = (zone.outerRy - zone.innerRy) / 2;
  const directions = grades.map(subgradeLaneDirection);
  const valid = (placed: readonly { x: number; y: number }[]) => {
    for (let i = 0; i < placed.length; i++) {
      if (!circleFitsOrbit(zone, placed[i].x, placed[i].y, fitRadii[i])) return false;
      // Slots report their radial half-extent here; the caller checks their
      // exact rectangles once placed.
      const bubble = { cx: placed[i].x, cy: placed[i].y, r: fitRadii[i] };
      if (occupied.some((other) => bubblesOverlap(bubble, other))) return false;
      for (let j = 0; j < i; j++) {
        if (bubblesOverlap(bubble, { cx: placed[j].x, cy: placed[j].y, r: fitRadii[j] })) return false;
      }
    }
    return true;
  };
  if (directions.every((direction) => direction === 0)) return valid(centers) ? { centers: [...centers], offsetY: 0 } : null;

  // Lane offsets scale with the band's local half-thickness, which grows from
  // halfY on the short axis to halfX on the long axis. Measure each modifier
  // mark's clearance where it actually sits: a band leader anchored on a
  // long-axis vertex may be wider than the short-axis half-thickness.
  const modifierClearances = radii.map((radius, index) => {
    if (directions[index] === 0) return Number.POSITIVE_INFINITY;
    const t = Math.atan2((centers[index].y - GALAXY_CY) / orbitRy, (centers[index].x - GALAXY_CX) / orbitRx);
    const localHalf = Math.hypot(halfX * Math.cos(t), halfY * Math.sin(t));
    return localHalf > 0 ? (halfY * (localHalf - radius - BUBBLE_GAP / 2)) / localHalf : 0;
  });
  const boundedTarget = Math.max(0, Math.min(SUBGRADE_LANE_TARGET_Y, ...modifierClearances));
  for (let step = SUBGRADE_LANE_DEGRADE_STEPS; step > 0; step--) {
    const offsetY = boundedTarget * (step / SUBGRADE_LANE_DEGRADE_STEPS);
    const offsetX = halfY > 0 ? offsetY * (halfX / halfY) : 0;
    const placed = displaceSubgradeLanes(centers, directions, orbitRx, orbitRy, offsetX, offsetY);
    if (valid(placed)) return { centers: placed, offsetY };
  }

  // Angular coverage is invariant. If no separated radial-lane arrangement
  // fits, collapse the band onto the already-even centerline.
  return valid(centers) ? { centers: [...centers], offsetY: 0 } : null;
}

/**
 * A grade's supply leader earns a name tag when it is drawn above the size
 * floor. The tag reserves arc just past the leader on the long-axis vertex,
 * where the guide runs vertically and the band is widest, so the tag reads
 * horizontally across the band below its coin.
 */
function leaderTagSlot(leader: MapCoin, radius: number): MapSlot {
  // A supply giant outside A is named like the core's heroes.
  return nameSlot(radius >= HERO_CHIP_MIN_R ? "hero-chip" : "leader-tag", leader, 0, 0);
}

/** The allocator reserves a tag's full width of arc: safe at any packed angle. */
function leaderTagArcHalf(tag: MapSlot): number {
  return tag.w / 2 + SLOT_GAP;
}

/**
 * The packer reserves what the tag actually spans along its guide where it
 * sits: just past a leader pinned on the long-axis vertex, where the guide
 * runs nearly vertically, so a horizontal tag spans little more than its
 * height. The tangent tilt is found from the tag's arc distance off the
 * vertex (arc length there is ry per radian), refined once.
 */
function projectedTagArcHalf(tag: MapSlot, leaderRadius: number, orbitRx: number, orbitRy: number): number {
  let half = tag.h / 2 + SLOT_GAP;
  for (let pass = 0; pass < 2; pass++) {
    const t = Math.min(Math.PI / 2, (leaderRadius + BUBBLE_GAP + half) / orbitRy);
    const tx = orbitRx * Math.sin(t);
    const ty = orbitRy * Math.cos(t);
    const norm = Math.hypot(tx, ty);
    half = (tag.w / 2) * (tx / norm) + (tag.h / 2) * (ty / norm) + SLOT_GAP;
  }
  return Math.min(half, leaderTagArcHalf(tag));
}

function leaderTagFor(leader: MapCoin, radius: number, floor: number, zone: OrbitZone): MapSlot | null {
  if (radius <= floor + 1e-6) return null;
  const tag = leaderTagSlot(leader, radius);
  // The vertex has (outerRx - innerRx) of radial room; the tag spans its width.
  return tag.w + SLOT_GAP * 2 <= zone.outerRx - zone.innerRx ? tag : null;
}

type RingEntry = { kind: "mark"; coin: MapCoin; radius: number } | { kind: "slot"; slot: MapSlot; arcHalf: number };

function layoutBands(
  graded: readonly MapCoin[],
  scale: number,
  gravelFloor: number,
  diag?: FitDiagnostic[],
  guideCounts: Readonly<Partial<Record<OuterTier, number>>> = {},
): { bands: BandLayout[]; k: number; gravelFloor: number } | null {
  const maxMcap = Math.max(...graded.flatMap((coin) => coin.mcap === null ? [] : [coin.mcap]));
  const k = (R_MAX_TARGET * scale) / Math.sqrt(maxMcap);
  // maxMcap = 0 (an empty or unjoined list endpoint) yields k = Infinity and
  // NaN radii; every NaN comparison downstream is false, so the layout would
  // "fit" and a chrome-only poster would ship with exit code 0.
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`Bubble scale is not finite (k=${k}, maxMcap=${maxMcap}) — the supply join produced no usable values`);
  }
  const radiusOf = (coin: MapCoin) => radiusForMcap(coin.tier, coin.mcap, k, gravelFloor);
  for (const coin of graded) {
    if (!Number.isFinite(radiusOf(coin))) throw new Error(`Non-finite radius for ${coin.id} (mcap=${coin.mcap})`);
  }
  const byTier = Object.fromEntries(TIER_ORDER.map((tier) => [
    tier,
    graded.filter((coin) => coin.tier === tier).sort(compareMapCoinSupply),
  ])) as Record<Tier, MapCoin[]>;

  // The core goes first: what it holds decides where B begins.
  const core = layoutCore(byTier.A, byTier.A.map(radiusOf));
  if (!core) {
    diag?.push({ tier: "A", count: byTier.A.length, placed: 0, radius: Math.max(0, ...byTier.A.map(radiusOf)), reason: "A core cannot hold its coins, chips and label" });
    return null;
  }

  const radiiByTier = Object.fromEntries(TIER_ORDER.map((tier) => [tier, byTier[tier].map(radiusOf)])) as Record<Tier, number[]>;
  const modifierLanesByTier = Object.fromEntries(TIER_ORDER.map((tier) => [
    tier,
    byTier[tier].some((coin) => subgradeLaneForGrade(coin.grade) !== "base"),
  ])) as Record<Tier, boolean>;
  const ringCounts = Object.fromEntries(TIER_ORDER.map((tier) => [
    tier, tier === "A" ? 1 : Math.max(1, Math.min(guideCounts[tier as OuterTier] ?? 1, radiiByTier[tier].length)),
  ])) as Record<Tier, number>;
  // Reserve every label and every possible leader tag up front, guide by
  // guide, so the allocator and the packer agree on what each guide holds.
  const slotDemand = Object.fromEntries(OUTER_TIERS.map((tier) => {
    if (byTier[tier].length === 0) return [tier, {}];
    const label = gradeLabelSlot(tier, byTier[tier].length, 0, 0);
    const tagArcHalves = splitPopulation(byTier[tier], ringCounts[tier]).map((group) => {
      const leader = group[0];
      return leader && radiusOf(leader) > gravelFloor + 1e-6 ? [leaderTagArcHalf(leaderTagSlot(leader, radiusOf(leader)))] : [];
    });
    return [tier, { labelWidth: label.w, tagArcHalves }];
  })) as Record<OuterTier, GuideSlotDemand>;
  const zoneResult = computeDemandOrbitZones(radiiByTier, modifierLanesByTier, ringCounts, core.zone, slotDemand);
  if (!zoneResult.ok) {
    diag?.push({ openTier: zoneResult.openTier, tier: "B-F", count: OUTER_TIERS.reduce((sum, tier) => sum + radiiByTier[tier].length, 0), placed: 0, radius: Math.max(...OUTER_TIERS.flatMap((tier) => radiiByTier[tier]), 0), reason: zoneResult.detail });
    return null;
  }

  const bands: BandLayout[] = [{
    tier: "A",
    zone: core.zone,
    bubbles: core.bubbles,
    slots: core.slots,
    laneOffsetY: 0,
    totalCount: byTier.A.length,
    totalMcap: knownMapSupply(byTier.A),
  }];
  const placedMarks: Bubble[] = [...core.bubbles];
  const placedSlots: MapSlot[] = [...core.slots];
  for (const tier of OUTER_TIERS) {
    const phase = OUTER_ANCHOR_PHASE[tier];
    const rings = splitPopulation(byTier[tier], ringCounts[tier]);
    for (const [ringIndex, population] of rings.entries()) {
      if (population.length === 0) continue;
      const zone = zoneResult.ringZones[tier][ringIndex]!;
      const orbitRx = (zone.innerRx + zone.outerRx) / 2;
      const orbitRy = (zone.innerRy + zone.outerRy) / 2;
      // Interleave published subgrades, then rotate so the guide's supply
      // leader is entry 0, anchored on its long-axis vertex.
      const interleaved = interleaveSubgradeLanes(population);
      const leaderIndex = interleaved.indexOf(population[0]);
      const coins = [...interleaved.slice(leaderIndex), ...interleaved.slice(0, leaderIndex)];
      const entries: RingEntry[] = coins.map((coin) => ({ kind: "mark", coin, radius: radiusOf(coin) }));

      // The tag follows the leader down the page: increasing angle from the
      // right vertex, decreasing angle from the left one.
      const tag = leaderTagFor(coins[0], radiusOf(coins[0]), gravelFloor, zone);
      if (tag) {
        const tagEntry: RingEntry = { kind: "slot", slot: tag, arcHalf: projectedTagArcHalf(tag, radiusOf(coins[0]), orbitRx, orbitRy) };
        if (phase === 0) entries.splice(1, 0, tagEntry);
        else entries.push(tagEntry);
      }
      const entryRadius = (entry: RingEntry) => entry.kind === "mark" ? entry.radius : entry.arcHalf;
      const anchors: OrbitAnchor[] = [{ index: 0, theta: phase }];
      const flat = new Set<number>();
      if (ringIndex === 0) {
        const label = gradeLabelSlot(tier, byTier[tier].length, 0, 0);
        const arcHalf = label.w / 2 + SLOT_GAP;
        const blocked = new Set<number>();
        if (tag) blocked.add(phase === 0 ? 1 : entries.length);
        const position = chooseAnchorInsertion(entries.map(entryRadius), arcHalf, orbitRx, orbitRy, phase, GRADE_LABEL_THETA, blocked);
        if (position === null) {
          diag?.push({ openTier: tier, tier, count: coins.length, placed: 0, radius: arcHalf, reason: `Band ${tier} has no arc left for its grade label` });
          return null;
        }
        entries.splice(position, 0, { kind: "slot", slot: label, arcHalf });
        anchors.push({ index: position, theta: GRADE_LABEL_THETA });
        flat.add(position);
      }

      const radii = entries.map(entryRadius);
      const packed = packAnchoredOrbit(radii, orbitRx, orbitRy, anchors, flat);
      // Slots stay on the guide; their radial half-extent is what must fit.
      const grades = entries.map((entry) => entry.kind === "mark" ? entry.coin.grade : entry.slot.tier);
      const fitRadii = entries.map((entry) => entry.kind === "mark" ? entry.radius : Math.min(entry.slot.w, entry.slot.h) / 2);
      const lanePlacement = packed
        ? placeSubgradeRadialLanes(packed, radii, grades, zone, placedMarks, fitRadii)
        : null;
      if (!lanePlacement) {
        diag?.push({ openTier: tier, tier, count: coins.length, placed: 0, radius: Math.max(...radii) });
        return null;
      }

      const bubbles: Bubble[] = [];
      const slots: MapSlot[] = [];
      for (const [index, entry] of entries.entries()) {
        const center = lanePlacement.centers[index]!;
        if (entry.kind === "mark") {
          const bubble = { coin: entry.coin, cx: center.x, cy: center.y, r: entry.radius };
          if (!circleFitsOrbit(zone, bubble.cx, bubble.cy, bubble.r) || placedMarks.some((other) => bubblesOverlap(bubble, other))) {
            diag?.push({ tier, count: coins.length, placed: index, radius: bubble.r });
            return null;
          }
          bubbles.push(bubble);
          continue;
        }
        const slot: MapSlot = { ...entry.slot, x: center.x - entry.slot.w / 2, y: center.y - entry.slot.h / 2, arcHalf: entry.arcHalf, arcCenter: center };
        if (!rectFitsOrbit(zone, slot)) {
          diag?.push({ tier, count: coins.length, placed: index, radius: entry.arcHalf, reason: `${slot.id} does not fit band ${tier}` });
          return null;
        }
        slots.push(slot);
      }
      // Lanes may have moved the leader across the band: hang its name just
      // beneath it, else just above it, else keep the packed position.
      for (const [index, slot] of slots.entries()) {
        const leader = bubbles[0];
        if (slot.kind === "grade-label" || !leader) continue;
        // Below, else above, each nudged sideways a little at most.
        const sides = [leader.cy + leader.r + SLOT_GAP, leader.cy - leader.r - SLOT_GAP - slot.h];
        const nudges = [0, -8, 8, -16, 16, -24, 24];
        const hung = sides
          .flatMap((y) => nudges.map((dx) => ({ ...slot, x: leader.cx - slot.w / 2 + dx, y })))
          .find((candidate) => rectFitsOrbit(zone, candidate) &&
            ![...placedMarks, ...bubbles].some((bubble) => rectCircleOverlap(candidate, bubble, SLOT_GAP / 2)) &&
            ![...placedSlots, ...slots].some((other) => other !== slot && rectsOverlap(candidate, other, SLOT_GAP)));
        if (hung) slots[index] = hung;
      }
      // Slots against every mark and slot placed so far, this guide included.
      for (const slot of slots) {
        if ([...placedMarks, ...bubbles].some((bubble) => rectCircleOverlap(slot, bubble, SLOT_GAP / 2)) ||
          [...placedSlots, ...slots].some((other) => other !== slot && rectsOverlap(slot, other, SLOT_GAP))) {
          diag?.push({ tier, count: coins.length, placed: 0, radius: 0, reason: `${slot.id} collides with a neighbouring mark` });
          return null;
        }
      }
      placedMarks.push(...bubbles);
      placedSlots.push(...slots);
      bands.push({
        tier,
        zone,
        bubbles,
        slots,
        laneOffsetY: lanePlacement.offsetY,
        totalCount: coins.length,
        totalMcap: knownMapSupply(coins),
      });
    }
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
  /** Labels that reserve guide arc; they occupy their arc half-extent. */
  slots?: ReadonlyArray<{ id: string; cx: number; cy: number; arcHalf: number }>;
}

export interface AngularDistribution {
  count: number;
  /** Widest span between two neighbours that no mark occupies, in px. */
  maxEmptyArc: number;
  /** Mean unoccupied span, so anomalous emptiness can be told from uniform sparseness. */
  meanEmptyArc: number;
  /** Diameter of the median mark plus its gaps: the smallest hole a mark could have filled. */
  markFootprint: number;
}

/**
 * Measure how much of a band's circumference is genuinely EMPTY.
 *
 * This used to compare centre-to-centre angles against the uniform mean, which
 * measures the wrong thing: bubble area encodes supply, so a single dominant
 * asset legitimately spans a wide angle while leaving no space beside it. That
 * flagged the largest holding in a band as if it were a hole. What the poster
 * actually must not ship is a bare arc, so subtract the marks and measure what
 * is left between their edges.
 */
export function measureAngularDistribution(orbit: CompositionOrbit): AngularDistribution | null {
  if (orbit.zone.innerRx <= 0 || orbit.bubbles.length + (orbit.slots?.length ?? 0) < 2 || orbit.bubbles.length === 0) return null;
  const guideRx = (orbit.zone.innerRx + orbit.zone.outerRx) / 2;
  const guideRy = (orbit.zone.innerRy + orbit.zone.outerRy) / 2;
  if (![guideRx, guideRy].every((value) => Number.isFinite(value) && value > 0)) return null;
  const marks = [
    ...orbit.bubbles.map((bubble) => ({ r: bubble.r, cx: bubble.cx, cy: bubble.cy })),
    ...(orbit.slots ?? []).map((slot) => ({ r: slot.arcHalf, cx: slot.cx, cy: slot.cy })),
  ]
    .map((mark) => ({
      r: mark.r,
      theta: Math.atan2((mark.cy - GALAXY_CY) / guideRy, (mark.cx - GALAXY_CX) / guideRx),
    }))
    .sort((left, right) => left.theta - right.theta);
  if (!marks.every((mark) => Number.isFinite(mark.theta))) return null;
  // True ellipse arc length via the shared cumulative sampler, not a
  // mean-radius approximation: equal angles are not equal distances, and the
  // widest dead zone can span more than half the turn, where the chord between
  // its two edges is short precisely because it measures the full way round.
  const { arcAtTheta, perimeter } = createEllipseArcSampler(guideRx, guideRy);
  const empties = marks.map((mark, index) => {
    const next = marks[(index + 1) % marks.length]!;
    const sweep = (arcAtTheta(next.theta) - arcAtTheta(mark.theta) + perimeter) % perimeter;
    return sweep - mark.r - next.r;
  });
  const diameters = orbit.bubbles.map((bubble) => bubble.r * 2).sort((left, right) => left - right);
  const median = diameters[Math.floor(diameters.length / 2)]!;
  return {
    count: marks.length,
    maxEmptyArc: Math.max(...empties),
    meanEmptyArc: empties.reduce((sum, value) => sum + value, 0) / empties.length,
    markFootprint: median + BUBBLE_GAP * 2,
  };
}

/**
 * Pure-geometry validation of a laid-out scene: chip-vs-chip overlap, chips
 * crossing the body or poster bounds, bubbles escaping their assigned
 * orbit, bubble collisions, and any non-finite coordinate. Returns one string
 * per violation; an empty array means the composition is sound.
 */
export function validateComposition(input: {
  orbits: readonly CompositionOrbit[];
  chips: readonly CompositionRect[];
  bodyBottom?: number;
  bodyTop?: number;
}): string[] {
  const bodyBottom = input.bodyBottom ?? BODY_BOTTOM;
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
      GALAXY_CY - orbit.zone.outerRy < bodyTop ||
      GALAXY_CY + orbit.zone.outerRy > bodyBottom
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
      if (bubble.cy - bubble.r < bodyTop || bubble.cy + bubble.r > bodyBottom) {
        violations.push(`bubble ${bubble.id}: crosses the ${EDGE_CLEARANCE}px edge clearance`);
      }
      allBubbles.push(bubble);
    }
    const angularDistribution = measureAngularDistribution(orbit);
    // A bare arc is a hole a mark could have filled: big enough for the median
    // mark, and anomalous rather than uniform sparseness across a thin band.
    if (
      angularDistribution &&
      angularDistribution.maxEmptyArc > angularDistribution.markFootprint &&
      angularDistribution.maxEmptyArc > angularDistribution.meanEmptyArc * MAX_EMPTY_ARC_MEAN_MULTIPLE
    ) {
      violations.push(
        `orbit ${orbit.tier}: bare arc ${
          angularDistribution.maxEmptyArc.toFixed(1)
        }px fits a ${angularDistribution.markFootprint.toFixed(1)}px mark and exceeds ${MAX_EMPTY_ARC_MEAN_MULTIPLE}x mean ${
          angularDistribution.meanEmptyArc.toFixed(1)
        }px`,
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
    if (chip.y + chip.h > bodyBottom || chip.y < bodyTop) {
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

export function annotationSceneForBands(bands: readonly BandLayout[], annotations: readonly PlacedAnnotation[] = []): AnnotationScene {
  const circles = bands.flatMap((band) => band.bubbles.map((bubble) => ({
    id: bubble.coin.id,
    cx: bubble.cx,
    cy: bubble.cy,
    r: bubble.r,
    role: "bubble" as const,
  })));
  // In-map type is an obstacle like any other: nothing may touch a label.
  const slotRects = bands.flatMap((band) => band.slots.map((slot) => ({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    role: "obstacle" as const,
  })));
  return {
    frame: ANNOTATION_FRAME,
    circles,
    rectangles: [
      // The stepped title: each block clears the map to its right, and the
      // shorter tail also clears it below.
      ...chromeKeepOuts().filter((rect) => rect.id.startsWith("masthead-")).map((rect) => ({ ...rect, role: "obstacle" as const })),
      ...slotRects,
    ],
    orbits: bands.map((band, index) => ({
      id: `band-${band.tier}-${index}`,
      cx: GALAXY_CX,
      cy: GALAXY_CY,
      ...band.zone,
      circleIds: band.bubbles.map((bubble) => bubble.coin.id),
    })),
    reservedRegions: chromeKeepOuts()
      .filter((rect) => rect.id.endsWith("-panel"))
      .map((rect) => ({ ...rect, allowedClassIds: [rect.id === "footer-panel" ? "footer" : "chart-key"] })),
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

/** Right-aligned PSI line; the band marker trails the text so no width estimate is needed. */
export function renderPsiStatus(psi: MapPsi, rightX: number, baselineY: number): string {
  const color = PSI_HEX_COLORS[psi.band];
  const score = formatScore(psi.score);
  return [
    `<g data-psi-status="true" data-psi-band="${psi.band}" data-psi-score="${score}" data-psi-basis="${psi.basis}" data-psi-color="${color}" data-psi-computed-at="${psi.computedAt}">`,
    svgText({ x: rightX - 14, y: baselineY, size: 13, text: buildPsiSubtitle(psi), font: "sans", weight: 600, fill: INK, anchor: "end" }),
    `<circle data-psi-band-marker="true" cx="${rightX - 4}" cy="${baselineY - 4.5}" r="4" fill="${color}"/>`,
    `</g>`,
  ].join("");
}

interface StampCopy {
  eyebrow: string;
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

export function publicationAnnotationRequests(): PlacedAnnotation[] {
  return [
    { id: "grade-key", classId: "chart-key", bounds: { ...CHART_KEY_PANEL } },
    { id: "supply-mass-rail", classId: "chart-key", bounds: { ...SUPPLY_KEY_PANEL } },
    { id: "footer-encoding", classId: "footer", bounds: { ...FOOTER_PANEL } },
  ];
}

function annotationById(annotations: readonly PlacedAnnotation[], id: string): PlacedAnnotation {
  const annotation = annotations.find((item) => item.id === id);
  if (!annotation) throw new Error(`Required annotation ${id} is missing from the fixed placements`);
  return annotation;
}

function annotationGroup(annotation: PlacedAnnotation, body: string): string {
  const { x, y, w, h } = annotation.bounds;
  return `<g data-annotation-id="${annotation.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none"/>${body}</g>`;
}

/** Top-right: the one finding a feed reader should leave with. */
function renderHeadline(annotations: readonly PlacedAnnotation[], data: ChartKeyData): string {
  const aTier = data.tiers.find((tier) => tier.tier === "A");
  if (!aTier) throw new Error("Chart key is missing its A tier");
  const gradedCount = data.tiers.reduce((sum, tier) => sum + tier.count, 0);
  const block = annotationById(annotations, "grade-key");
  const right = block.bounds.x + block.bounds.w - 3;
  const y = block.bounds.y;
  return annotationGroup(block, [
    svgText({ x: right, y: y + 62, size: 60, text: `${aTier.share.toFixed(1)}%`, font: "serif", weight: 500, fill: TIER_COLORS.A, anchor: "end", spacing: "-1.2" }),
    svgText({ x: right, y: y + 84, size: 15, text: "of known supply sits in A-grade coins", font: "sans", weight: 600, fill: INK, anchor: "end" }),
    svgText({ x: right, y: y + 101, size: 13, text: `${aTier.count} of ${gradedCount} graded stablecoins`, font: "sans", weight: 500, fill: INK_SECONDARY, anchor: "end" }),
  ].join(""));
}

/** Bottom-left: the supply split by grade, plus how marker size reads. */
function renderSupplyKey(annotations: readonly PlacedAnnotation[], data: ChartKeyData): string {
  const block = annotationById(annotations, "supply-mass-rail");
  const x = block.bounds.x;
  const y = block.bounds.y;
  const parts: string[] = [];
  parts.push(svgText({ x, y: y + 12, size: 10.5, text: "SHARE OF KNOWN SUPPLY BY GRADE", weight: 700, fill: INK_SECONDARY, spacing: "1.2" }));
  // Segments keep exact proportional widths (no minimum, no gaps taken out of
  // them); separators are drawn over the joins instead.
  const trackWidth = block.bounds.w;
  const barY = y + 22;
  const barH = 12;
  parts.push(`<clipPath id="mass-track"><rect x="${x}" y="${barY}" width="${trackWidth}" height="${barH}" rx="3"/></clipPath>`);
  parts.push(`<g clip-path="url(#mass-track)"><rect x="${x}" y="${barY}" width="${trackWidth}" height="${barH}" fill="#1b2435"/>`);
  let segmentX = x;
  const joins: number[] = [];
  for (const tier of data.tiers) {
    const barWidth = supplyMassBarWidth(tier.mcap, data.totalMcap, trackWidth);
    parts.push(`<rect data-mass-tier="${tier.tier}" data-track-width="${trackWidth}" data-tier-mcap="${tier.mcap}" data-total-mcap="${data.totalMcap}" x="${segmentX}" y="${barY}" width="${barWidth}" height="${barH}" fill="${TIER_COLORS[tier.tier]}"/>`);
    segmentX += barWidth;
    if (barWidth > 0) joins.push(segmentX);
  }
  for (const join of joins.slice(0, -1)) {
    parts.push(`<line x1="${join.toFixed(2)}" y1="${barY}" x2="${join.toFixed(2)}" y2="${barY + barH}" stroke="${FIELD}" stroke-width="1.5"/>`);
  }
  parts.push(`</g>`);
  let cellX = x;
  for (const tier of data.tiers) {
    const share = `${tier.share.toFixed(1)}%`;
    parts.push(svgText({ x: cellX, y: y + 52, size: 13, text: tier.tier, font: "sans", weight: 800, fill: TIER_COLORS[tier.tier] }));
    parts.push(svgText({ x: cellX + 13, y: y + 52, size: 13, text: share, font: "sans", weight: 600, fill: INK }));
    cellX += 13 + sansBoldWidth(share, 13) + 11;
  }
  parts.push(svgText({ x, y: y + 74, size: 11.5, text: `Area tracks supply above ${formatUsdCompact(data.floorMcapByTier.other)} (${formatUsdCompact(data.floorMcapByTier.a)} in A).`, font: "sans", weight: 500, fill: INK_SECONDARY }));
  parts.push(svgText({ x, y: y + 89, size: 11.5, text: "Smaller coins share one marker size.", font: "sans", weight: 500, fill: INK_SECONDARY }));
  return annotationGroup(block, parts.join(""));
}

/** Bottom-right: market condition, publication state and provenance. */
function renderProvenance(
  annotations: readonly PlacedAnnotation[],
  psi: MapPsi,
  asOf: Date,
  methodologyVersion: string,
  gradedCount: number,
  publicationHealth: MapPublicationHealth,
  edition: Edition,
): string {
  const block = annotationById(annotations, "footer-encoding");
  const right = block.bounds.x + block.bounds.w - 2;
  const y = block.bounds.y;
  // The daily eyebrow already names the capture day; the monthly one names
  // only the month, so its footer carries the full date.
  const captureTime = edition === "daily"
    ? asOf.toISOString().slice(11, 16)
    : asOf.toISOString().slice(0, 16).replace("T", " ");
  const parts: string[] = [];
  if (publicationHealth.status === "held") {
    // A held publication still renders, but never as if it were current.
    const since = publicationHealth.heldSinceSec === null
      ? "SCORES HELD"
      : `SCORES HELD SINCE ${new Date(publicationHealth.heldSinceSec * 1000).toISOString().slice(0, 10)}`;
    const w = Math.ceil(monoWidth(since, 10.5) + 18);
    parts.push(`<g data-publication-held="true"><rect x="${right - w}" y="${y + 2}" width="${w}" height="18" rx="9" fill="none" stroke="${INK}" stroke-opacity="0.7" stroke-width="1"/>`);
    parts.push(svgText({ x: right - w / 2, y: y + 14.6, size: 10.5, text: since, weight: 700, fill: INK, anchor: "middle", spacing: "0.4" }), `</g>`);
  }
  parts.push(renderPsiStatus(psi, right, y + 40));
  parts.push(svgText({ x: right, y: y + 58, size: 11, text: "PSI = Pharos stablecoin stress index", fill: INK_SECONDARY, anchor: "end" }));
  parts.push(svgText({ x: right, y: y + 74, size: 11, text: `pharos.watch · Methodology v${methodologyVersion}`, fill: INK_SECONDARY, anchor: "end" }));
  parts.push(svgText({ x: right, y: y + 90, size: 11, text: `Captured ${captureTime} UTC · ${gradedCount} graded`, fill: INK_SECONDARY, anchor: "end" }));
  return annotationGroup(block, parts.join(""));
}

// Daily and monthly diverge here and nowhere else in the composition.
function stampCopy(edition: Edition, issue: number | null, asOf: Date): StampCopy {
  if (edition === "monthly") {
    const month = asOf.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).toUpperCase();
    return { eyebrow: issue == null ? `${month} · MONTHLY` : `${month} · MONTHLY NO. ${issue}` };
  }
  return { eyebrow: asOf.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase() };
}

function ellipsePath(rx: number, ry: number): string {
  const x = (GALAXY_CX - rx).toFixed(2);
  return `M ${x} ${GALAXY_CY} a ${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(rx * 2).toFixed(2)} 0 a ${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(-rx * 2).toFixed(2)} 0 Z`;
}

// One tint strength for every grade, so the largest band never reads as the
// least coloured one.
const GRADE_FIELD_OPACITY = 0.1;
const GRADE_EDGE_OPACITY = 0.36;

function renderGradeFields(bands: readonly BandLayout[]): string {
  const parts: string[] = [];
  for (const tier of TIER_ORDER) {
    const tierBands = bands.filter((band) => band.tier === tier);
    if (tierBands.length === 0) continue;
    const inner = tierBands[0].zone;
    const outer = tierBands[tierBands.length - 1].zone;
    const color = TIER_COLORS[tier];
    const dasharray = BAND_GUIDE_DASHARRAY[tier];
    const pattern = dasharray ? ` stroke-dasharray="${dasharray}" stroke-linecap="round"` : "";
    const zoneData = `data-inner-rx="${inner.innerRx.toFixed(2)}" data-inner-ry="${inner.innerRy.toFixed(2)}" data-outer-rx="${outer.outerRx.toFixed(2)}" data-outer-ry="${outer.outerRy.toFixed(2)}" data-guides="${tierBands.length}"`;
    const field = tier === "A" ? ellipsePath(outer.outerRx, outer.outerRy) : `${ellipsePath(outer.outerRx, outer.outerRy)} ${ellipsePath(inner.innerRx, inner.innerRy)}`;
    parts.push(`<path data-grade-field="${tier}" ${zoneData} d="${field}" fill="${color}" fill-opacity="${GRADE_FIELD_OPACITY}" fill-rule="evenodd"/>`);
    // One edge per grade, on its outer boundary: guides within a dense grade
    // are layout, not another score boundary, so they are never drawn.
    parts.push(`<ellipse data-band-guide="${tier}" cx="${GALAXY_CX}" cy="${GALAXY_CY}" rx="${outer.outerRx.toFixed(2)}" ry="${outer.outerRy.toFixed(2)}" fill="none" stroke="${color}" stroke-opacity="${GRADE_EDGE_OPACITY}" stroke-width="1"${pattern}/>`);
  }
  return parts.join("\n");
}

/** One badge grammar for every coin: dark disc, grade ring, a hair of dark gap, then the logo. */
function renderMark(bubble: Bubble, logo: LogoRenderData | null): string {
  const { coin, cx, cy, r } = bubble;
  const color = TIER_COLORS[coin.tier];
  const ring = r >= 14 ? Math.min(3.2, r * 0.05 + 1.6) : 1.5;
  const gap = r >= 14 ? Math.min(2.6, r * 0.035 + 0.9) : 0.8;
  const innerR = r - ring - gap;
  const x = cx.toFixed(2);
  const y = cy.toFixed(2);
  const parts = [`<circle cx="${x}" cy="${y}" r="${r.toFixed(2)}" fill="${FIELD}"/>`];
  if (logo) {
    if (logo.plate === "light") parts.push(`<circle data-logo-plate="${coin.id}" cx="${x}" cy="${y}" r="${innerR.toFixed(2)}" fill="${LOGO_LIGHT_PLATE}"/>`);
    const size = (innerR * 2).toFixed(2);
    parts.push(`<g transform="translate(${(cx - innerR).toFixed(2)} ${(cy - innerR).toFixed(2)})"><image data-logo-id="${coin.id}" data-plate="${logo.plate}" href="${logo.dataUri}" width="${size}" height="${size}" clip-path="url(#bubble-clip)"/></g>`);
  } else {
    parts.push(svgText({ x: cx, y: cy + innerR * 0.4, size: Math.max(Math.round(innerR * 1.15), 8), text: asciiInitial(coin.symbol), font: "sans", fill: INK, anchor: "middle", weight: 750 }));
  }
  parts.push(`<circle data-grade-rim="${coin.id}" data-grade="${coin.grade}" cx="${x}" cy="${y}" r="${(r - ring / 2).toFixed(2)}" fill="none" stroke="${color}" stroke-width="${ring.toFixed(2)}"/>`);
  return parts.join("");
}

function renderSlot(slot: MapSlot): string {
  const color = TIER_COLORS[slot.tier];
  const midY = slot.y + slot.h / 2;
  const open = `<g data-map-label="${slot.id}" data-slot-kind="${slot.kind}">`;
  if (slot.kind === "grade-label") {
    return [
      open,
      `<rect data-label-box="true" x="${slot.x.toFixed(2)}" y="${slot.y.toFixed(2)}" width="${slot.w}" height="${slot.h}" rx="${slot.h / 2}" fill="${FIELD}" stroke="${color}" stroke-opacity="0.9" stroke-width="1.2"/>`,
      svgText({ x: slot.x + 14, y: midY + 6.4, size: 18, text: slot.tier, font: "sans", weight: 800, fill: color }),
      svgText({ x: slot.x + 36, y: midY + 4.7, size: 13, text: slot.primary, weight: 600, fill: INK }),
      svgText({ x: slot.x + slot.w - 14, y: midY + 4.2, size: 11.5, text: slot.secondary, weight: 500, fill: INK_SECONDARY, anchor: "end" }),
      `</g>`,
    ].join("");
  }
  // Names are light chips, deliberately unlike the dark grade pills.
  const size = slot.kind === "hero-chip" ? 15 : 11;
  return [
    open,
    `<rect data-label-box="true" x="${slot.x.toFixed(2)}" y="${slot.y.toFixed(2)}" width="${slot.w}" height="${slot.h}" rx="${slot.h / 2}" fill="${NAME_CHIP}"/>`,
    `<text x="${(slot.x + slot.w / 2).toFixed(2)}" y="${(midY + size * 0.35).toFixed(2)}" text-anchor="middle" font-family="'Bricolage Grotesque', system-ui, sans-serif" font-size="${size}" font-weight="650" fill="${FIELD}">${escapeXml(slot.primary)}<tspan dx="${(size * 0.42).toFixed(1)}" font-weight="800">${escapeXml(slot.secondary)}</tspan></text>`,
    `</g>`,
  ].join("");
}

interface MapPublicationHealth {
  status: "current" | "held";
  heldSinceSec: number | null;
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
  chartKey,
  annotations,
  publicationHealth,
  supplyFreshness,
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
  chartKey: ChartKeyData;
  annotations: readonly PlacedAnnotation[];
  publicationHealth: MapPublicationHealth;
  supplyFreshness: MapSupplyFreshness;
}): string {
  const asOf = new Date(asOfSec * 1000);
  const stamp = stampCopy(edition, issue, asOf);
  const core = bands.find((band) => band.tier === "A")?.zone ?? DEFAULT_CORE_ZONE;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`);
  parts.push(`<metadata id="supply-freshness">${escapeXml(JSON.stringify(supplyFreshness))}</metadata>`);
  parts.push(`<defs><style>text { font-kerning: normal; font-variant-numeric: tabular-nums; }</style>`);
  parts.push(`<radialGradient id="space" cx="50%" cy="50%" r="76%"><stop offset="0" stop-color="#18243a"/><stop offset="0.46" stop-color="#0c1220"/><stop offset="1" stop-color="#05070d"/></radialGradient>`);
  parts.push(`<radialGradient id="vignette" cx="50%" cy="50%" r="72%"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></radialGradient>`);
  // The core glow is an ellipse of the core's own aspect, so the safe centre
  // reads as one lit body rather than a circle pasted on an oval.
  parts.push(`<radialGradient id="core-glow" gradientUnits="userSpaceOnUse" cx="${GALAXY_CX}" cy="${GALAXY_CY}" r="${(core.outerRy * 2.4).toFixed(1)}" gradientTransform="translate(${GALAXY_CX} ${GALAXY_CY}) scale(${CORE_ASPECT} 1) translate(${-GALAXY_CX} ${-GALAXY_CY})"><stop offset="0" stop-color="${TIER_COLORS.A}" stop-opacity="0.16"/><stop offset="0.5" stop-color="${TIER_COLORS.A}" stop-opacity="0.05"/><stop offset="1" stop-color="${TIER_COLORS.A}" stop-opacity="0"/></radialGradient>`);
  // CSS circle() clip-paths silently no-op on SVG images in Firefox; a real
  // clipPath in objectBoundingBox units crops every bubble regardless of size.
  parts.push(`<clipPath id="bubble-clip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>`);

  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#space)"/>`);
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vignette)"/>`);
  parts.push(`<ellipse cx="${GALAXY_CX}" cy="${GALAXY_CY}" rx="${(core.outerRx * 2.4).toFixed(1)}" ry="${(core.outerRy * 2.4).toFixed(1)}" fill="url(#core-glow)"/>`);
  parts.push(renderGradeFields(bands));

  // Marks are grouped per grade; slots are drawn last so type sits on top.
  for (const tier of TIER_ORDER) {
    const tierBands = bands.filter((band) => band.tier === tier);
    if (tierBands.length === 0) continue;
    const zone = { inner: tierBands[0].zone, outer: tierBands[tierBands.length - 1].zone };
    parts.push(`<g data-band-zone="${tier}" data-inner-rx="${zone.inner.innerRx.toFixed(2)}" data-inner-ry="${zone.inner.innerRy.toFixed(2)}" data-outer-rx="${zone.outer.outerRx.toFixed(2)}" data-outer-ry="${zone.outer.outerRy.toFixed(2)}" data-lane-offset-y="${Math.max(...tierBands.map((band) => band.laneOffsetY)).toFixed(2)}">`);
    for (const band of tierBands) {
      for (const bubble of band.bubbles) parts.push(renderMark(bubble, logos.get(bubble.coin.id) ?? null));
    }
    parts.push(`</g>`);
  }
  parts.push(bands.flatMap((band) => band.slots).map(renderSlot).join(""));

  // Top-left masthead: brand eyebrow, then a two-line serif title stepped to
  // the ellipse curve, then the deck.
  parts.push(`<g data-masthead-eyebrow="true">`);
  parts.push(`<image href="${brandMark}" x="${MARGIN_X}" y="18" width="26" height="26"/>`);
  parts.push(svgText({ x: MARGIN_X + 34, y: 37, size: 14, text: "PHAROS", font: "sans", weight: 700, spacing: "2.4" }));
  parts.push(svgText({ x: MARGIN_X + 122, y: 37, size: 11, text: stamp.eyebrow, weight: 600, fill: INK_SECONDARY, spacing: "1.2" }));
  if (publicationHealth.status === "held") {
    // Beside the date, where a feed reader looks: a held publication must
    // never be mistaken for today's scores.
    const x = MARGIN_X + 122 + stamp.eyebrow.length * (11 * MONO_ADVANCE + 1.2) + 10;
    const text = "SCORES HELD";
    const w = Math.ceil(text.length * (10.5 * MONO_ADVANCE + 0.6) + 16);
    parts.push(`<g data-publication-held-eyebrow="true"><rect x="${x.toFixed(1)}" y="23" width="${w}" height="19" rx="9.5" fill="${NAME_CHIP}"/>`);
    parts.push(svgText({ x: x + w / 2, y: 36.4, size: 10.5, text, weight: 800, fill: FIELD, anchor: "middle", spacing: "0.6" }), `</g>`);
  }
  parts.push(`</g>`);
  parts.push(`<g data-masthead-lockup="true">`);
  parts.push(svgText({ x: MARGIN_X - 2, y: 82, size: 44, text: "The Stablecoin", font: "serif", weight: 500, spacing: "-0.8" }));
  parts.push(`</g>`);
  parts.push(`<g data-masthead-tail="true">`);
  parts.push(svgText({ x: MARGIN_X - 2, y: 126, size: 44, text: "Safety Map", font: "serif", weight: 500, spacing: "-0.8" }));
  parts.push(svgText({ x: MARGIN_X, y: 154, size: 15, text: "Safer toward the centre", font: "sans", weight: 500, fill: INK_DECK }));
  parts.push(`</g>`);

  parts.push(renderHeadline(annotations, chartKey));
  parts.push(renderSupplyKey(annotations, chartKey));
  parts.push(renderProvenance(annotations, psi, asOf, methodologyVersion, gradedCount, publicationHealth, edition));
  parts.push(`</svg>`);
  return parts.join("\n");
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
  const within = (box: Rect, bounds: Rect) =>
    box.x >= bounds.x - tolerance && box.y >= bounds.y - tolerance &&
    box.x + box.w <= bounds.x + bounds.w + tolerance && box.y + box.h <= bounds.y + bounds.h + tolerance;
  const describe = (box: Rect) => `${box.x.toFixed(1)},${box.y.toFixed(1)} ${box.w.toFixed(1)}x${box.h.toFixed(1)}`;
  const masthead = await page.evaluate(() => ["eyebrow", "lockup", "tail"].map((part) => {
    const node = document.querySelector<SVGGElement>(`g[data-masthead-${part}]`);
    if (!node) return null;
    const box = node.getBBox();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }));
  // A title line's glyph box may rise into the block above it, never past
  // its own block's width or bottom.
  const risesTo = (rect: Rect) => ({ ...rect, y: MASTHEAD_EYEBROW.y, h: rect.y + rect.h - MASTHEAD_EYEBROW.y });
  for (const [index, bounds] of [MASTHEAD_EYEBROW, risesTo(MASTHEAD_LOCKUP), risesTo(MASTHEAD_TAIL)].entries()) {
    const box = masthead[index];
    if (!box) throw new Error("Rendered masthead lockup is missing");
    if (!within(box, bounds)) {
      throw new Error(`Rendered masthead escaped its reserved bounds (${describe(box)} vs ${describe(bounds)})`);
    }
  }
  const measured = planned.map((annotation) => {
    const box = renderedById.get(annotation.id);
    if (!box) throw new Error(`Rendered annotation ${annotation.id} is missing`);
    if (!within(box, annotation.bounds)) {
      throw new Error(`Rendered annotation ${annotation.id} escaped its planned bounds (${describe(box)} vs ${describe(annotation.bounds)})`);
    }
    return { ...annotation, bounds: { x: box.x, y: box.y, w: box.w, h: box.h } };
  });
  const violations = validateAnnotationScene({ ...scene, annotations: measured }, {
    bubbleGap: BUBBLE_GAP,
    labelGap: 1,
  });
  if (violations.length > 0) {
    throw new Error(`Rendered annotation validation failed:\n  ${violations.slice(0, 20).map((item) => item.message).join("\n  ")}`);
  }
  // In-map type was sized from advance estimates; real glyphs must fit.
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll<SVGGElement>("g[data-map-label]")).map((node) => {
    const box = node.querySelector<SVGRectElement>("rect[data-label-box]")!.getBBox();
    const texts = Array.from(node.querySelectorAll<SVGTextElement>("text")).map((text) => {
      const bbox = text.getBBox();
      return { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height };
    });
    return { id: node.dataset.mapLabel ?? "", box: { x: box.x, y: box.y, w: box.width, h: box.height }, texts };
  }));
  for (const label of labels) {
    const inset = { x: label.box.x + 4, y: label.box.y, w: label.box.w - 8, h: label.box.h };
    for (const text of label.texts) {
      if (text.x < inset.x - tolerance || text.x + text.w > inset.x + inset.w + tolerance ||
        text.y + text.h / 2 < label.box.y || text.y + text.h / 2 > label.box.y + label.box.h) {
        throw new Error(`Rendered map label ${label.id} text (${describe(text)}) overflows its pill (${describe(label.box)})`);
      }
    }
  }
}

// --- Emitted numbers ------------------------------------------------------

interface TierSummary {
  tier: Tier;
  range: string;
  count: number;
  mcap: number;
  share: number;
  leaders: Array<{ id: string; symbol: string; score: number; mcap: number }>;
}
function knownMapSupply(coins: readonly MapCoin[]): number {
  return coins.reduce((sum, coin) => coin.mcap === null ? sum : sum + coin.mcap, 0);
}

function compareMapCoinSupply(a: MapCoin, b: MapCoin): number {
  const supplyOrder = a.mcap === null ? (b.mcap === null ? 0 : 1)
    : b.mcap === null ? -1 : b.mcap - a.mcap;
  return supplyOrder || b.score - a.score || a.id.localeCompare(b.id);
}


export function summarizeMapCoins(coins: readonly MapCoin[]): TierSummary[] {
  const totalMcap = knownMapSupply(coins);
  const byTier = new Map<Tier, MapCoin[]>(TIER_ORDER.map((tier) => [tier, coins.filter((coin) => coin.tier === tier)]));
  return TIER_ORDER.map((tier) => {
    const tierCoins = byTier.get(tier) ?? [];
    const tierMcap = knownMapSupply(tierCoins);
    return {
      tier,
      range: tierRange(tier),
      count: tierCoins.length,
      mcap: tierMcap,
      share: totalMcap > 0 ? (tierMcap / totalMcap) * 100 : 0,
      leaders: tierCoins.filter((coin): coin is MapCoin & { mcap: number } => coin.mcap !== null)
        .sort(compareMapCoinSupply)
        .slice(0, 3)
        .map((coin) => ({ id: coin.id, symbol: mapLabel(coin.symbol), score: coin.score, mcap: coin.mcap })),
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

type MapSummary = DigestSafetyMapSummary & {
  supplyCoverage: NonNullable<DigestSafetyMapSummary["supplyCoverage"]>;
};

export function buildMapSummary({
  date,
  asOfSec,
  methodologyVersion,
  gradedCount,
  notRatedCount,
  totalMcap,
  graded,
  floorMcapByTier,
  tiers,
}: {
  date: string;
  asOfSec: number;
  methodologyVersion: string;
  gradedCount: number;
  notRatedCount: number;
  totalMcap: number;
  graded: readonly MapCoin[];
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
    supplyCoverage: {
      complete: graded.every((coin) => coin.mcap !== null),
      observedCount: graded.filter((coin) => coin.mcap !== null).length,
      unavailableCount: graded.filter((coin) => coin.mcap === null).length,
      unavailableById: Object.fromEntries(graded.filter((coin) => coin.mcap === null).map((coin) => [coin.id, coin.supplyUnavailableReason ?? "absent"])),
      shareBasis: "known-mapped-supply",
    },
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
    `All ${gradedCount} graded stablecoins in five discrete grade bands: A at the centre, then B, C, D, and F outward; orbit = grade band, not a continuous score; bubble area tracks circulating supply above a per-tier minimum marker (A below ~${formatUsdCompact(floorMcapByTier.a)}, B-F below ~${formatUsdCompact(floorMcapByTier.other)}); assets below those thresholds or with unavailable supply share a fixed presence marker; ${formatUsdCompact(totalMcap)} known mapped supply subtotal.`,
    `Published sub-grades set bounded radial lanes${lanes.splitTiers.length > 0 ? ` in ${lanes.splitTiers.join(" and ")}` : ""}: plus grades sit slightly inward, unmodified grades sit on the guide, and minus grades sit slightly outward${lanes.baseOnlyTiers.length > 0 ? `; ${lanes.baseOnlyTiers.join(" and ")} contain only unmodified grades and remain on the guide` : ""}.`,
    `Methodology v${methodologyVersion}, data as of ${dateLabel}.`,
  ];
  for (const tier of tiers) {
    const leaders = tier.leaders.map((l) => `${l.symbol} ${l.score} (${formatUsdCompact(l.mcap)})`).join(", ");
    sentences.push(
      `${tier.tier} tier (score ${tier.range}): ${tier.count} coins, ${formatUsdCompact(tier.mcap)} known subtotal, ${tier.share.toFixed(1)}% of known mapped supply — led by ${leaders}.`,
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
  return ["| Tier | Score | Coins | Known supply subtotal | Share of known supply | Largest |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

// --- Main -----------------------------------------------------------------

interface PreparedMapData {
  reportCardsResult: FetchJsonResult;
  reportCards: ReturnType<typeof parseMapReportCards>;
  psi: MapPsi;
  supplyFreshness: MapSupplyFreshness;
  graded: MapCoin[];
  unjoined: string[];
  notRatedCount: number;
  tiers: TierSummary[];
  lanes: SubgradeLaneSummary;
  bands: BandLayout[];
  k: number;
  gravelFloor: number;
  logos: Map<string, LogoRenderData | null>;
  missingLogos: Bubble[];
}

async function fetchAndValidateMapData(
  apiKey: string,
  baseUrl: string,
  io: SafetyScoreMapCliIo,
): Promise<PreparedMapData> {
  io.log(`[safety-score-map] Fetching canonical data from ${baseUrl}`);
  const [reportCardsResult, listResult, psiResult] = await Promise.all([
    fetchJson(API_PATHS.reportCardsV9(), apiKey, baseUrl),
    fetchJson(API_PATHS.stablecoins(), apiKey, baseUrl),
    fetchJson(API_PATHS.stabilityIndex(), apiKey, baseUrl),
  ]);
  const reportCards = parseMapReportCards(reportCardsResult.body);
  const list = parseMapStablecoins(listResult.body);
  const psi = selectMapPsi(parseMapPsi(psiResult.body));
  const nowSec = Math.floor(Date.now() / 1000);
  const psiAgeSec = nowSec - psi.computedAt;
  if (psiAgeSec < 0) throw new Error(`PSI reading is ${(psiAgeSec / 60).toFixed(1)}m old — refusing to render a future-dated level`);
  if (psiAgeSec >= API_FRESHNESS_MAX_AGE_SEC.stabilityIndex) throw new Error(`PSI reading is ${(psiAgeSec / 60).toFixed(1)}m old (must be under ${API_FRESHNESS_MAX_AGE_SEC.stabilityIndex / 60}m) — refusing to render a stale level`);
  const supplyFreshness = assessMapSupplyFreshness(listResult.transportFreshness, nowSec);
  if (supplyFreshness.status !== "fresh") {
    throw new Error(`Stablecoin supply freshness ${supplyFreshness.status}: ${supplyFreshness.reason} (maxAgeSec=${supplyFreshness.maxAgeSec}, sourceUpdatedAtSec=${supplyFreshness.sourceUpdatedAtSec}) — refusing to render unadmitted supply`);
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
    if (!TIER_ORDER.includes(tier)) throw new Error(`Unknown grade "${card.grade}" for ${card.id} — the tier map (${TIER_ORDER.join("/")}) is out of date`);
    const row = listById.get(card.id);
    const coin = projectSafetyMapCoin({ id: card.id, grade: card.grade, score: card.score as number }, row);
    if (coin.mcap === null) {
      unjoined.push(card.id);
      io.warn(`[safety-score-map] ${card.id}: ${!row ? "no list row" : "unavailable circulating supply"} — drawn at the size floor`);
    }
    graded.push(coin);
  }
  if (graded.length === 0) throw new Error("No graded coins returned — refusing to render an empty map");
  const joinCoverage = 1 - unjoined.length / graded.length;
  if (joinCoverage < MIN_JOIN_COVERAGE) throw new Error(`Supply join coverage ${(joinCoverage * 100).toFixed(1)}% is below ${(MIN_JOIN_COVERAGE * 100).toFixed(0)}% (${unjoined.length}/${graded.length} unjoined) — the map would be drawing floors, not data`);

  const tiers = summarizeMapCoins(graded);
  const lanes = summarizeSubgradeLanes(graded);

  const { bands, k, gravelFloor } = fitLayout(graded);
  if (gravelFloor !== GRAVEL_FLOORS[0]) {
    io.warn(`[safety-score-map] Census outgrew the ${GRAVEL_FLOORS[0]}px marker floor; rendered at the ${gravelFloor}px fallback`);
  }
  const logos = new Map<string, LogoRenderData | null>();
  const logosById = JSON.parse(readFileSync(LOGOS_JSON, "utf8")) as Record<string, string>;
  const allBubbles = bands.flatMap((band) => band.bubbles);
  await Promise.all(allBubbles.map(async (bubble) => {
    const path = logosById[bubble.coin.id];
    logos.set(bubble.coin.id, path ? await loadLogoDataUri(path, Math.ceil(bubble.r * 2)) : null);
  }));
  const missingLogos = allBubbles.filter((bubble) => !logos.get(bubble.coin.id));
  if (missingLogos.length > 0) io.warn(`[safety-score-map] No logo for ${missingLogos.length} coins: ${missingLogos.slice(0, 12).map((b) => b.coin.id).join(", ")}${missingLogos.length > 12 ? ", …" : ""}`);

  io.log(`[safety-score-map] Render input graded=${graded.length} notRated=${notRatedCount} missingLogos=${missingLogos.length}`);
  return { reportCardsResult, reportCards, psi, supplyFreshness, graded, unjoined, notRatedCount, tiers, lanes, bands, k, gravelFloor, logos, missingLogos };
}

export class SafetyMapCapacityError extends Error {
  readonly code = "layout-capacity-exhausted";

  constructor(detail: string) {
    super(`layout-capacity-exhausted: Could not fit the orbital map inside its bounded field with readable markers and adaptive guide rings (tried floors ${GRAVEL_FLOORS.join("/")}). ${detail || "no diagnostics captured"}`);
    this.name = "SafetyMapCapacityError";
  }
}

/** The linter's view of a layout: marks plus the guide arc each label reserves. */
export function compositionOrbitsFor(bands: readonly BandLayout[]): CompositionOrbit[] {
  return bands.map((band) => ({
    tier: band.tier,
    zone: band.zone,
    bubbles: band.bubbles.map((bubble) => ({ id: bubble.coin.id, cx: bubble.cx, cy: bubble.cy, r: bubble.r })),
    slots: band.slots.flatMap((slot) => slot.arcHalf === undefined ? [] : [{
      id: slot.id,
      cx: slot.arcCenter?.x ?? slot.x + slot.w / 2,
      cy: slot.arcCenter?.y ?? slot.y + slot.h / 2,
      arcHalf: slot.arcHalf,
    }]),
  }));
}

export function fitLayout(graded: readonly MapCoin[]): { bands: BandLayout[]; k: number; gravelFloor: number } {
  let diag: FitDiagnostic[] = [];
  // A grade whose guide runs out of room first gains one more guide; only
  // when no split can help do the large bubbles shrink, and only after every
  // scale has failed does the marker floor step down. Splits are kept as the
  // scale shrinks, and only the grade that overflowed is split, so capacity
  // is monotonic: one more coin never forces every grade apart at once, and
  // supply giants keep their size whenever another guide can make room.
  for (const gravelFloor of GRAVEL_FLOORS) {
    const minScale = Math.min(R_MIN_A, gravelFloor) / R_MAX_TARGET;
    const guideCounts: Record<OuterTier, number> = { B: 1, C: 1, D: 1, F: 1 };
    let splits = 0;
    for (let scale = 1; ;) {
      diag = [];
      const layout = layoutBands(graded, scale, gravelFloor, diag, guideCounts);
      if (layout) {
        const annotationViolations = validateAnnotationScene(annotationSceneForBands(layout.bands), {
          bubbleGap: BUBBLE_GAP,
          labelGap: 1,
        });
        const compositionViolations = validateComposition({
          orbits: compositionOrbitsFor(layout.bands),
          // Corner chrome and in-map type are owned by the annotation scene.
          chips: [],
        });
        if (annotationViolations.length === 0 && compositionViolations.length === 0) return layout;
        const details = [...annotationViolations.map((item) => `${item.code}: ${item.ids.join(" / ")}`), ...compositionViolations];
        diag.push({ tier: "scene", count: graded.length, placed: 0, radius: 0, reason: details.slice(0, 3).join(", ") });
      }
      const openTier = diag.find((item) => item.openTier)?.openTier;
      if (openTier && guideCounts[openTier] < MAX_GUIDES_PER_GRADE && splits < MAX_GUIDE_SPLITS) {
        guideCounts[openTier] += 1;
        splits += 1;
        continue;
      }
      if (scale === minScale) break;
      scale = Math.max(minScale, scale * 0.96);
    }
  }
  const detail = diag
    .map((d) => d.reason ?? `${d.tier}: placed ${d.placed}/${d.count} coins before radius ${d.radius.toFixed(1)} stopped fitting`)
    .join("; ");
  throw new SafetyMapCapacityError(detail);
}

export interface SafetyScoreMapCliIo {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

async function buildMap(options: {
  argv: readonly string[];
  apiKey?: string;
  baseUrl?: string;
  io: SafetyScoreMapCliIo;
}): Promise<void> {
  const { argv, apiKey: apiKeyOverride, baseUrl: baseUrlOverride, io } = options;
  const { out, edition, issue } = parseCliArgs(argv);
  unsupportedGlyphs.clear();
  const apiKey = apiKeyOverride ?? loadApiKey();
  const baseUrl = baseUrlOverride?.trim() || process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;

  const prepared = await fetchAndValidateMapData(apiKey, baseUrl, io);
  const { reportCardsResult, reportCards, psi, supplyFreshness, graded, unjoined, notRatedCount, tiers, lanes, bands, k, gravelFloor, logos, missingLogos } = prepared;
  const totalMcap = knownMapSupply(graded);
  const floorMcapByTier: FloorMcapByTier = {
    a: (R_MIN_A / k) ** 2,
    other: (gravelFloor / k) ** 2,
  };
  const chartKey: ChartKeyData = {
    tiers,
    totalMcap,
    floorMcapByTier,
    lanes,
  };
  const annotationScene = annotationSceneForBands(bands);
  // Mandatory fixed panels; Firefox checks their complete SVG getBBox() before
  // the screenshot, in addition to this full-scene geometry validation.
  const annotations = publicationAnnotationRequests();
  const annotationViolations = validateAnnotationScene({ ...annotationScene, annotations }, {
    bubbleGap: BUBBLE_GAP,
    labelGap: 1,
  });
  if (annotationViolations.length > 0) {
    throw new Error(`Required chart annotation placement failed:\n  ${annotationViolations.slice(0, 20).map((item) => item.message).join("\n  ")}`);
  }

  const asOf = new Date(reportCards.asOfSec * 1000);
  const dateLabel = asOf.toISOString().slice(0, 10);
  const altText = buildAltText({
    tiers,
    lanes,
    psi,
    stampLabel: edition === "monthly"
      ? asOf.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).toLowerCase()
      : `data as of ${dateLabel}`,
    gradedCount: graded.length,
    notRatedCount,
    totalMcap,
    floorMcapByTier,
    methodologyVersion: reportCards.methodologyVersion,
    dateLabel,
  });

  const brandMark = `data:image/svg+xml;base64,${readFileSync(BRAND_MARK).toString("base64")}`;
  const svg = buildSvg({
    bands,
    logos,
    brandMark,
    psi,
    methodologyVersion: reportCards.methodologyVersion,
    gradedCount: graded.length,
    asOfSec: reportCards.asOfSec,
    edition,
    issue,
    chartKey,
    annotations,
    publicationHealth: reportCards.publicationHealth,
    supplyFreshness,
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
  writeFileSync(htmlPath, buildSvgBrowserDocument({
    svg,
    background: "#05070d",
    fonts: [
      { family: "Newsreader", file: NEWSREADER_FONT, weight: "200 800" },
      { family: "Newsreader", file: NEWSREADER_ITALIC_FONT, weight: "200 800", style: "italic" },
      { family: "JetBrains Mono", file: JETBRAINS_MONO_FONT, weight: "100 800" },
      { family: "Bricolage Grotesque", file: BRICOLAGE_FONT, weight: "200 800" },
    ],
  }));

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
    methodologyVersion: reportCards.methodologyVersion,
    gradedCount: graded.length,
    notRatedCount,
    totalMcap,
    graded,
    floorMcapByTier,
    tiers,
  });
  const counts = {
    graded: graded.length,
    notRated: notRatedCount,
    unjoined: unjoined.length,
    missingLogos: missingLogos.length,
    chipsDrawn: annotations.length,
    chipsDropped: 0,
    byTier: Object.fromEntries(tiers.map((tier) => [tier.tier, tier.count])),
  };

  writeFileSync(
    sidecar(".alt.json"),
    `${JSON.stringify({ edition, date: runDate, asOfSec: reportCards.asOfSec, psi, supplyFreshness, altText, table, tiers }, null, 2)}\n`,
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
        methodologyVersion: reportCards.methodologyVersion,
        updatedAt: reportCards.updatedAt,
        publicationHealth: reportCards.publicationHealth,
        supplyFreshness,
        counts,
        totalMcap,
        bytes: statSync(pngPath).size,
        mapSummary,
      },
      null,
      2,
    )}\n`,
  );

  io.log(`[safety-score-map] Wrote ${pngPath} (${rendered.width}x${rendered.height}, ${graded.length} graded coins)`);
  io.log(`\n--- alt text ---\n${altText}\n`);
  io.log(`--- per-tier table ---\n${table}\n`);
}

/**
 * In-process entrypoint with the CLI's process semantics: a guard failure
 * surfaces through `io.error` with the `[safety-score-map]` prefix and
 * reports exit code 1 (invalid output filenames report usage code 2), success reports 0. `apiKey`/`baseUrl` override the
 * environment so tests can drive a fixture API without spawning a child
 * process or loading `.env.local`; the direct-run block below stays the
 * real-process owner of the exit contract.
 */
export async function runSafetyScoreMapCli(
  options: {
    argv?: readonly string[];
    apiKey?: string;
    baseUrl?: string;
    io?: SafetyScoreMapCliIo;
  } = {},
): Promise<number> {
  const io: SafetyScoreMapCliIo = options.io ?? {
    log: (message) => process.stdout.write(`${message}\n`),
    warn: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
  try {
    await buildMap({
      argv: options.argv ?? process.argv.slice(2),
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      io,
    });
    return 0;
  } catch (error) {
    io.error(`[safety-score-map] ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runSafetyScoreMapCli().then((status) => {
    if (status !== 0) process.exit(status);
  });
}
