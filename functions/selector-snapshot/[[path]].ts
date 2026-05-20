import type { KVNamespace } from "@cloudflare/workers-types";
import { canonicalizeForSid } from "@shared/lib/selector/canonicalize";
import {
  COMPOSABILITY_VALUES,
  CONTEXT_KEYS,
  CUSTODY_OK_VALUES,
  DECENTRALIZATION_VALUES,
  DEPEG_TOLERANCE_VALUES,
  EXCLUSION_REASONS,
  EXIT_SPEED_VALUES,
  HORIZON_VALUES,
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  SELECTOR_PROFILES,
  TRADING_VENUE_VALUES,
  TREASURY_VENUE_VALUES,
  WEIGHT_KEYS,
  WHY_KEYS,
  YIELD_VENUE_VALUES,
} from "@shared/lib/selector/types";
import { YIELD_TYPE_VALUES } from "@shared/types/core";
import { jsonError } from "../lib/proxy-utils";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";

/**
 * Pages Function: `/selector-snapshot/*`
 *
 * - `POST /selector-snapshot`  -> stores a SelectorOutput JSON under a content-addressed sid; returns `{ sid }`.
 * - `GET  /selector-snapshot/:sid` -> returns the previously stored SelectorOutput, or 404.
 *
 * Origin-gated via the existing same-origin allowlist; no write secret (R0 revision — browser CORS
 * blocks cross-origin POST, and origin gating is the sole write auth on top of that).
 *
 * `sid` is content-addressed: SHA-256 of the lexicographically-canonicalized JSON output with
 * freshness-derived fields stripped. The first 16 bytes (32 hex chars) are the sid. The function
 * recomputes the sid on every POST — clients cannot forge sid -> payload pairs.
 *
 * KV namespace: `SELECTOR_SNAPSHOTS` (declared in `shared/lib/env-contract/registry.ts`).
 * Retention: 5 years (`expirationTtl`).
 */

const SID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_PAYLOAD_BYTES = 100 * 1024;
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
const MAX_JSON_DEPTH = 12;

/**
 * Defensive shared response headers for both POST (200) and GET (200) so the
 * snapshot endpoint cannot be mis-rendered, indexed, or pivoted off.
 */
const STANDARD_RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * Defensive depth + prototype-pollution guard on parsed JSON. Cloudflare KV
 * tolerates arbitrary payloads; we keep the engine's invariants intact by
 * refusing pathological nesting and reserved keys before we hash or store.
 */
function isStructurallySafe(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.every((item) => isStructurallySafe(item, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    if (!isStructurallySafe((value as Record<string, unknown>)[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

interface SelectorSnapshotEnv {
  SELECTOR_SNAPSHOTS?: KVNamespace;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
}

interface SelectorSnapshotContext {
  request: Request;
  env: SelectorSnapshotEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  params: {
    path?: string | string[];
  };
}

function resolveSidFromParams(params: SelectorSnapshotContext["params"]): string | null {
  const raw = params.path;
  if (raw === undefined || raw === null) return null;
  const segments = Array.isArray(raw) ? raw : [raw];
  if (segments.length !== 1) return null;
  const candidate = (segments[0] ?? "").trim().toLowerCase();
  if (candidate.length === 0) return null;
  return SID_PATTERN.test(candidate) ? candidate : null;
}

function hasSnapshotSegments(params: SelectorSnapshotContext["params"]): boolean {
  const raw = params.path;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.length > 0;
  return raw.length > 0;
}

/**
 * Local snapshot contract checks for the fields the selector frontend reads
 * when replaying a frozen KV value. The engine owns the full schema; this
 * Pages Function keeps a deliberately small runtime guard so obvious partial
 * or stale shapes cannot be persisted without importing frontend code.
 */
const SELECTOR_PROFILE_SET = new Set<string>(SELECTOR_PROFILES);
const SELECTOR_PEG_SET = new Set<string>(SELECTOR_ELIGIBLE_PEG_CURRENCIES);
const HORIZON_SET = new Set<string>(HORIZON_VALUES);
const DEPEG_TOLERANCE_SET = new Set<string>(DEPEG_TOLERANCE_VALUES);
const COMPOSABILITY_SET = new Set<string>(COMPOSABILITY_VALUES);
const EXIT_SPEED_SET = new Set<string>(EXIT_SPEED_VALUES);
const DECENTRALIZATION_SET = new Set<string>(DECENTRALIZATION_VALUES);
const CUSTODY_OK_SET = new Set<string>(CUSTODY_OK_VALUES);
const WEIGHT_KEY_SET = new Set<string>(WEIGHT_KEYS);
const WHY_KEY_SET = new Set<string>(WHY_KEYS);
const LOWEST_SUB_DIMENSION_SET = new Set<string>(LOWEST_SUB_DIMENSION_KEYS);
const CONTEXT_KEY_SET = new Set<string>(CONTEXT_KEYS);
const LOWER_RANKED_REASON_SET = new Set<string>([
  ...EXCLUSION_REASONS,
  ...WEIGHT_KEYS.map((key) => `weak-${key}`),
]);
const EXCLUSION_REASON_SET = new Set<string>(EXCLUSION_REASONS);
const SOURCE_RISK_TIERS = new Set(["low", "mid", "high"]);
const YIELD_TYPE_SET = new Set<string>(YIELD_TYPE_VALUES);
const PER_INPUT_STALENESS_KEYS = new Set(["pegSummary", "dexTvl", "dews"]);
const EXCLUSION_SEVERITIES = new Set(["info", "soft", "hard"]);
const RELAXABLE_CONSTRAINT_KEYS = new Set(["depegTolerance", "venue", "exitSpeed"]);
const VENUE_SETS_BY_PROFILE: Record<string, ReadonlySet<string>> = {
  treasury: new Set<string>(TREASURY_VENUE_VALUES),
  yield: new Set<string>(YIELD_VENUE_VALUES),
  trading: new Set<string>(TRADING_VENUE_VALUES),
};
const BASE_CONFIDENCE_REASON_SET = new Set([
  "recent-listing",
  "yield-source-switched",
  "short-yield-history",
  "redistributed-missing-data",
  "source-risk-missing",
  "relaxed-fallback",
  "narrow-margin",
]);
const RANK_ROBUSTNESS_LABELS = new Set([
  "clear-margin",
  "crowded-field",
  "narrow-margin",
  "concentration-adjusted",
]);
const BLUECHIP_GRADES = new Set(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);
const SAFETY_GRADES = new Set([...BLUECHIP_GRADES, "NR"]);
const REQUIRED_METHODOLOGY_KEYS = [
  "safetyScore",
  "pegScoreAndDews",
  "yieldIntelligence",
  "bluechipAlignment",
  "exclusionFilters",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isKnownStringArray(value: unknown, allowed: ReadonlySet<string>): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && allowed.has(item));
}

function isRequiredArrayOf(
  value: unknown,
  itemGuard: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(itemGuard);
}

function isNullableNonEmptyString(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function isConfidenceReason(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (BASE_CONFIDENCE_REASON_SET.has(value)) return true;
  if (!value.startsWith("missing-critical-")) return false;
  return WEIGHT_KEY_SET.has(value.slice("missing-critical-".length));
}

function isOptionalConfidenceReasons(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isConfidenceReason));
}

function isOptionalRankRobustness(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  return (
    typeof value.label === "string"
    && RANK_ROBUSTNESS_LABELS.has(value.label)
    && (value.scoreMargin === null || isNumberInRange(value.scoreMargin, 0, 100))
  );
}

function isSelectorInputShape(value: unknown, profile: string): boolean {
  if (!isPlainObject(value)) return false;
  const venueSet = VENUE_SETS_BY_PROFILE[profile];
  return (
    value.profile === profile
    && typeof value.pegCurrency === "string"
    && SELECTOR_PEG_SET.has(value.pegCurrency)
    && typeof value.horizon === "string"
    && HORIZON_SET.has(value.horizon)
    && typeof value.depegTolerance === "string"
    && DEPEG_TOLERANCE_SET.has(value.depegTolerance)
    && typeof value.composability === "string"
    && COMPOSABILITY_SET.has(value.composability)
    && typeof value.exitSpeed === "string"
    && EXIT_SPEED_SET.has(value.exitSpeed)
    && (value.minApy === null || isNonNegativeNumber(value.minApy))
    && typeof value.yieldNativeOnly === "boolean"
    && typeof value.decentralization === "string"
    && DECENTRALIZATION_SET.has(value.decentralization)
    && typeof value.custodyOk === "string"
    && CUSTODY_OK_SET.has(value.custodyOk)
    && (
      value.venuePreferences === undefined
      || (venueSet != null && isKnownStringArray(value.venuePreferences, venueSet))
    )
  );
}

function isUniverseShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonNegativeInteger(value.active)
    && isNonNegativeInteger(value.surviving)
    && value.surviving <= value.active
  );
}

function isSkippedCoinShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isStringArray(value.missingSignals)
  );
}

function isCoverageWarningsShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonNegativeInteger(value.skippedForCoverageCount)
    && Array.isArray(value.skippedForCoverage)
    && value.skippedForCoverage.every(isSkippedCoinShape)
    && typeof value.sparse === "boolean"
    && typeof value.uneven === "boolean"
    && isNonNegativeInteger(value.newListingCount)
    && isNonNegativeInteger(value.redistributionCount)
  );
}

function isComponentShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.key === "string"
    && WEIGHT_KEY_SET.has(value.key)
    && isNumberInRange(value.weight, 0, 100)
    && (value.rawValue === null || isFiniteNumber(value.rawValue))
    && (value.normalizedValue === null || isNumberInRange(value.normalizedValue, 0, 100))
    && isNumberInRange(value.contribution, 0, 100)
    && typeof value.redistributed === "boolean"
  );
}

function isLowestSubDimensionShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.key === "string"
    && LOWEST_SUB_DIMENSION_SET.has(value.key)
    && isNumberInRange(value.score, 0, 100)
    && isKnownStringArray(value.contextKeys, CONTEXT_KEY_SET)
  );
}

function isChainHintsShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isStringArray(value.topByLiquidity)
    && isStringArray(value.topByYield)
    && (value.primary === null || typeof value.primary === "string")
  );
}

function isRecommendedSourceShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isPlainObject(value.freshness)) return false;
  return (
    isNonEmptyString(value.protocol)
    && isNonEmptyString(value.chain)
    && (value.sourceKey === undefined || isNullableNonEmptyString(value.sourceKey))
    && (
      value.yieldType === undefined
      || value.yieldType === null
      || (typeof value.yieldType === "string" && YIELD_TYPE_SET.has(value.yieldType))
    )
    && isFiniteNumber(value.apy30d)
    && (value.pharosYieldScore === null || isNumberInRange(value.pharosYieldScore, 0, 100))
    && (value.sourceTvlUsd === undefined || value.sourceTvlUsd === null || isNonNegativeNumber(value.sourceTvlUsd))
    && typeof value.sourceRiskTier === "string"
    && SOURCE_RISK_TIERS.has(value.sourceRiskTier)
    && isNonNegativeNumber(value.freshness.capturedAt)
    && isNonNegativeNumber(value.freshness.ageSeconds)
    && (value.selectionReason === undefined || isNullableNonEmptyString(value.selectionReason))
  );
}

function isPerInputStalenessShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0
    && entries.every(([key, age]) => PER_INPUT_STALENESS_KEYS.has(key) && isNonNegativeNumber(age));
}

function isRecommendationSourceSlotsShape(value: Record<string, unknown>): boolean {
  if (value.profile === "treasury") {
    return value.recommendedSource === null && value.perInputStaleness === null;
  }
  if (value.profile === "yield") {
    return isRecommendedSourceShape(value.recommendedSource) && value.perInputStaleness === null;
  }
  if (value.profile === "trading") {
    return value.recommendedSource === null && isPerInputStalenessShape(value.perInputStaleness);
  }
  return false;
}

function isRecommendationShape(value: unknown, outputProfile: string): boolean {
  if (!isPlainObject(value)) return false;
  return (
    value.profile === outputProfile
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.name)
    && Number.isInteger(value.rank)
    && (value.rank as number) >= 1
    && (value.rank as number) <= 3
    && isNumberInRange(value.score, 0, 100)
    && isNumberInRange(value.confidence, 0, 100)
    && Array.isArray(value.components)
    && value.components.every(isComponentShape)
    && isKnownStringArray(value.whyKeys, WHY_KEY_SET)
    && isOptionalConfidenceReasons(value.confidenceReasons)
    && isLowestSubDimensionShape(value.lowestSubDimension)
    && isChainHintsShape(value.chainHints)
    && isOptionalRankRobustness(value.rankRobustness)
    && typeof value.isRecentListing === "boolean"
    && (value.bluechipGrade === null || (typeof value.bluechipGrade === "string" && BLUECHIP_GRADES.has(value.bluechipGrade)))
    && typeof value.safetyGrade === "string"
    && SAFETY_GRADES.has(value.safetyGrade)
    && isNonNegativeNumber(value.supplyUsd)
    && value.isBeta === true
    && isRecommendationSourceSlotsShape(value)
    && (value.relaxedReason === undefined || value.relaxedReason === null || (typeof value.relaxedReason === "string" && EXCLUSION_REASON_SET.has(value.relaxedReason)))
    && isNonEmptyString(value.whyText)
    && isNonEmptyString(value.watchText)
  );
}

function isLowerRankedShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.name)
    && (value.slot === "A" || value.slot === "B")
    && typeof value.reasonKey === "string"
    && LOWER_RANKED_REASON_SET.has(value.reasonKey)
    && (value.failedComponent === null || (typeof value.failedComponent === "string" && WEIGHT_KEY_SET.has(value.failedComponent)))
    && (value.hypotheticalScore === null || isNumberInRange(value.hypotheticalScore, 0, 100))
    && isNonEmptyString(value.verdictText)
    && isNonEmptyString(value.teachingText)
  );
}

function isMethodologyVersionsShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    REQUIRED_METHODOLOGY_KEYS.every((key) => isNonEmptyString(value[key]))
    && Object.values(value).every(isNonEmptyString)
  );
}

function isExclusionSummaryItemShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.reason === "string"
    && EXCLUSION_REASON_SET.has(value.reason)
    && isNonNegativeInteger(value.count)
    && typeof value.severity === "string"
    && EXCLUSION_SEVERITIES.has(value.severity)
    && isStringArray(value.sampleIds)
  );
}

function isClosestSurvivorShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.symbol)
    && isNonEmptyString(value.failingDimension)
    && isNonEmptyString(value.liveReading)
    && typeof value.reason === "string"
    && EXCLUSION_REASON_SET.has(value.reason)
    && (value.hypotheticalScore === null || isNumberInRange(value.hypotheticalScore, 0, 100))
  );
}

function isRelaxableConstraintShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.key === "string"
    && RELAXABLE_CONSTRAINT_KEYS.has(value.key)
    && isNonEmptyString(value.label)
    && isNonEmptyString(value.description)
    && typeof value.reason === "string"
    && (EXCLUSION_REASON_SET.has(value.reason) || value.reason === "input-strictness")
  );
}

function isSelectorOutputShape(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.profile) || !SELECTOR_PROFILE_SET.has(candidate.profile)) {
    return false;
  }
  return (
    isNonEmptyString(candidate.engineVersion)
    && isNonEmptyString(candidate.datasetHash)
    && isFiniteNumber(candidate.timestamp)
    && isSelectorInputShape(candidate.input, candidate.profile)
    && isUniverseShape(candidate.universe)
    && Array.isArray(candidate.recommended)
    && candidate.recommended.length <= 3
    && candidate.recommended.every((item) => isRecommendationShape(item, candidate.profile as string))
    && Array.isArray(candidate.lowerRanked)
    && candidate.lowerRanked.length <= 2
    && candidate.lowerRanked.every(isLowerRankedShape)
    && isCoverageWarningsShape(candidate.coverageWarnings)
    && typeof candidate.lowConfidence === "boolean"
    && isMethodologyVersionsShape(candidate.methodologyVersions)
    && typeof candidate.usedRelaxedFallback === "boolean"
    && isKnownStringArray(candidate.relaxedReasons, EXCLUSION_REASON_SET)
    && isRequiredArrayOf(candidate.exclusionSummary, isExclusionSummaryItemShape)
    && isRequiredArrayOf(candidate.closestSurvivors, isClosestSurvivorShape)
    && isRequiredArrayOf(candidate.relaxableConstraints, isRelaxableConstraintShape)
  );
}

function stripDebugFromSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const { debug: _debug, ...snapshot } = value;
  return snapshot;
}

/**
 * Snapshot id is computed via `canonicalizeForSid` from
 * `@shared/lib/selector/canonicalize` (engine-authoritative). Client and server
 * apply the same canonicalization rules so the recomputed sid matches.
 */
async function computeSid(canon: string): Promise<string> {
  const bytes = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = view[i];
    if (byte === undefined) break;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function handlePost(context: SelectorSnapshotContext): Promise<Response> {
  const { request, env } = context;

  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader) {
    const parsed = Number(contentLengthHeader);
    if (Number.isFinite(parsed) && parsed > MAX_PAYLOAD_BYTES) {
      return jsonError(413, "Payload too large");
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonError(400, "Could not read request body");
  }
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return jsonError(413, "Payload too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError(400, "Invalid JSON payload");
  }
  if (!isStructurallySafe(parsed)) {
    return jsonError(400, "Payload nesting or reserved keys not permitted");
  }
  if (!isPlainObject(parsed)) {
    return jsonError(400, "Invalid selector output shape");
  }
  const snapshot = stripDebugFromSnapshot(parsed);
  if (!isSelectorOutputShape(snapshot)) {
    return jsonError(400, "Invalid selector output shape");
  }

  const canon = canonicalizeForSid(snapshot);
  const sid = await computeSid(canon);
  const kvKey = `s:${sid}`;

  // Write-once idempotency (Security P1-5a): if the snapshot already exists,
  // skip the put. Same sid implies byte-identical canonicalized content, so a
  // republished payload that differs only on the (stripped) `timestamp` field
  // cannot mutate the stored value. This prevents the timestamp-spoof
  // overwrite attack where a client re-POSTs different *non-stripped* content
  // colliding under the same sid (impossible by canonicalization, defended
  // here for belt-and-suspenders).
  try {
    const existing = await env.SELECTOR_SNAPSHOTS.get(kvKey, "text");
    if (existing !== null && existing !== "") {
      return new Response(JSON.stringify({ sid }), {
        status: 200,
        headers: STANDARD_RESPONSE_HEADERS,
      });
    }
  } catch {
    // Treat read failure as best-effort; proceed to write.
  }

  try {
    await env.SELECTOR_SNAPSHOTS.put(kvKey, JSON.stringify(snapshot), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("[selector-snapshot] KV write failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }

  return new Response(JSON.stringify({ sid }), {
    status: 200,
    headers: STANDARD_RESPONSE_HEADERS,
  });
}

async function handleGet(context: SelectorSnapshotContext, sid: string): Promise<Response> {
  const { env } = context;
  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  let stored: string | null;
  try {
    stored = await env.SELECTOR_SNAPSHOTS.get(`s:${sid}`, "text");
  } catch (error) {
    console.warn("[selector-snapshot] KV read failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }
  if (stored === null || stored === "") {
    return jsonError(404, "Snapshot not found");
  }

  // Defensive: confirm the stored payload still parses, matches the selector
  // contract, and remains content-addressed by the requested sid. KV should be
  // write-once through this function, but GET still treats mismatches as
  // corrupt values rather than replaying the wrong snapshot.
  let responseBody = stored;
  try {
    const decoded = JSON.parse(stored);
    if (!isStructurallySafe(decoded) || !isPlainObject(decoded)) {
      console.warn("[selector-snapshot] stored payload failed shape check", { sid });
      return jsonError(502, "Snapshot value is malformed");
    }
    if (!isSelectorOutputShape(decoded)) {
      console.warn("[selector-snapshot] stored payload failed shape check", { sid });
      return jsonError(502, "Snapshot value is malformed");
    }
    const storedSid = await computeSid(canonicalizeForSid(decoded));
    if (storedSid !== sid) {
      console.warn("[selector-snapshot] stored payload sid mismatch", {
        requestedSid: sid,
        storedSid,
      });
      return jsonError(502, "Snapshot value is malformed");
    }
    if (Object.prototype.hasOwnProperty.call(decoded, "debug")) {
      responseBody = JSON.stringify(stripDebugFromSnapshot(decoded));
    }
  } catch (error) {
    console.warn("[selector-snapshot] stored payload decode failure", error);
    return jsonError(502, "Snapshot value is malformed");
  }

  return new Response(responseBody, {
    status: 200,
    headers: {
      ...STANDARD_RESPONSE_HEADERS,
      // The endpoint is origin-gated via Origin/Referer. Do not make GET
      // responses public-cacheable, or a shared cache could bypass that gate.
      "Cache-Control": "private, no-store",
    },
  });
}

export const onRequest = async (context: SelectorSnapshotContext): Promise<Response> => {
  const { request, env } = context;
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) {
    return rejected;
  }

  const method = request.method.toUpperCase();
  if (method === "POST") {
    if (hasSnapshotSegments(context.params)) {
      return jsonError(405, "Method not allowed", { Allow: "GET" });
    }
    return handlePost(context);
  }
  if (method === "GET") {
    const sid = resolveSidFromParams(context.params);
    if (!sid) return jsonError(404, "Not found");
    return handleGet(context, sid);
  }
  return jsonError(405, "Method not allowed", { Allow: "GET, POST" });
};
