// Lists held review evidence that is admitted now but loses admission within the
// lookahead window. Two strategies, never mixed:
// - Curated reserve compositions: the production reserve resolver is rerun at
//   both clocks; its source-strength, 120-day evidence and whole-asset
//   denominator rules remain authoritative. Availability labels are not
//   reserve facts.
// - Other active evidence families (execution reviews, supply plans/partitions/
//   exclusions, native single-route supply, mint/bridge scoped controls and
//   questions, transfer scopes, scoped reserve observations, bounded reserve
//   facts): the effective boundary is derived from each record's original
//   authored clocks plus the canonical policy budget. The frozen input is never
//   replayed at +N days, because hourly source observations would go stale
//   independently and be misattributed as review expiry. Current admission is
//   a separate join against exported admission functions or the captured
//   pipeline; a missing join is `unknown`, never healthy.
// Wrapper-allocation and operational-resilience overlay dates are an
// inactive/history census only: never renewals, never grade impact.
//
// Usage:
//   npm run safety-score-v9:expiry-queue -- \
//     --replay <replay-v9.json> [--days <lookahead, default 10> | --horizon <YYYY-MM-DD>] \
//     [--by-week] [--output <markdown path, default stdout>]
// `--horizon` is an absolute cut-off: the window ends at that date's exclusive
// UTC start, so every row expiring before that instant is in scope.
// `--by-week` adds a renewal calendar grouping the upcoming rows by the UTC
// Monday-start week containing their effective boundary; the default report is
// byte-identical without it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import executionReviewRegistry from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import reserveBoundFactRegistry from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";
import supplyAttributionRegistry from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import transferReviewRegistry from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import wrapperReviewRegistry from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import {
  compileReviewedControlScope,
  v1005ReviewIsCurrent,
  weightedReviewIsCurrent,
} from "@shared/lib/safety-score-v9/control-scope";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC, V9_SCOPED_QUESTION_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { exitExecutionReviewDigest } from "@shared/lib/safety-score-v9/exit-execution";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { admitV10ReserveObservation, resolveV10ReserveObservationDeploymentRefs } from "@shared/lib/safety-score-v9/reserve-scope";
import { parseBoundedDateSec } from "@shared/lib/safety-score-v9/review-evidence";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ExitExecutionModelReviewSchema } from "@shared/types/exit-route";
import { ReserveBoundedFactSchema } from "@shared/types/reserve-bounded-facts";
import {
  V9ControlExecutionScopeSchema,
  V9WeightedQuorumSchema,
  type V1005AuthorityGraph,
} from "@shared/types/safety-score-v9-control-scope";
import { ReserveObservationEnvelopeSchema } from "@shared/types/safety-score-v9-reserve-scope";
import { resolveReviewedReserveAdmission } from "../src/lib/safety-score-v9/extension-reserves";
import { REVIEWED_ECONOMIC_SUPPLY_PLAN_QUARANTINES } from "../src/lib/safety-score-v9/supply-attribution-contract";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

const USAGE = `Usage: npm run safety-score-v9:expiry-queue -- --replay <path> [--days <n> | --horizon <YYYY-MM-DD>] [--by-week] [--output <path>]`;

const ReplaySchema = z
  .object({
    pipeline: z
      .object({
        fixedInput: z
          .object({
            clockSec: z.number().int().positive(),
            liveReserveMap: z.record(z.string(), z.unknown()).default({}),
            liveToFallbackCoins: z.array(z.string()).default([]),
            baseInputGenerationId: z.string().optional(),
            sourceGeneration: z.string().optional(),
          })
          .loose(),
        // Family joins. Absence is a census error (partial report), never an
        // empty healthy queue; per-asset shapes are parsed leniently below so
        // one malformed asset cannot reject the cohort.
        extension: z.object({ assets: z.array(z.unknown()) }).loose().optional(),
        compiledFacts: z.object({ assets: z.array(z.unknown()) }).loose().optional(),
        evaluatedSet: z
          .object({
            assets: z.array(
              z
                .object({
                  assetId: z.string(),
                  stressState: z
                    .object({
                      exitPortfolio: z
                        .object({ circulatingUsd: z.number().finite().nonnegative().nullable().optional() })
                        .loose()
                        .nullable()
                        .optional(),
                    })
                    .loose()
                    .optional(),
                })
                .loose(),
            ),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

type Meta = (typeof ACTIVE_META_BY_ID) extends ReadonlyMap<string, infer M> ? M : never;
type Replay = z.infer<typeof ReplaySchema>;

export interface CensusDiagnostic {
  family: string;
  assetId: string | null;
  scope: string;
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface QueueRow {
  assetId: string;
  compositionAsOf: string;
  ageDays: number;
  supplyUsd: number | null;
  supplyAvailability: "known" | "unavailable";
  supplyUnavailableReason: "missing-captured-supply" | null;
  hasCollateralLinks: boolean;
  adapterState: "none" | "silent-this-cycle";
}

/**
 * Absolute date cut-off (`--horizon`). The report window is half-open:
 * `[capture clock, startSec)` — a row whose last admitted second is `startSec`
 * or later is outside the window, so the named date itself is excluded.
 */
export interface CurationExpiryHorizon {
  /** UTC date (YYYY-MM-DD) named by the operator. */
  date: string;
  /** Exclusive window end: the UTC start of `date`. */
  startSec: number;
}

/** Parse `--horizon`; `null` for anything that is not a real UTC calendar date. */
export function parseCurationExpiryHorizon(date: string): CurationExpiryHorizon | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const startSec = Date.parse(`${date}T00:00:00Z`) / 1_000;
  // Round-trip rejects out-of-range dates (for example 2027-02-30) that some
  // engines would otherwise roll forward.
  if (!Number.isFinite(startSec) || isoSec(startSec).slice(0, 10) !== date) return null;
  return { date, startSec };
}

export function buildCurationExpiryQueue(
  replay: z.infer<typeof ReplaySchema>,
  lookaheadDays: number,
  metaById: ReadonlyMap<string, Meta> = ACTIVE_META_BY_ID,
  diagnostics?: CensusDiagnostic[],
  horizon: CurationExpiryHorizon | null = null,
): QueueRow[] {
  const { fixedInput, evaluatedSet } = replay.pipeline;
  const supplyByAssetId = new Map(
    evaluatedSet.assets.map((asset) => [
      asset.assetId,
      asset.stressState?.exitPortfolio?.circulatingUsd ?? null,
    ]),
  );
  const futureClockSec = horizon === null ? fixedInput.clockSec + lookaheadDays * 86_400 : horizon.startSec;
  const rows: QueueRow[] = [];
  for (const [assetId, meta] of metaById) {
    const liveRows = fixedInput.liveReserveMap[assetId];
    // Skips only this reserve-composition branch; other families are enumerated
    // independently in buildCurationExpiryReport().
    if (Array.isArray(liveRows) && liveRows.length > 0) continue;
    const admitAt = (clockSec: number) =>
      resolveReviewedReserveAdmission({
        meta,
        clockSec,
        liveReserveRows: [],
      }).projected;
    // Currently-inadmissible compositions already surface in the worklist's
    // RESV/DEP streams; this queue is preventive and lists only admitted
    // compositions that stop being admitted within the lookahead.
    let admittedNow: boolean;
    let admittedLater: boolean;
    try {
      admittedNow = admitAt(fixedInput.clockSec) !== null;
      admittedLater = admitAt(futureClockSec) !== null;
    } catch (error) {
      // With a diagnostics sink the malformed asset is isolated; without one
      // (direct callers) the original fail-fast behaviour is preserved.
      if (!diagnostics) throw error;
      diagnostics.push({ family: "reserve-composition", assetId, scope: "reserveReview", message: errorMessage(error) });
      continue;
    }
    if (!admittedNow) continue;
    if (admittedLater) continue;
    const review = meta.reserveReview;
    const reserves = meta.reserves ?? [];
    if (reserves.length === 0 || review?.compositionAsOf == null) continue;
    const compositionSec = Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000;
    if (!Number.isFinite(compositionSec)) continue;
    rows.push({
      assetId,
      compositionAsOf: review.compositionAsOf,
      ageDays: Math.round(((fixedInput.clockSec - compositionSec) / 86_400) * 10) / 10,
      supplyUsd: supplyByAssetId.get(assetId) ?? null,
      supplyAvailability: supplyByAssetId.get(assetId) == null ? "unavailable" : "known",
      supplyUnavailableReason: supplyByAssetId.get(assetId) == null ? "missing-captured-supply" : null,
      hasCollateralLinks: reserves.some(
        (slice) => slice.coinId != null && (slice.depType ?? "collateral") === "collateral",
      ),
      adapterState: meta.liveReservesConfig != null ? "silent-this-cycle" : "none",
    });
  }
  // Unknowns require review, not a fabricated zero/smallest-supply ranking.
  return rows.sort((left, right) => {
    if (left.supplyUsd === null && right.supplyUsd !== null) return -1;
    if (right.supplyUsd === null && left.supplyUsd !== null) return 1;
    return (right.supplyUsd ?? 0) - (left.supplyUsd ?? 0) || left.assetId.localeCompare(right.assetId);
  });
}

export function renderCurationExpiryQueue(
  rows: readonly QueueRow[],
  lookaheadDays: number | null,
  horizon: CurationExpiryHorizon | null = null,
): string {
  const windowLabel = horizon === null ? `lookahead ${lookaheadDays}d` : `horizon ${horizon.date}, exclusive UTC start`;
  const lines = [
    `# Curated reserve pre-expiry queue (${windowLabel})`,
    "",
    `Queue supply: ${rows.filter((row) => row.supplyUsd !== null).length} known, ${rows.filter((row) => row.supplyUsd === null).length} unavailable; known-supply subtotal USD ${rows.reduce((sum, row) => sum + (row.supplyUsd ?? 0), 0).toLocaleString("en-US")} (not a full-cohort total).`,
    "",
    rows.length === 0
      ? horizon === null
        ? "No admitted curated composition expires within the lookahead window."
        : `No admitted curated composition stops being admitted before ${horizon.date}T00:00:00Z.`
      : `| Asset | Supply (USD) | Supply availability | compositionAsOf | Age (d) | Dependency links | Adapter |`,
  ];
  if (rows.length > 0) {
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.assetId} | ${row.supplyUsd === null ? "unavailable" : Math.round(row.supplyUsd).toLocaleString("en-US")} | ${row.supplyUnavailableReason ?? row.supplyAvailability} | ${row.compositionAsOf} | ${row.ageDays} | ${row.hasCollateralLinks ? "yes" : "no"} | ${row.adapterState} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Active evidence families (authored-clock projection + separate admission join)
// ---------------------------------------------------------------------------

export type EvidenceFamily =
  | "execution-review"
  | "supply-plan"
  | "supply-partition"
  | "supply-row-exclusion"
  | "supply-native-single-route"
  | "mint-control"
  | "bridge-control"
  | "scoped-control-question"
  | "transfer-review"
  | "transfer-scope"
  | "reserve-observation"
  | "reserve-bound-fact";

export const EVIDENCE_FAMILIES: readonly EvidenceFamily[] = [
  "execution-review", "supply-plan", "supply-partition", "supply-row-exclusion", "supply-native-single-route",
  "mint-control", "bridge-control", "scoped-control-question", "transfer-review", "transfer-scope",
  "reserve-observation", "reserve-bound-fact",
];

export type EvidenceDisposition = "admitted" | "rejected" | "lapsed" | "unknown" | "inactive";

/** One authored deadline term. Exclusive terms are no longer admitted at `atSec`. */
interface BoundaryTerm {
  label: string;
  atSec: number;
  inclusive: boolean;
}

interface AdmissionResult {
  state: "admitted" | "rejected" | "unknown";
  reason: string | null;
}

export interface EvidenceFamilyRow {
  family: EvidenceFamily;
  assetId: string;
  /** Full record identity within family + asset (digest, fact key, controller/route/question or JSON pointer). */
  scope: string;
  source: string;
  clocks: string;
  controllingBudget: string;
  boundarySec: number;
  boundarySemantics: "inclusive" | "exclusive";
  /** Last second at which the authored clocks still admit the record. */
  lastAdmittedSec: number;
  disposition: EvidenceDisposition;
  reason: string | null;
  supplyUsd: number | null;
  supplyUnavailableReason: "missing-captured-supply" | null;
}

export interface EvidenceFamilyCensus {
  family: EvidenceFamily;
  records: number;
  upcoming: number;
  lapsed: number;
  later: number;
  inactive: number;
  admitted: number;
  rejected: number;
  unknown: number;
}

export interface InactiveHistoryCensus {
  registry: string;
  disposition: "inactive" | "history";
  records: number | null;
  datedRecords: number;
  datesPassed: number;
  datesWithinLookahead: number;
  note: string;
}

export interface ProducerRefreshedCensus {
  family: "reserve-observation" | "reserve-bound-fact";
  records: number;
  note: string;
}

/** Canonical authored registries; injectable so tests never depend on live registry counts. */
export interface CurationExpirySources {
  metaById: ReadonlyMap<string, Meta>;
  executionReviews: readonly unknown[];
  supplyAttribution: {
    reviews?: readonly unknown[];
    providerChainPartitionReviews?: readonly unknown[];
    providerRowExclusionReviews?: readonly unknown[];
    nativeSingleRouteReviews?: readonly unknown[];
  };
  economicPlanQuarantines: ReadonlyMap<string, unknown>;
  transferReviews: readonly unknown[];
  reserveBoundFacts: Readonly<Record<string, readonly unknown[]>>;
  wrapperReviews: { reviews?: readonly unknown[]; localReviews?: readonly unknown[] };
  /** null: no authored registry exists in this checkout (no production loader). */
  operationalResilienceOverlays: readonly unknown[] | null;
}

const OPERATIONAL_RESILIENCE_OVERLAYS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
);

function loadOperationalResilienceOverlays(): readonly unknown[] | null {
  if (!existsSync(OPERATIONAL_RESILIENCE_OVERLAYS_PATH)) return null;
  const parsed = JSON.parse(readFileSync(OPERATIONAL_RESILIENCE_OVERLAYS_PATH, "utf8")) as { overlays?: unknown[]; reviews?: unknown[] };
  return parsed.overlays ?? parsed.reviews ?? [];
}

export function defaultCurationExpirySources(): CurationExpirySources {
  return {
    metaById: ACTIVE_META_BY_ID,
    executionReviews: executionReviewRegistry.reviews,
    supplyAttribution: supplyAttributionRegistry,
    economicPlanQuarantines: REVIEWED_ECONOMIC_SUPPLY_PLAN_QUARANTINES,
    transferReviews: transferReviewRegistry.reviews,
    reserveBoundFacts: (reserveBoundFactRegistry as { assets: Record<string, unknown[]> }).assets,
    wrapperReviews: wrapperReviewRegistry,
    operationalResilienceOverlays: loadOperationalResilienceOverlays(),
  };
}

export interface CurationExpiryReport {
  /** Relative lookahead days; null when an absolute `horizon` sets the window. */
  lookaheadDays: number | null;
  /** Absolute cut-off when `--horizon` was used; null for a relative lookahead. */
  horizon: CurationExpiryHorizon | null;
  capture: { clockSec: number; baseInputGenerationId: string | null; sourceGeneration: string | null };
  extractedAtSec: number;
  status: "complete" | "partial";
  diagnostics: CensusDiagnostic[];
  reserveRows: QueueRow[];
  upcoming: EvidenceFamilyRow[];
  lapsed: EvidenceFamilyRow[];
  census: EvidenceFamilyCensus[];
  producerRefreshed: ProducerRefreshedCensus[];
  inactiveHistory: InactiveHistoryCensus[];
}

const DAY_SEC = 86_400;
const POLICY = V9_CANDIDATE_POLICY_V1.policy;
const EXPIRY = POLICY.semantic.evidence.evidenceExpiry;

function dateStartSec(date: string): number {
  const sec = Date.parse(`${date}T00:00:00Z`) / 1_000;
  if (!Number.isFinite(sec)) throw new Error(`invalid date ${JSON.stringify(date)}`);
  return sec;
}

function instantSec(value: string, rounding: "floor" | "ceil"): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid instant ${JSON.stringify(value)}`);
  return rounding === "floor" ? Math.floor(ms / 1_000) : Math.ceil(ms / 1_000);
}

function isoSec(sec: number): string {
  return new Date(sec * 1_000).toISOString().replace(".000Z", "Z");
}

function lastAdmitted(term: BoundaryTerm): number {
  return term.inclusive ? term.atSec : term.atSec - 1;
}

/** The earliest term controls; ties keep the first (explicit expiry is listed first). */
function controllingTerm(terms: readonly BoundaryTerm[]): BoundaryTerm {
  return terms.reduce((best, term) => (lastAdmitted(term) < lastAdmitted(best) ? term : best));
}

const RecordObject = z.record(z.string(), z.unknown());
const SupplyWindowSchema = z.object({
  assetId: z.string().min(1),
  reviewedAtSec: z.number().int().nonnegative(),
  expiresAtSec: z.number().int().nonnegative(),
}).loose();
const NativeSingleRouteSchema = z.object({ assetId: z.string().min(1), routeId: z.string().min(1), reviewedAt: z.string() }).loose();
const TransferReviewSchema = z.object({
  assetId: z.string().min(1),
  reviewedAt: z.string(),
  transferScopeAttestation: z.object({ reviewedAt: z.string(), expiresAt: z.string(), deploymentKey: z.string() }).loose().optional(),
}).loose();
const CompiledAssetSchema = z.object({
  assetId: z.string(),
  exitRoutes: z.array(z.object({
    routeKey: z.string(),
    scoreEligible: z.boolean(),
    executionCertificate: z.object({ reviewDigest: z.string() }).loose().optional(),
  }).loose()).optional(),
  reserveBoundFacts: z.array(z.object({
    fact: z.object({ factKey: z.string() }).loose(),
    rejectionReason: z.string().nullable(),
  }).loose()).optional(),
}).loose();
const ExtensionAssetSchema = z.object({
  assetId: z.string(),
  supplyReview: z.object({
    selectedBridgeRoutes: z.array(z.object({ deploymentRouteKey: z.string(), supplyShare: z.number().nullable() }).loose()),
    providerRowExclusions: z.array(z.object({
      review: z.object({ assetId: z.string(), chainId: z.string(), contractAddress: z.string() }).loose(),
    }).loose()).optional(),
  }).loose().nullable(),
}).loose();

interface ReplayJoins {
  compiled: Map<string, z.infer<typeof CompiledAssetSchema>> | null;
  extension: Map<string, z.infer<typeof ExtensionAssetSchema>> | null;
  economicModelById: Record<string, string | undefined>;
}

function indexAssets<T extends { assetId: string }>(
  label: string,
  assets: readonly unknown[] | undefined,
  schema: z.ZodType<T>,
  diagnostics: CensusDiagnostic[],
): Map<string, T> | null {
  if (assets === undefined) {
    diagnostics.push({ family: "replay", assetId: null, scope: label, message: `replay-field-missing:${label}` });
    return null;
  }
  const byId = new Map<string, T>();
  for (const [index, raw] of assets.entries()) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const assetId = RecordObject.safeParse(raw).data?.assetId;
      diagnostics.push({ family: "replay", assetId: typeof assetId === "string" ? assetId : null, scope: `${label}/${index}`, message: `malformed-replay-asset: ${parsed.error.issues[0]?.message ?? "invalid"}` });
      continue;
    }
    byId.set(parsed.data.assetId, parsed.data);
  }
  return byId;
}

function unknownJoin(reason: string): AdmissionResult {
  return { state: "unknown", reason };
}

interface Projection {
  family: EvidenceFamily;
  assetId: string;
  scope: string;
  source: string;
  clocks: Record<string, string | number | null | undefined>;
  /** Earliest admitted second, when an authored start clock exists. */
  startSec: number | null;
  terms: readonly BoundaryTerm[];
  /** Current admission at the capture clock; evaluated only for unlapsed effective records. */
  admission: () => AdmissionResult;
  inactiveReason?: string;
}

interface ControlRecord {
  kind: "execution-scope" | "weighted-quorum" | "process-review" | "scoped-question";
  pointer: string;
  value: Record<string, unknown>;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const V1005_REVIEW_KEYS = ["expiresAt", "observedAt", "pin", "reviewedAt", "reviewer"].join(",");

/** Walk one hydrated control profile and return its dated review records by JSON pointer. */
function collectControlRecords(value: unknown, pointer: string, out: ControlRecord[] = []): ControlRecord[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectControlRecords(entry, `${pointer}/${index}`, out));
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (typeof record.controllerDeployment === "string" && Array.isArray(record.paths) &&
      isDateString(record.reviewedAt) && isDateString(record.observedAt) && isDateString(record.expiresAt)) {
    out.push({ kind: "execution-scope", pointer, value: record });
  } else if (Array.isArray(record.signers) && typeof record.quorum === "number" &&
      isDateString(record.reviewedAt) && isDateString(record.expiresAt)) {
    out.push({ kind: "weighted-quorum", pointer, value: record });
  } else if (Object.keys(record).sort().join(",") === V1005_REVIEW_KEYS) {
    out.push({ kind: "process-review", pointer, value: record });
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "scopedQuestions" && Array.isArray(child)) {
      child.forEach((question, index) => {
        if (question !== null && typeof question === "object") {
          out.push({ kind: "scoped-question", pointer: `${pointer}/${key}/${index}`, value: question as Record<string, unknown> });
        }
      });
      continue;
    }
    collectControlRecords(child, `${pointer}/${key}`, out);
  }
  return out;
}

function controlProjection(
  family: "mint-control" | "bridge-control",
  assetId: string,
  record: ControlRecord,
  clockSec: number,
): Projection {
  const { value, pointer } = record;
  const source = `meta.${pointer}`;
  const maxAgeLabel = `reviewedResearchMaxAgeSec (${V9_REVIEW_EVIDENCE_MAX_AGE_SEC}s)`;
  if (record.kind === "execution-scope") {
    const scope = V9ControlExecutionScopeSchema.parse(value);
    const reviewed = dateStartSec(scope.reviewedAt), observed = dateStartSec(scope.observedAt);
    return {
      family, assetId, scope: `execution-scope ${scope.controllerDeployment} ${pointer}`, source,
      clocks: { reviewedAt: scope.reviewedAt, observedAt: scope.observedAt, expiresAt: scope.expiresAt },
      startSec: Math.max(reviewed, observed),
      terms: [
        { label: "explicit expiresAt", atSec: dateStartSec(scope.expiresAt), inclusive: true },
        { label: `observedAt + ${maxAgeLabel}`, atSec: observed + V9_REVIEW_EVIDENCE_MAX_AGE_SEC, inclusive: true },
      ],
      admission: () => {
        const projection = compileReviewedControlScope(scope, scope.controllerDeployment, assetId, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC);
        if (projection.complete) return { state: "admitted", reason: null };
        if (projection.reviewed) return { state: "admitted", reason: "reviewed-scope-inventory-incomplete" };
        return { state: "rejected", reason: projection.diagnostics.join(",") };
      },
    };
  }
  if (record.kind === "weighted-quorum") {
    const quorum = V9WeightedQuorumSchema.parse(value);
    const reviewed = dateStartSec(quorum.reviewedAt);
    return {
      family, assetId, scope: `weighted-quorum ${quorum.deployment} ${pointer}`, source,
      clocks: { reviewedAt: quorum.reviewedAt, expiresAt: quorum.expiresAt, status: quorum.status },
      startSec: reviewed,
      terms: [
        { label: "explicit expiresAt", atSec: dateStartSec(quorum.expiresAt), inclusive: true },
        { label: `reviewedAt + ${maxAgeLabel}`, atSec: reviewed + V9_REVIEW_EVIDENCE_MAX_AGE_SEC, inclusive: true },
      ],
      admission: () => weightedReviewIsCurrent(quorum, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
        ? { state: "admitted", reason: null }
        : { state: "rejected", reason: `weighted-quorum-not-current:status=${quorum.status}` },
    };
  }
  if (record.kind === "process-review") {
    const review = value as unknown as V1005AuthorityGraph["review"];
    if (!isDateString(review.observedAt) || !isDateString(review.reviewedAt) || !isDateString(review.expiresAt) ||
        typeof review.pin?.timestamp !== "string") throw new Error("malformed process review clocks");
    const observed = dateStartSec(review.observedAt);
    return {
      family, assetId, scope: `process-review ${pointer}`, source,
      clocks: { observedAt: review.observedAt, reviewedAt: review.reviewedAt, expiresAt: review.expiresAt, pinTimestamp: review.pin.timestamp },
      startSec: Math.max(dateStartSec(review.reviewedAt), instantSec(review.pin.timestamp, "ceil")),
      terms: [
        { label: "explicit expiresAt", atSec: dateStartSec(review.expiresAt), inclusive: true },
        { label: `observedAt + ${maxAgeLabel}`, atSec: observed + V9_REVIEW_EVIDENCE_MAX_AGE_SEC, inclusive: true },
      ],
      admission: () => v1005ReviewIsCurrent(review, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
        ? { state: "admitted", reason: null }
        : { state: "rejected", reason: "process-review-not-current" },
    };
  }
  const reviewedAt = value.reviewedAt, controlRef = value.controlRef;
  if (typeof reviewedAt !== "string" || typeof controlRef !== "string") throw new Error("malformed scoped question");
  // Same date semantics as production (date-only = UTC midnight); no clock bound here.
  const reviewedSec = parseBoundedDateSec(reviewedAt, Number.MAX_SAFE_INTEGER, `${assetId}:scoped-question`);
  return {
    family: "scoped-control-question", assetId, scope: `${family} ${controlRef} ${pointer}`, source,
    clocks: { reviewedAt },
    startSec: reviewedSec,
    terms: [{ label: `reviewedAt + scoped-question max age (${V9_SCOPED_QUESTION_MAX_AGE_SEC}s)`, atSec: reviewedSec + V9_SCOPED_QUESTION_MAX_AGE_SEC, inclusive: true }],
    // The freshness gate is production's; whether the question softens a control is not assessed.
    admission: () => ({ state: "admitted", reason: "fresh; control softening not assessed" }),
  };
}

function reserveBoundProjection(assetId: string, index: number, raw: unknown, joins: ReplayJoins): Projection {
  const fact = ReserveBoundedFactSchema.parse(raw);
  const kindMaxAge = fact.kind === "currently-liquid-fraction"
    ? { label: "boundedFacts.currentLiquidFractionMaxAgeSec", sec: POLICY.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec }
    : fact.kind === "observed-portfolio-maturity"
      ? { label: "reviewedReserveComposition max age + grace", sec: EXPIRY.reviewedReserveCompositionMaxAgeSec + EXPIRY.reviewedReserveCompositionGraceSec }
      : { label: "reviewedReserveClassificationMaxAgeSec", sec: EXPIRY.reviewedReserveClassificationMaxAgeSec };
  const terms: BoundaryTerm[] = [{ label: `asOfSec + ${kindMaxAge.label} (${kindMaxAge.sec}s)`, atSec: fact.asOfSec + kindMaxAge.sec, inclusive: true }];
  let startSec = fact.asOfSec;
  const clocks: Projection["clocks"] = { asOfSec: isoSec(fact.asOfSec) };
  let producer = false;
  if (fact.provenance.kind === "reviewed-research") {
    // Date-only research admits at the next UTC midnight and ages from there.
    const reviewSec = dateStartSec(fact.provenance.reviewedAt) + DAY_SEC;
    clocks.reviewedAt = fact.provenance.reviewedAt;
    startSec = Math.max(startSec, reviewSec);
    terms.unshift({ label: `reviewedAt next UTC midnight + reviewedReserveClassificationMaxAgeSec (${EXPIRY.reviewedReserveClassificationMaxAgeSec}s)`, atSec: reviewSec + EXPIRY.reviewedReserveClassificationMaxAgeSec, inclusive: true });
  } else {
    producer = true;
    terms.push({ label: "producer provenance maxAgeSec", atSec: fact.asOfSec + fact.provenance.maxAgeSec, inclusive: true });
  }
  return {
    family: "reserve-bound-fact", assetId, scope: fact.factKey,
    source: `reserve-bound-facts-v1.json#/assets/${assetId}/${index}`, clocks, startSec, terms,
    admission: () => {
      if (producer) return unknownJoin("producer-run-caps-not-reproduced");
      if (!joins.compiled) return unknownJoin("replay-compiled-facts-missing");
      const compiled = joins.compiled.get(assetId)?.reserveBoundFacts?.find((row) => row.fact.factKey === fact.factKey);
      if (!compiled) return unknownJoin("not-selected-or-not-compiled");
      return compiled.rejectionReason === null
        ? { state: "admitted", reason: null }
        : { state: "rejected", reason: compiled.rejectionReason };
    },
  };
}

function enumerateProjections(
  replay: Replay,
  sources: CurationExpirySources,
  joins: ReplayJoins,
  diagnostics: CensusDiagnostic[],
  producerRefreshed: ProducerRefreshedCensus[],
): Projection[] {
  const { fixedInput } = replay.pipeline;
  const clockSec = fixedInput.clockSec;
  const projections: Projection[] = [];
  const isolate = (family: string, assetId: string | null, scope: string, build: () => void) => {
    try {
      build();
    } catch (error) {
      diagnostics.push({ family, assetId, scope, message: errorMessage(error) });
    }
  };

  // Execution reviews: current through the explicit instant (whole second).
  const routesByDigest = new Map<string, { assetId: string; scoreEligible: boolean }[]>();
  for (const asset of joins.compiled?.values() ?? []) {
    for (const route of asset.exitRoutes ?? []) {
      const digest = route.executionCertificate?.reviewDigest;
      if (!digest) continue;
      routesByDigest.set(digest, [...(routesByDigest.get(digest) ?? []), { assetId: asset.assetId, scoreEligible: route.scoreEligible }]);
    }
  }
  sources.executionReviews.forEach((raw, index) => {
    const source = `exit-execution-model-reviews-v1.json#/reviews/${index}`;
    isolate("execution-review", null, source, () => {
      const review = ExitExecutionModelReviewSchema.parse(raw);
      const digest = exitExecutionReviewDigest(review);
      const assetId = review.identity.assetId;
      const enabled = POLICY.semantic.exit.executionModels[review.modelId]?.admission === "enabled";
      projections.push({
        family: "execution-review", assetId, scope: `${review.modelId} ${review.identity.deployment} digest:${digest}`, source,
        clocks: { reviewedAt: review.reviewedAt, expiresAt: review.expiresAt },
        startSec: instantSec(review.reviewedAt, "ceil"),
        terms: [{ label: "explicit expiresAt", atSec: instantSec(review.expiresAt, "floor"), inclusive: true }],
        ...(enabled ? {} : { inactiveReason: "execution-model-not-enabled" }),
        admission: () => {
          if (!joins.compiled) return unknownJoin("replay-compiled-facts-missing");
          const routes = (routesByDigest.get(digest) ?? []).filter((route) => route.assetId === assetId);
          if (routes.length === 0) return unknownJoin("no-captured-certificate-for-review");
          return routes.some((route) => route.scoreEligible)
            ? { state: "admitted", reason: "score-eligible certificate route" }
            : { state: "rejected", reason: "certificate-route-not-score-eligible" };
        },
      });
    });
  });

  const supplyFile = "supply-attribution-reviews-v1.json";
  const exclusive = (label: string, atSec: number): BoundaryTerm => ({ label, atSec, inclusive: false });
  (sources.supplyAttribution.reviews ?? []).forEach((raw, index) => {
    const source = `${supplyFile}#/reviews/${index}`;
    isolate("supply-plan", null, source, () => {
      const row = SupplyWindowSchema.parse(raw);
      projections.push({
        family: "supply-plan", assetId: row.assetId, scope: "economic-deployment-plan", source,
        clocks: { reviewedAtSec: isoSec(row.reviewedAtSec), expiresAtSec: isoSec(row.expiresAtSec) },
        startSec: row.reviewedAtSec, terms: [exclusive("explicit expiresAtSec", row.expiresAtSec)],
        admission: () => {
          if (sources.economicPlanQuarantines.has(row.assetId)) return { state: "rejected", reason: "registry-quarantine" };
          if (!joins.extension) return unknownJoin("replay-extension-missing");
          const model = joins.economicModelById[row.assetId];
          if (model !== "reviewed-economic-deployment-partition-v1") return unknownJoin("economic-packet-not-captured");
          const asset = joins.extension.get(row.assetId);
          if (!asset) return unknownJoin("asset-absent-from-extension");
          return asset.supplyReview !== null
            ? { state: "admitted", reason: null }
            : { state: "rejected", reason: "economic-packet-not-admitted" };
        },
      });
    });
  });
  (sources.supplyAttribution.providerChainPartitionReviews ?? []).forEach((raw, index) => {
    const source = `${supplyFile}#/providerChainPartitionReviews/${index}`;
    isolate("supply-partition", null, source, () => {
      const row = SupplyWindowSchema.extend({ chainId: z.string() }).parse(raw);
      projections.push({
        family: "supply-partition", assetId: row.assetId, scope: `chain:${row.chainId}`, source,
        clocks: { reviewedAtSec: isoSec(row.reviewedAtSec), expiresAtSec: isoSec(row.expiresAtSec) },
        startSec: row.reviewedAtSec, terms: [exclusive("explicit expiresAtSec", row.expiresAtSec)],
        admission: () => unknownJoin("partition-admission-join-not-reproduced"),
      });
    });
  });
  (sources.supplyAttribution.providerRowExclusionReviews ?? []).forEach((raw, index) => {
    const source = `${supplyFile}#/providerRowExclusionReviews/${index}`;
    isolate("supply-row-exclusion", null, source, () => {
      const row = SupplyWindowSchema.extend({ chainId: z.string(), contractAddress: z.string() }).parse(raw);
      projections.push({
        family: "supply-row-exclusion", assetId: row.assetId, scope: `${row.chainId}:${row.contractAddress}`, source,
        clocks: { reviewedAtSec: isoSec(row.reviewedAtSec), expiresAtSec: isoSec(row.expiresAtSec) },
        startSec: row.reviewedAtSec, terms: [exclusive("explicit expiresAtSec", row.expiresAtSec)],
        admission: () => {
          if (!joins.extension) return unknownJoin("replay-extension-missing");
          const review = joins.extension.get(row.assetId)?.supplyReview;
          if (!review) return unknownJoin("no-captured-supply-review");
          return review.providerRowExclusions?.some((entry) => entry.review.chainId === row.chainId &&
            entry.review.contractAddress === row.contractAddress)
            ? { state: "admitted", reason: null }
            : { state: "rejected", reason: "provider-row-exclusion-not-admitted" };
        },
      });
    });
  });
  const supplyReviewMaxAgeDays = POLICY.semantic.supplyAttribution.reviewMaxAgeDays;
  (sources.supplyAttribution.nativeSingleRouteReviews ?? []).forEach((raw, index) => {
    const source = `${supplyFile}#/nativeSingleRouteReviews/${index}`;
    isolate("supply-native-single-route", null, source, () => {
      const row = NativeSingleRouteSchema.parse(raw);
      const reviewedSec = dateStartSec(row.reviewedAt);
      projections.push({
        family: "supply-native-single-route", assetId: row.assetId, scope: `route:${row.routeId}`, source,
        clocks: { reviewedAt: row.reviewedAt }, startSec: reviewedSec,
        terms: [{ label: `reviewedAt + supplyAttribution.reviewMaxAgeDays (${supplyReviewMaxAgeDays}d)`, atSec: reviewedSec + supplyReviewMaxAgeDays * DAY_SEC, inclusive: true }],
        admission: () => {
          if (!joins.extension) return unknownJoin("replay-extension-missing");
          const review = joins.extension.get(row.assetId)?.supplyReview;
          if (!review) return unknownJoin("no-captured-supply-review");
          const routes = review.selectedBridgeRoutes;
          return routes.length === 1 && routes[0]!.deploymentRouteKey === row.routeId && routes[0]!.supplyShare === 1
            ? { state: "admitted", reason: "captured supply review selects the reviewed route" }
            : { state: "rejected", reason: "captured-supply-review-does-not-select-route" };
        },
      });
    });
  });

  // Transfer reviews and nested scope attestations keep independent clocks.
  sources.transferReviews.forEach((raw, index) => {
    const source = `transfer-review-overlays-v1.json#/reviews/${index}`;
    isolate("transfer-review", null, source, () => {
      const review = TransferReviewSchema.parse(raw);
      const reviewedSec = dateStartSec(review.reviewedAt);
      projections.push({
        family: "transfer-review", assetId: review.assetId, scope: "transfer-review", source,
        clocks: { reviewedAt: review.reviewedAt }, startSec: reviewedSec,
        terms: [{ label: `reviewedAt + accessReviewMaxAgeSec (${V9_ACCESS_EVIDENCE_MAX_AGE_SEC}s)`, atSec: reviewedSec + V9_ACCESS_EVIDENCE_MAX_AGE_SEC, inclusive: true }],
        admission: () => unknownJoin("material-scope-join-not-reproduced"),
      });
      const attestation = review.transferScopeAttestation;
      if (!attestation) return;
      const attestedSec = dateStartSec(attestation.reviewedAt);
      projections.push({
        family: "transfer-scope", assetId: review.assetId, scope: `attestation ${attestation.deploymentKey}`,
        source: `${source}/transferScopeAttestation`,
        clocks: { reviewedAt: attestation.reviewedAt, expiresAt: attestation.expiresAt }, startSec: attestedSec,
        terms: [
          exclusive("explicit expiresAt", dateStartSec(attestation.expiresAt)),
          { label: `reviewedAt + reviewedResearchMaxAgeSec (${V9_REVIEW_EVIDENCE_MAX_AGE_SEC}s)`, atSec: attestedSec + V9_REVIEW_EVIDENCE_MAX_AGE_SEC, inclusive: true },
        ],
        admission: () => unknownJoin("material-scope-join-not-reproduced"),
      });
    });
  });

  for (const [assetId, meta] of sources.metaById) {
    for (const [family, profile, root] of [
      ["mint-control", meta.mintAuthority, "mintAuthority"],
      ["bridge-control", meta.bridgeRouteRisk, "bridgeRouteRisk"],
    ] as const) {
      if (!profile) continue;
      for (const record of collectControlRecords(profile, root)) {
        isolate(family, assetId, record.pointer, () => projections.push(controlProjection(family, assetId, record, clockSec)));
      }
    }
    const observations = meta.reserveReview?.observations ?? [];
    observations.forEach((raw, index) => {
      const source = `meta.reserveReview/observations/${index}`;
      isolate("reserve-observation", assetId, source, () => {
        const observation = ReserveObservationEnvelopeSchema.parse(raw);
        const budget = observation.kind === "standing-structure"
          ? { label: "standingStructureMaxAgeSec", sec: EXPIRY.standingStructureMaxAgeSec }
          : observation.kind === "onchain-observation"
            ? { label: "onchainObservationMaxAgeSec", sec: EXPIRY.onchainObservationMaxAgeSec }
            : { label: "reviewedReserveComposition max age + grace", sec: EXPIRY.reviewedReserveCompositionMaxAgeSec + EXPIRY.reviewedReserveCompositionGraceSec };
        const dateSec = observation.observedAtSec ?? observation.reviewedAtSec;
        projections.push({
          family: "reserve-observation", assetId, scope: `${observation.kind} ${observation.scopeId}`, source,
          clocks: { reviewedAtSec: isoSec(observation.reviewedAtSec), observedAtSec: observation.observedAtSec === null ? null : isoSec(observation.observedAtSec), expiresAtSec: isoSec(observation.expiresAtSec) },
          startSec: Math.max(observation.reviewedAtSec, dateSec),
          terms: [
            { label: "explicit expiresAtSec", atSec: observation.expiresAtSec, inclusive: true },
            { label: `${observation.observedAtSec === null ? "reviewedAtSec" : "observedAtSec"} + ${budget.label} (${budget.sec}s)`, atSec: dateSec + budget.sec, inclusive: true },
          ],
          admission: () => {
            const admission = admitV10ReserveObservation({ observation, deploymentRefs: resolveV10ReserveObservationDeploymentRefs(meta), clockSec, policy: POLICY });
            return admission.admitted
              ? { state: "admitted", reason: "scope admitted; contribution not assessed" }
              : { state: "rejected", reason: admission.rejectionCodes.join(",") };
          },
        });
      });
    });
  }
  const liveObservations = Object.values(RecordObject.safeParse(fixedInput.liveReserveProvenanceMap).data ?? {})
    .filter((entry) => RecordObject.safeParse(entry).data?.reserveObservation != null).length;
  producerRefreshed.push({ family: "reserve-observation", records: liveObservations,
    note: "captured live reserveObservation rows are producer-refreshed each cycle; their budgets are not review deadlines" });

  for (const [assetId, rows] of Object.entries(sources.reserveBoundFacts)) {
    rows.forEach((raw, index) => {
      isolate("reserve-bound-fact", assetId, `reserve-bound-facts-v1.json#/assets/${assetId}/${index}`, () =>
        projections.push(reserveBoundProjection(assetId, index, raw, joins)));
    });
  }
  let liveBounds = 0;
  for (const rows of Object.values(fixedInput.liveReserveMap)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const facts = RecordObject.safeParse(row).data?.boundedFacts;
      if (Array.isArray(facts)) liveBounds += facts.length;
    }
  }
  producerRefreshed.push({ family: "reserve-bound-fact", records: liveBounds,
    note: "captured live boundedFacts are producer observations; selection/freshness is owned by the compiled result" });
  return projections;
}

/** Boundary projection only (no admission joins); used for resolver boundary-parity tests. */
export function enumerateEvidenceFamilyBoundaries(replay: Replay, sources: CurationExpirySources = defaultCurationExpirySources()) {
  const diagnostics: CensusDiagnostic[] = [];
  const joins: ReplayJoins = { compiled: null, extension: null, economicModelById: {} };
  const boundaries = enumerateProjections(replay, sources, joins, diagnostics, []).map((projection) => {
    const term = controllingTerm(projection.terms);
    return { family: projection.family, assetId: projection.assetId, scope: projection.scope, source: projection.source, lastAdmittedSec: lastAdmitted(term), controllingBudget: term.label };
  });
  return { boundaries, diagnostics };
}

function authoredDateSec(record: unknown): number[] {
  const row = RecordObject.safeParse(record).data;
  if (!row) return [];
  const dates: number[] = [];
  if (typeof row.expiresAtSec === "number") dates.push(row.expiresAtSec);
  if (isDateString(row.expiresAt)) dates.push(dateStartSec(row.expiresAt));
  return dates;
}

function inactiveHistoryCensus(sources: CurationExpirySources, clockSec: number, horizonSec: number): InactiveHistoryCensus[] {
  const summarize = (records: readonly unknown[]) => {
    const dates = records.map((record) => authoredDateSec(record)).filter((list) => list.length > 0).map((list) => Math.min(...list));
    return {
      records: records.length,
      datedRecords: dates.length,
      datesPassed: dates.filter((sec) => sec < clockSec).length,
      datesWithinLookahead: dates.filter((sec) => sec >= clockSec && sec <= horizonSec).length,
    };
  };
  const operational = sources.operationalResilienceOverlays;
  return [
    { registry: "wrapper-allocation-reviews-v1.json#/reviews", disposition: "inactive", ...summarize(sources.wrapperReviews.reviews ?? []),
      note: "dates carried/validated only; no active compiler consumer — not a renewal" },
    { registry: "wrapper-allocation-reviews-v1.json#/localReviews", disposition: "inactive", ...summarize(sources.wrapperReviews.localReviews ?? []),
      note: "dates carried/validated only; no active compiler consumer — not a renewal" },
    operational === null
      ? { registry: "operational-resilience-overlays-v1.json", disposition: "history", records: null, datedRecords: 0, datesPassed: 0, datesWithinLookahead: 0,
        note: "no authored registry or production loader in this checkout" }
      : { registry: "operational-resilience-overlays-v1.json", disposition: "history", ...summarize(operational),
        note: "no production loader; mint operational issuance reviews are enrolled under mint-control" },
  ];
}

/** Supply is summed once per distinct asset, never per evidence row. */
export function summarizeDistinctAssetSupply(rows: readonly { assetId: string; supplyUsd: number | null }[]) {
  const byAsset = new Map<string, number | null>();
  for (const row of rows) byAsset.set(row.assetId, row.supplyUsd);
  const known = [...byAsset.values()].filter((value): value is number => value !== null);
  return { known: known.length, unavailable: byAsset.size - known.length, knownSubtotalUsd: known.reduce((sum, value) => sum + value, 0) };
}

function compareFamilyRows(left: EvidenceFamilyRow, right: EvidenceFamilyRow): number {
  if (left.supplyUsd === null && right.supplyUsd !== null) return -1;
  if (right.supplyUsd === null && left.supplyUsd !== null) return 1;
  return (right.supplyUsd ?? 0) - (left.supplyUsd ?? 0) ||
    left.lastAdmittedSec - right.lastAdmittedSec ||
    left.family.localeCompare(right.family) ||
    left.assetId.localeCompare(right.assetId) ||
    left.scope.localeCompare(right.scope);
}

export function buildCurationExpiryReport(
  replay: Replay,
  lookaheadDays: number,
  sources: CurationExpirySources = defaultCurationExpirySources(),
  extractedAtSec: number = Math.floor(Date.now() / 1_000),
  horizon: CurationExpiryHorizon | null = null,
): CurationExpiryReport {
  const { fixedInput, evaluatedSet } = replay.pipeline;
  const clockSec = fixedInput.clockSec;
  const windowEndSec = horizon === null ? clockSec + lookaheadDays * DAY_SEC : horizon.startSec;
  const diagnostics: CensusDiagnostic[] = [];
  const reserveRows = buildCurationExpiryQueue(replay, lookaheadDays, sources.metaById, diagnostics, horizon);
  const joins: ReplayJoins = {
    compiled: indexAssets("pipeline.compiledFacts.assets", replay.pipeline.compiledFacts?.assets, CompiledAssetSchema, diagnostics),
    extension: indexAssets("pipeline.extension.assets", replay.pipeline.extension?.assets, ExtensionAssetSchema, diagnostics),
    economicModelById: Object.fromEntries(Object.entries(RecordObject.safeParse(fixedInput.safetyScoreV9SupplyAttributionById).data ?? {})
      .map(([assetId, packet]) => {
        const model = RecordObject.safeParse(packet).data?.model;
        return [assetId, typeof model === "string" ? model : undefined];
      })),
  };
  const supplyByAssetId = new Map(evaluatedSet.assets.map((asset) => [asset.assetId, asset.stressState?.exitPortfolio?.circulatingUsd ?? null]));
  const producerRefreshed: ProducerRefreshedCensus[] = [];
  const projections = enumerateProjections(replay, sources, joins, diagnostics, producerRefreshed);
  const census = new Map(EVIDENCE_FAMILIES.map((family) => [family, {
    family, records: 0, upcoming: 0, lapsed: 0, later: 0, inactive: 0, admitted: 0, rejected: 0, unknown: 0,
  } satisfies EvidenceFamilyCensus]));
  const upcoming: EvidenceFamilyRow[] = [];
  const lapsed: EvidenceFamilyRow[] = [];
  const seen = new Map<string, string>();
  for (const projection of projections) {
    const key = `${projection.family}\u0000${projection.assetId}\u0000${projection.scope}`;
    const fingerprint = stableJsonStringifyV1({ clocks: projection.clocks, terms: projection.terms });
    const prior = seen.get(key);
    if (prior !== undefined) {
      // Aliases of one record merge; conflicting duplicates are a census error.
      if (prior !== fingerprint) {
        diagnostics.push({ family: projection.family, assetId: projection.assetId, scope: projection.scope, message: "duplicate-scope-identity-with-conflicting-clocks" });
      }
      continue;
    }
    seen.set(key, fingerprint);
    const counts = census.get(projection.family)!;
    counts.records += 1;
    if (projection.inactiveReason) {
      counts.inactive += 1;
      continue;
    }
    const term = controllingTerm(projection.terms);
    const lastAdmittedSec = lastAdmitted(term);
    const bucket = lastAdmittedSec < clockSec ? "lapsed" : lastAdmittedSec < windowEndSec ? "upcoming" : "later";
    if (bucket === "later") {
      counts.later += 1;
      continue;
    }
    let disposition: EvidenceDisposition;
    let reason: string | null;
    if (bucket === "lapsed") {
      disposition = "lapsed";
      reason = "boundary-passed-before-capture";
    } else if (projection.startSec !== null && projection.startSec > clockSec) {
      disposition = "rejected";
      reason = "review-not-yet-effective";
    } else {
      let admission: AdmissionResult;
      try {
        admission = projection.admission();
      } catch (error) {
        diagnostics.push({ family: projection.family, assetId: projection.assetId, scope: projection.scope, message: `admission-join-failed: ${errorMessage(error)}` });
        admission = unknownJoin("admission-join-failed");
      }
      disposition = admission.state;
      reason = admission.reason;
      counts[admission.state] += 1;
    }
    counts[bucket] += 1;
    const supplyUsd = supplyByAssetId.get(projection.assetId) ?? null;
    const row: EvidenceFamilyRow = {
      family: projection.family,
      assetId: projection.assetId,
      scope: projection.scope,
      source: projection.source,
      clocks: Object.entries(projection.clocks).filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}=${value ?? "null"}`).join(" "),
      controllingBudget: term.label,
      boundarySec: term.atSec,
      boundarySemantics: term.inclusive ? "inclusive" : "exclusive",
      lastAdmittedSec,
      disposition,
      reason,
      supplyUsd,
      supplyUnavailableReason: supplyByAssetId.has(projection.assetId) ? null : "missing-captured-supply",
    };
    (bucket === "lapsed" ? lapsed : upcoming).push(row);
  }
  return {
    lookaheadDays: horizon === null ? lookaheadDays : null,
    horizon,
    capture: { clockSec, baseInputGenerationId: fixedInput.baseInputGenerationId ?? null, sourceGeneration: fixedInput.sourceGeneration ?? null },
    extractedAtSec,
    status: diagnostics.length > 0 ? "partial" : "complete",
    diagnostics,
    reserveRows,
    upcoming: upcoming.sort(compareFamilyRows),
    lapsed: lapsed.sort(compareFamilyRows),
    census: [...census.values()],
    producerRefreshed,
    inactiveHistory: inactiveHistoryCensus(sources, clockSec, windowEndSec),
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Documented renewal lead time before an effective boundary (ImplDurability §3.2). */
export const RENEWAL_LEAD_TIME_DAYS = 14;

export type RenewalLeadTimeClass = "execution-review" | "scoped-question" | "supply-attribution";

/**
 * Renewal lead-time class per evidence family. Curated reserve compositions are
 * in the `composition` class with the same 14-day lead, but stay in the reserve
 * queue: their exact boundary belongs to the production admission resolver and
 * is not re-derived here.
 */
export const RENEWAL_LEAD_TIME_CLASS_BY_FAMILY: Readonly<Partial<Record<EvidenceFamily, RenewalLeadTimeClass>>> = Object.freeze({
  "execution-review": "execution-review",
  "scoped-control-question": "scoped-question",
  "supply-plan": "supply-attribution",
  "supply-partition": "supply-attribution",
  "supply-row-exclusion": "supply-attribution",
  "supply-native-single-route": "supply-attribution",
});

export interface RenewalCalendarWeek {
  /** UTC Monday (YYYY-MM-DD) that starts the week. */
  weekStart: string;
  rows: EvidenceFamilyRow[];
}

/** UTC Monday-start date of the ISO week containing `sec`. */
export function utcWeekStartDate(sec: number): string {
  const dayStartSec = Math.floor(sec / DAY_SEC) * DAY_SEC;
  const weekday = new Date(dayStartSec * 1_000).getUTCDay();
  return isoSec(dayStartSec - ((weekday + 6) % 7) * DAY_SEC).slice(0, 10);
}

/** Group upcoming rows by the UTC Monday-start week containing their effective boundary. */
export function groupRenewalCalendar(rows: readonly EvidenceFamilyRow[]): RenewalCalendarWeek[] {
  const byWeek = new Map<string, EvidenceFamilyRow[]>();
  for (const row of rows) {
    const weekStart = utcWeekStartDate(row.boundarySec);
    const week = byWeek.get(weekStart);
    if (week === undefined) byWeek.set(weekStart, [row]);
    else week.push(row);
  }
  return [...byWeek.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, weekRows]) => ({
      weekStart,
      rows: weekRows.sort((left, right) =>
        left.boundarySec - right.boundarySec ||
        left.family.localeCompare(right.family) ||
        left.assetId.localeCompare(right.assetId) ||
        left.scope.localeCompare(right.scope)),
    }));
}

function supplyCell(row: { supplyUsd: number | null; supplyUnavailableReason: string | null }): string {
  return row.supplyUsd === null
    ? `unavailable${row.supplyUnavailableReason ? ` (${row.supplyUnavailableReason})` : ""}`
    : Math.round(row.supplyUsd).toLocaleString("en-US");
}

function renewalCalendarTable(weeks: readonly RenewalCalendarWeek[]): string[] {
  const lines = [
    "| Week (Mon) | Boundary (UTC date) | Renew by | Lead-time class | Family | Asset | Scope | Supply (USD) | Disposition |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const week of weeks) {
    for (const row of week.rows) {
      const leadClass = RENEWAL_LEAD_TIME_CLASS_BY_FAMILY[row.family];
      const renewBy = leadClass === undefined
        ? "—"
        : isoSec(row.boundarySec - RENEWAL_LEAD_TIME_DAYS * DAY_SEC).slice(0, 10);
      lines.push(`| ${week.weekStart} | ${isoSec(row.boundarySec).slice(0, 10)} | ${renewBy} | ${leadClass ?? "—"} | ${row.family} | ${row.assetId} | ${cell(row.scope)} | ${supplyCell(row)} | ${row.disposition} |`);
    }
  }
  return lines;
}

export interface RenderCurationExpiryReportOptions {
  /** Add the UTC-week renewal calendar (`--by-week`); the default report is unchanged. */
  byWeek?: boolean;
}

function familyTable(rows: readonly EvidenceFamilyRow[]): string[] {
  const lines = [
    "| Family | Asset | Scope | Supply (USD) | Original clocks | Controlling budget | Effective boundary | Disposition | Reason |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(`| ${row.family} | ${row.assetId} | ${cell(row.scope)} | ${supplyCell(row)} | ${cell(row.clocks)} | ${cell(row.controllingBudget)} | ${isoSec(row.boundarySec)} (${row.boundarySemantics}) | ${row.disposition} | ${cell(row.reason ?? "")} |`);
  }
  return lines;
}

export function renderCurationExpiryReport(
  report: CurationExpiryReport,
  options: RenderCurationExpiryReportOptions = {},
): string {
  const supply = summarizeDistinctAssetSupply([...report.reserveRows, ...report.upcoming]);
  const windowLabel = report.horizon === null
    ? `lookahead ${report.lookaheadDays}d`
    : `horizon ${report.horizon.date}, exclusive UTC start`;
  const lines = [
    `# Safety Score evidence pre-expiry queue (${windowLabel})`,
    "",
    `Report status: **${report.status}**${report.status === "partial" ? ` (${report.diagnostics.length} census diagnostic(s); this is not a complete assessment)` : ""}.`,
    `Capture clock ${isoSec(report.capture.clockSec)} (${report.capture.clockSec}); base input generation ${report.capture.baseInputGenerationId ?? "unavailable"}; source generation ${report.capture.sourceGeneration ?? "unavailable"}; extracted ${isoSec(report.extractedAtSec)}.`,
    "Family boundaries derive from original authored clocks plus canonical policy budgets; the frozen input is not re-aged. Dispositions are admission states, not grade forecasts; `unknown` means the production join was not available or not reproduced.",
    `Queue supply (distinct assets across reserve and upcoming family rows): ${supply.known} known, ${supply.unavailable} unavailable; known-supply subtotal USD ${supply.knownSubtotalUsd.toLocaleString("en-US")} (not a full-cohort total).`,
    "",
  ];
  if (report.diagnostics.length > 0) {
    lines.push("## Census diagnostics", "");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.family} ${diagnostic.assetId ?? "-"} ${diagnostic.scope}: ${diagnostic.message}`);
    }
    lines.push("");
  }
  lines.push(renderCurationExpiryQueue(report.reserveRows, report.lookaheadDays, report.horizon).replace(/^# /, "## "));
  lines.push(`## Upcoming active evidence deadlines (${report.upcoming.length})`, "");
  const noUpcoming = report.horizon === null
    ? "No enrolled family record reaches its effective boundary within the lookahead."
    : `No enrolled family record reaches its effective boundary before ${report.horizon.date}T00:00:00Z.`;
  lines.push(...(report.upcoming.length === 0 ? [noUpcoming] : familyTable(report.upcoming)), "");
  if (options.byWeek === true) {
    const weeks = groupRenewalCalendar(report.upcoming);
    lines.push("## Renewal calendar by UTC week (Monday start)", "");
    lines.push(`Weeks start on the UTC Monday containing each effective boundary; \`Renew by\` counts back the documented ${RENEWAL_LEAD_TIME_DAYS}-day renewal lead time. \`—\` marks a family whose lead time is not documented, and curated reserve compositions stay in the reserve queue above because their exact boundary is owned by the production admission resolver.`, "");
    lines.push(...(weeks.length === 0 ? ["No upcoming rows to group."] : renewalCalendarTable(weeks)), "");
  }
  lines.push("## Family census", "");
  lines.push("| Family | Records | Upcoming | Lapsed | Later | Inactive | Admitted | Rejected | Unknown |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of report.census) {
    lines.push(`| ${row.family} | ${row.records} | ${row.upcoming} | ${row.lapsed} | ${row.later} | ${row.inactive} | ${row.admitted} | ${row.rejected} | ${row.unknown} |`);
  }
  for (const row of report.producerRefreshed) lines.push(`- ${row.family}: ${row.records} producer-refreshed captured record(s) not enrolled — ${row.note}.`);
  lines.push("", "## Inactive / history census (never renewals)", "");
  for (const row of report.inactiveHistory) {
    const windowNoun = report.horizon === null ? "lookahead" : "horizon";
    lines.push(`- ${row.registry} [${row.disposition}]: ${row.records ?? "absent"} record(s), ${row.datedRecords} dated, ${row.datesPassed} past, ${row.datesWithinLookahead} within ${windowNoun} — ${row.note}.`);
  }
  lines.push("", `## Already lapsed at capture (${report.lapsed.length})`, "");
  lines.push(...(report.lapsed.length === 0 ? ["None."] : familyTable(report.lapsed)), "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    conflicts: [["days", "horizon"]],
    options: {
      replay: { type: "string" },
      days: { type: "string" },
      horizon: { type: "string" },
      "by-week": { type: "boolean" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.replay === "string", "--replay is required");
  const horizon = values.horizon === undefined ? null : parseCurationExpiryHorizon(String(values.horizon));
  assertCliUsage(
    values.horizon === undefined || horizon !== null,
    "--horizon must be a UTC calendar date in YYYY-MM-DD form",
  );
  const lookaheadDays =
    values.days === undefined ? 10 : parseCliInteger(String(values.days), { name: "--days", min: 1 });
  const replay = ReplaySchema.parse(JSON.parse(readFileSync(String(values.replay), "utf8")));
  const clockSec = replay.pipeline.fixedInput.clockSec;
  assertCliUsage(
    horizon === null || horizon.startSec > clockSec,
    `--horizon ${horizon?.date ?? ""} is not after the capture clock ${isoSec(clockSec)}`,
  );
  const report = buildCurationExpiryReport(
    replay,
    lookaheadDays,
    defaultCurationExpirySources(),
    Math.floor(Date.now() / 1_000),
    horizon,
  );
  const markdown = renderCurationExpiryReport(report, { byWeek: values["by-week"] === true });
  // A partial report is still written (and uploaded) before the nonzero exit,
  // so workflow failure accounting stays honest without discarding the census.
  if (typeof values.output === "string") {
    writeFileSync(values.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  const windowLabel = horizon === null ? `within ${lookaheadDays}d` : `before ${horizon.date}`;
  console.error(`curation-expiry-queue: ${report.reserveRows.length} admitted composition(s) and ${report.upcoming.length} family record(s) reaching their boundary ${windowLabel}; ${report.lapsed.length} already lapsed; status ${report.status}`);
  if (report.status === "partial") {
    for (const diagnostic of report.diagnostics) {
      console.error(`curation-expiry-queue: census diagnostic ${diagnostic.family} ${diagnostic.assetId ?? "-"} ${diagnostic.scope}: ${diagnostic.message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("list-curation-expiry-queue.ts")) {
  void runCliEntrypoint(main, { label: "curation-expiry-queue", usage: USAGE });
}
