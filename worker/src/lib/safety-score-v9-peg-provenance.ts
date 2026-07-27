import { computePegScore, type PegScoreResult } from "@shared/lib/peg-score";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  DEPEG_EVENT_CLOSE_REASON_VALUES,
  type DepegEvent,
  type PegSummaryCoin,
} from "@shared/types/market";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { z } from "zod";
import { parseJson } from "./json-parse";

const EVENT_SET_DIGEST_DOMAIN = "safety-score-v9.peg-provenance.event-set.v1";
const SUMMARY_DIGEST_DOMAIN = "safety-score-v9.peg-provenance.summary.v1";
const EXACT_SEED_DIGEST_DOMAIN =
  "safety-score-v9.peg-provenance.exact-seed.v1";
const EXACT_SEED_MAX_BYTES = 1_900_000;

export const SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY =
  "report-cards:v9-peg-provenance-seed:exact";

const SAFETY_SCORE_V9_PEG_EVIDENCE_CLASSES = [
  "provenance-high",
  "provenance-medium",
  "provenance-low",
  "legacy-backfill-unprovenanced",
  "live-confirmed",
  "legacy-live-unprovenanced",
  "audit-excluded",
] as const;

export type SafetyScoreV9PegEvidenceClass =
  (typeof SAFETY_SCORE_V9_PEG_EVIDENCE_CLASSES)[number];

const VERIFIED_ONLY_CLASSES = new Set<SafetyScoreV9PegEvidenceClass>([
  "provenance-high",
  "provenance-medium",
  "provenance-low",
  "live-confirmed",
  "legacy-live-unprovenanced",
  "audit-excluded",
]);

const VERIFIED_ONLY_OMITTED_CLASSES = [
  "legacy-backfill-unprovenanced",
] as const satisfies readonly SafetyScoreV9PegEvidenceClass[];

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have surrounding whitespace");
const SafeTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const FiniteNumberSchema = z.number().finite();
const PositiveFiniteNumberSchema = FiniteNumberSchema.positive();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ConfidenceTierSchema = z.enum(["high", "medium", "low"]);
const AuditVerdictSchema = z.enum([
  "confirmed",
  "disputed",
  "false_positive",
  "no_data",
  "repaired",
]);

const PegEventProvenanceSchema = z
  .object({
    sourceKind: z.enum(["market", "authoritative", "live", "backfill"]).nullable().optional().default(null),
    replayRunId: CanonicalTextSchema.nullable().optional().default(null),
    replayVersion: CanonicalTextSchema.nullable().optional().default(null),
    sourcePriceProviders: z.array(CanonicalTextSchema).nullable().optional().default(null),
    quoteMode: CanonicalTextSchema.nullable().optional().default(null),
    pegReferenceSource: CanonicalTextSchema.nullable().optional().default(null),
    supplySource: CanonicalTextSchema.nullable().optional().default(null),
    confirmationPolicy: CanonicalTextSchema.nullable().optional().default(null),
    confirmationPointCount: z.number().int().nonnegative().nullable().optional().default(null),
    confidenceTier: ConfidenceTierSchema.nullable().optional().default(null),
    auditVerdict: AuditVerdictSchema.nullable().optional().default(null),
    pegScoreEligible: z.boolean().nullable().optional().default(null),
    updatedAt: SafeTimestampSchema.nullable().optional().default(null),
  })
  .strict()
  .superRefine((provenance, ctx) => {
    if (
      provenance.sourcePriceProviders != null &&
      new Set(provenance.sourcePriceProviders).size !== provenance.sourcePriceProviders.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourcePriceProviders"],
        message: "Source-price providers must be unique",
      });
    }
  });

const PegProvenanceEventSchema = z
  .object({
    id: PositiveSafeIntegerSchema,
    stablecoinId: CanonicalTextSchema,
    symbol: CanonicalTextSchema,
    pegType: CanonicalTextSchema,
    direction: z.enum(["above", "below"]),
    peakDeviationBps: FiniteNumberSchema,
    startedAt: SafeTimestampSchema,
    endedAt: SafeTimestampSchema.nullable(),
    startPrice: PositiveFiniteNumberSchema,
    peakPrice: PositiveFiniteNumberSchema.nullable(),
    recoveryPrice: PositiveFiniteNumberSchema.nullable(),
    pegReference: PositiveFiniteNumberSchema,
    source: z.enum(["live", "backfill"]),
    constituentEventCount: PositiveSafeIntegerSchema.optional().default(1),
    confirmationSources: CanonicalTextSchema.nullable().optional().default(null),
    pendingReason: CanonicalTextSchema.nullable().optional().default(null),
    closeReason: z
      .enum(DEPEG_EVENT_CLOSE_REASON_VALUES)
      .nullable()
      .optional()
      .default(null),
    provenance: PegEventProvenanceSchema.nullable().optional().default(null),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.endedAt != null && event.endedAt <= event.startedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "A closed event must end after it starts",
      });
    }
    // The prepared peg summary uses the signed peak and ignores direction. Historical rows
    // contain known direction/sign disagreements, so bind that metadata in the
    // event digest without rejecting or silently rewriting the scored event.
  });

const PegScoreProjectionSchema = z
  .object({
    pegScore: z.number().int().min(0).max(100).nullable(),
    pegPct: FiniteNumberSchema.min(0).max(100),
    severityScore: FiniteNumberSchema.min(0).max(100),
    spreadPenalty: FiniteNumberSchema.min(0).max(15),
    eventCount: z.number().int().nonnegative(),
    worstDeviationBps: FiniteNumberSchema.nullable(),
    activeDepeg: z.boolean(),
    lastEventAt: SafeTimestampSchema.nullable(),
    trackingSpanDays: z.number().int().nonnegative(),
  })
  .strict();

export interface SafetyScoreV9PegScoreProjection {
  pegScore: number | null;
  pegPct: number;
  severityScore: number;
  spreadPenalty: number;
  eventCount: number;
  worstDeviationBps: number | null;
  activeDepeg: boolean;
  lastEventAt: number | null;
  trackingSpanDays: number;
}

export interface SafetyScoreV9PegEvidenceClassStats {
  eventCount: number;
  worstDeviationBps: number | null;
  latestEventAtSec: number | null;
}

const PegEvidenceClassStatsSchema = z
  .object({
    eventCount: z.number().int().nonnegative(),
    worstDeviationBps: FiniteNumberSchema.nullable(),
    latestEventAtSec: SafeTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((stats, ctx) => {
    if (
      (stats.eventCount === 0) !==
      (stats.worstDeviationBps === null && stats.latestEventAtSec === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Empty class statistics must have null worst/latest values",
      });
    }
  });

const PegEvidenceClassesSchema = z
  .object({
    "provenance-high": PegEvidenceClassStatsSchema,
    "provenance-medium": PegEvidenceClassStatsSchema,
    "provenance-low": PegEvidenceClassStatsSchema,
    "legacy-backfill-unprovenanced": PegEvidenceClassStatsSchema,
    "live-confirmed": PegEvidenceClassStatsSchema,
    "legacy-live-unprovenanced": PegEvidenceClassStatsSchema,
    "audit-excluded": PegEvidenceClassStatsSchema,
  })
  .strict();

const PegScoreResultSchema: z.ZodType<PegScoreResult> = z
  .object({
    pegScore: z.number().int().min(0).max(100).nullable(),
    pegPct: FiniteNumberSchema.min(0).max(100),
    severityScore: FiniteNumberSchema.min(0).max(100),
    spreadPenalty: FiniteNumberSchema.min(0).max(15),
    eventCount: z.number().int().nonnegative(),
    scoredEventCount: z.number().int().nonnegative(),
    excludedEventCount: z.number().int().nonnegative(),
    lowConfidenceEventCount: z.number().int().nonnegative(),
    qualityAdjusted: z.boolean(),
    worstDeviationBps: FiniteNumberSchema.nullable(),
    activeDepeg: z.boolean(),
    lastEventAt: SafeTimestampSchema.nullable(),
    trackingSpanDays: z.number().int().nonnegative(),
  })
  .strict();

export const SafetyScoreV9PegProvenanceSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: CanonicalTextSchema,
    clockSec: SafeTimestampSchema,
    trackingStartSec: SafeTimestampSchema.nullable(),
    effectiveTrackingStartSec: SafeTimestampSchema.nullable(),
    eventCount: z.number().int().nonnegative(),
    eventSetSha256: Sha256Schema,
    classes: PegEvidenceClassesSchema,
    hasUnprovenancedLegacyBackfill: z.boolean(),
    legacyInclusive: z
      .object({
        disposition: z.literal("score-preserving"),
        result: PegScoreResultSchema,
      })
      .strict(),
    verifiedOnlyDiagnostic: z
      .object({
        disposition: z.literal("diagnostic-only"),
        omittedClasses: z.tuple([
          z.literal("legacy-backfill-unprovenanced"),
        ]),
        result: PegScoreResultSchema,
      })
      .strict(),
    contentSha256: Sha256Schema,
  })
  .strict()
  .superRefine((summary, ctx) => {
    const classEventCount = Object.values(summary.classes).reduce(
      (sum, stats) => sum + stats.eventCount,
      0,
    );
    if (classEventCount !== summary.eventCount) {
      ctx.addIssue({
        code: "custom",
        path: ["classes"],
        message: "Peg provenance class counts do not reconcile with the event count",
      });
    }
    const legacyBackfillCount =
      summary.classes["legacy-backfill-unprovenanced"].eventCount;
    const auditExcludedCount = summary.classes["audit-excluded"].eventCount;
    const lowConfidenceCount = summary.classes["provenance-low"].eventCount;
    if (
      summary.hasUnprovenancedLegacyBackfill !==
      (legacyBackfillCount > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["hasUnprovenancedLegacyBackfill"],
        message: "Legacy-backfill diagnostic flag does not match its class count",
      });
    }
    const resultCountExpectations = [
      {
        path: ["legacyInclusive"] as const,
        result: summary.legacyInclusive.result,
        eventCount: summary.eventCount,
        scoredEventCount: summary.eventCount - auditExcludedCount,
      },
      {
        path: ["verifiedOnlyDiagnostic"] as const,
        result: summary.verifiedOnlyDiagnostic.result,
        eventCount: summary.eventCount - legacyBackfillCount,
        scoredEventCount:
          summary.eventCount - legacyBackfillCount - auditExcludedCount,
      },
    ];
    for (const expected of resultCountExpectations) {
      if (
        expected.result.eventCount !== expected.eventCount ||
        expected.result.scoredEventCount !== expected.scoredEventCount ||
        expected.result.excludedEventCount !== auditExcludedCount ||
        expected.result.lowConfidenceEventCount !== lowConfidenceCount ||
        expected.result.qualityAdjusted !==
          (auditExcludedCount > 0 || lowConfidenceCount > 0)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...expected.path, "result"],
          message: "Peg provenance score projection does not reconcile with class counts",
        });
      }
    }
    if (
      summary.verifiedOnlyDiagnostic.result.trackingSpanDays !==
      summary.legacyInclusive.result.trackingSpanDays
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["verifiedOnlyDiagnostic", "result", "trackingSpanDays"],
        message: "Peg provenance diagnostics must use the legacy-inclusive tracking window",
      });
    }
    if (
      summary.effectiveTrackingStartSec != null &&
      summary.effectiveTrackingStartSec > summary.clockSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTrackingStartSec"],
        message: "Effective tracking start cannot follow the fixed clock",
      });
    }
    if (
      summary.trackingStartSec != null &&
      summary.effectiveTrackingStartSec !== summary.trackingStartSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTrackingStartSec"],
        message: "Explicit and effective tracking starts must match",
      });
    }
    for (const [evidenceClass, stats] of Object.entries(summary.classes)) {
      if (stats.latestEventAtSec != null && stats.latestEventAtSec > summary.clockSec) {
        ctx.addIssue({
          code: "custom",
          path: ["classes", evidenceClass, "latestEventAtSec"],
          message: "Class evidence cannot postdate the fixed clock",
        });
      }
    }
    const { contentSha256: _contentSha256, ...payload } = summary;
    if (summary.contentSha256 !== digest(SUMMARY_DIGEST_DOMAIN, payload)) {
      ctx.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message: "Peg provenance summary digest does not match its canonical payload",
      });
    }
  });

export type SafetyScoreV9PegProvenanceSummary = z.infer<
  typeof SafetyScoreV9PegProvenanceSummarySchema
>;
export type SafetyScoreV9PegProvenanceById = Record<
  string,
  SafetyScoreV9PegProvenanceSummary
>;

const SafetyScoreV9PegProvenanceByIdSchema = z.record(
  z.string().min(1),
  SafetyScoreV9PegProvenanceSummarySchema,
);

const SafetyScoreV9PegProvenanceSeedSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-peg-provenance-exact-seed"),
    sourceGeneration: z.string().min(1),
    clockSec: SafeTimestampSchema,
    safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema,
    pegProvenanceById: SafetyScoreV9PegProvenanceByIdSchema,
    contentSha256: Sha256Schema,
  })
  .strict()
  .superRefine((seed, ctx) => {
    const { contentSha256, ...payload } = seed;
    if (
      contentSha256 !== digest(EXACT_SEED_DIGEST_DOMAIN, payload)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message:
          "Exact peg-provenance seed digest does not match its canonical payload",
      });
    }
    if (
      seed.sourceGeneration !==
      seed.safetyScoreIdentity.publicationGenerationId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceGeneration"],
        message:
          "Exact peg-provenance seed generation does not match its base-input identity",
      });
    }
    for (const [assetId, summary] of Object.entries(
      seed.pegProvenanceById,
    )) {
      if (summary.assetId !== assetId) {
        ctx.addIssue({
          code: "custom",
          path: ["pegProvenanceById", assetId, "assetId"],
          message:
            "Exact peg-provenance seed key does not match its summary asset",
        });
      }
      if (summary.clockSec !== seed.clockSec) {
        ctx.addIssue({
          code: "custom",
          path: ["pegProvenanceById", assetId, "clockSec"],
          message:
            "Exact peg-provenance seed summary clock does not match the seed clock",
        });
      }
    }
  });

export type SafetyScoreV9PegProvenanceSeed = z.infer<
  typeof SafetyScoreV9PegProvenanceSeedSchema
>;

export interface SafetyScoreV9PegProvenanceSource {
  clockSec: number;
  eventsByCoin: ReadonlyMap<string, readonly DepegEvent[]>;
}

export interface BuildSafetyScoreV9PegProvenanceSummaryInput {
  assetId: string;
  events: readonly DepegEvent[];
  trackingStartSec: number | null;
  clockSec: number;
  expectedLegacyInclusive: SafetyScoreV9PegScoreProjection;
}

export interface CaptureSafetyScoreV9PegProvenanceInput {
  clockSec: number;
  pegDataById: Readonly<Record<string, PegSummaryCoin>>;
}

type CanonicalPegEvent = z.infer<typeof PegProvenanceEventSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEventOrder(left: CanonicalPegEvent, right: CanonicalPegEvent): number {
  return (
    right.startedAt - left.startedAt ||
    right.id - left.id ||
    compareText(left.stablecoinId, right.stablecoinId)
  );
}

function canonicalizeEvent(event: CanonicalPegEvent): CanonicalPegEvent {
  if (event.provenance?.sourcePriceProviders == null) return event;
  return {
    ...event,
    provenance: {
      ...event.provenance,
      sourcePriceProviders: [...event.provenance.sourcePriceProviders].sort(compareText),
    },
  };
}

function eventLabel(event: CanonicalPegEvent): string {
  return `${event.stablecoinId} event ${event.id}`;
}

function assertEventProvenance(event: CanonicalPegEvent, clockSec: number): void {
  const provenance = event.provenance;
  if (provenance == null) {
    if (event.source === "backfill" && event.confirmationSources != null) {
      throw new Error(
        `[safety-score-v9-peg-provenance] ${eventLabel(event)} mixes backfill source with live confirmation evidence`,
      );
    }
    return;
  }

  if (
    provenance.confidenceTier == null ||
    provenance.auditVerdict == null ||
    provenance.pegScoreEligible == null ||
    provenance.updatedAt == null
  ) {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has partial provenance`,
    );
  }
  if (provenance.updatedAt > clockSec) {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has future-dated provenance`,
    );
  }

  const excludedByAudit =
    provenance.auditVerdict === "false_positive" ||
    provenance.auditVerdict === "disputed";
  if (provenance.pegScoreEligible === excludedByAudit) {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has contradictory peg-score eligibility`,
    );
  }

  const hasReplayRun = provenance.replayRunId != null;
  const hasReplayVersion = provenance.replayVersion != null;
  if (hasReplayRun !== hasReplayVersion) {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has incomplete replay identity`,
    );
  }

  const hasReplayIdentity = hasReplayRun && hasReplayVersion;
  const hasReplayDetails =
    provenance.sourcePriceProviders != null ||
    provenance.quoteMode != null ||
    provenance.pegReferenceSource != null ||
    provenance.supplySource != null ||
    provenance.confirmationPolicy != null ||
    provenance.confirmationPointCount != null;

  if (hasReplayIdentity) {
    if (
      event.source !== "backfill" ||
      (provenance.sourceKind !== "market" && provenance.sourceKind !== "authoritative")
    ) {
      throw new Error(
        `[safety-score-v9-peg-provenance] ${eventLabel(event)} has replay provenance for a non-replay source`,
      );
    }
    if (
      provenance.sourcePriceProviders == null ||
      provenance.pegReferenceSource == null ||
      provenance.supplySource == null ||
      provenance.confirmationPolicy == null ||
      provenance.confirmationPointCount == null
    ) {
      throw new Error(
        `[safety-score-v9-peg-provenance] ${eventLabel(event)} has incomplete replay provenance`,
      );
    }
    return;
  }

  if (hasReplayDetails || provenance.sourceKind === "market" || provenance.sourceKind === "authoritative") {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has replay details without replay identity`,
    );
  }
  if (provenance.sourceKind != null && provenance.sourceKind !== event.source) {
    throw new Error(
      `[safety-score-v9-peg-provenance] ${eventLabel(event)} has provenance from a different event source`,
    );
  }
}

function classifyEvent(event: CanonicalPegEvent): SafetyScoreV9PegEvidenceClass {
  const provenance = event.provenance;
  if (
    provenance?.auditVerdict === "false_positive" ||
    provenance?.auditVerdict === "disputed"
  ) {
    return "audit-excluded";
  }
  if (provenance?.confidenceTier != null) {
    return `provenance-${provenance.confidenceTier}`;
  }
  if (event.source === "backfill") return "legacy-backfill-unprovenanced";
  return event.confirmationSources != null
    ? "live-confirmed"
    : "legacy-live-unprovenanced";
}

function emptyClassStats(): Record<
  SafetyScoreV9PegEvidenceClass,
  SafetyScoreV9PegEvidenceClassStats
> {
  return Object.fromEntries(
    SAFETY_SCORE_V9_PEG_EVIDENCE_CLASSES.map((evidenceClass) => [
      evidenceClass,
      { eventCount: 0, worstDeviationBps: null, latestEventAtSec: null },
    ]),
  ) as Record<SafetyScoreV9PegEvidenceClass, SafetyScoreV9PegEvidenceClassStats>;
}

function updateClassStats(
  stats: SafetyScoreV9PegEvidenceClassStats,
  event: CanonicalPegEvent,
): void {
  stats.eventCount += 1;
  const currentWorst = stats.worstDeviationBps;
  if (
    currentWorst == null ||
    Math.abs(event.peakDeviationBps) > Math.abs(currentWorst) ||
    (
      Math.abs(event.peakDeviationBps) === Math.abs(currentWorst) &&
      event.peakDeviationBps < currentWorst
    )
  ) {
    stats.worstDeviationBps = event.peakDeviationBps;
  }
  stats.latestEventAtSec =
    stats.latestEventAtSec == null
      ? event.startedAt
      : Math.max(stats.latestEventAtSec, event.startedAt);
}

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

function parseEvent(value: DepegEvent, index: number): CanonicalPegEvent {
  const parsed = PegProvenanceEventSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(
      `[safety-score-v9-peg-provenance] Invalid event at index ${index}${path}: ${issue?.message ?? "invalid input"}`,
    );
  }
  return canonicalizeEvent(parsed.data);
}

function resolveEffectiveTrackingStart(
  events: readonly CanonicalPegEvent[],
  trackingStartSec: number | null,
): number | null {
  if (trackingStartSec != null) return trackingStartSec;
  if (events.length === 0) return null;
  return events.reduce(
    (earliest, event) => Math.min(earliest, event.startedAt),
    Number.POSITIVE_INFINITY,
  );
}

function scoreCoverageEvents(
  events: readonly CanonicalPegEvent[],
  trackingStartSec: number | null,
): CanonicalPegEvent[] {
  if (trackingStartSec == null) return [];
  return events.filter((event) => (event.endedAt ?? Number.POSITIVE_INFINITY) > trackingStartSec);
}

export function projectSafetyScoreV9PegScoreResult(
  result: PegScoreResult,
): SafetyScoreV9PegScoreProjection {
  return {
    pegScore: result.pegScore,
    pegPct: result.pegPct,
    severityScore: result.severityScore,
    spreadPenalty: result.spreadPenalty,
    eventCount: result.eventCount,
    worstDeviationBps: result.worstDeviationBps,
    activeDepeg: result.activeDepeg,
    lastEventAt: result.lastEventAt,
    trackingSpanDays: result.trackingSpanDays,
  };
}

export function projectSafetyScoreV9PegSummary(
  summary: PegSummaryCoin,
): SafetyScoreV9PegScoreProjection {
  return {
    pegScore: summary.pegScore,
    pegPct: summary.pegPct,
    severityScore: summary.severityScore,
    spreadPenalty: summary.spreadPenalty,
    eventCount: summary.eventCount,
    worstDeviationBps: summary.worstDeviationBps,
    activeDepeg: summary.activeDepeg,
    lastEventAt: summary.lastEventAt,
    trackingSpanDays: summary.trackingSpanDays,
  };
}

function assertLegacyInclusiveMatch(
  assetId: string,
  expectedValue: SafetyScoreV9PegScoreProjection,
  actualResult: PegScoreResult,
): void {
  const expected = PegScoreProjectionSchema.parse(expectedValue);
  const actual = projectSafetyScoreV9PegScoreResult(actualResult);
  const mismatches = (Object.keys(actual) as Array<keyof SafetyScoreV9PegScoreProjection>)
    .filter((key) => !Object.is(expected[key], actual[key]));
  if (mismatches.length > 0) {
    throw new Error(
      `[safety-score-v9-peg-provenance] Legacy-inclusive peg summary mismatch for ${assetId}: ${mismatches.join(", ")}`,
    );
  }
}

/**
 * Classifies the exact PegScore coverage set without changing its score.
 * The verified-only projection omits provenance-less historical backfill but
 * retains direct live measurements. It is an upper-bound diagnostic, never a
 * replacement for the legacy-inclusive result.
 */
export function buildSafetyScoreV9PegProvenanceSummary(
  input: BuildSafetyScoreV9PegProvenanceSummaryInput,
): SafetyScoreV9PegProvenanceSummary {
  const assetId = CanonicalTextSchema.parse(input.assetId);
  const clockSec = SafeTimestampSchema.parse(input.clockSec);
  const trackingStartSec =
    input.trackingStartSec == null
      ? null
      : SafeTimestampSchema.parse(input.trackingStartSec);
  if (trackingStartSec != null && trackingStartSec > clockSec) {
    throw new Error(
      `[safety-score-v9-peg-provenance] Tracking start for ${assetId} is later than the scoring clock`,
    );
  }

  const seenEventIds = new Set<number>();
  const parsedEvents = input.events.map((event, index) => {
    const parsed = parseEvent(event, index);
    if (parsed.stablecoinId !== assetId) {
      throw new Error(
        `[safety-score-v9-peg-provenance] Mixed asset event ${parsed.id}: expected ${assetId}, received ${parsed.stablecoinId}`,
      );
    }
    if (seenEventIds.has(parsed.id)) {
      throw new Error(
        `[safety-score-v9-peg-provenance] Duplicate event ID ${parsed.id} for ${assetId}`,
      );
    }
    if (parsed.startedAt > clockSec || (parsed.endedAt != null && parsed.endedAt > clockSec)) {
      throw new Error(
        `[safety-score-v9-peg-provenance] ${eventLabel(parsed)} is later than the scoring clock`,
      );
    }
    assertEventProvenance(parsed, clockSec);
    seenEventIds.add(parsed.id);
    return parsed;
  });

  const effectiveTrackingStartSec = resolveEffectiveTrackingStart(
    parsedEvents,
    trackingStartSec,
  );
  const coverageEvents = scoreCoverageEvents(parsedEvents, effectiveTrackingStartSec)
    .sort(canonicalEventOrder);
  const classifiedEvents = coverageEvents.map((event) => ({
    event,
    evidenceClass: classifyEvent(event),
  }));

  const classes = emptyClassStats();
  for (const classified of classifiedEvents) {
    updateClassStats(classes[classified.evidenceClass], classified.event);
  }

  const legacyInclusiveResult = computePegScore(
    coverageEvents,
    effectiveTrackingStartSec,
    clockSec,
  );
  assertLegacyInclusiveMatch(
    assetId,
    input.expectedLegacyInclusive,
    legacyInclusiveResult,
  );

  const verifiedOnlyEvents = classifiedEvents
    .filter(({ evidenceClass }) => VERIFIED_ONLY_CLASSES.has(evidenceClass))
    .map(({ event }) => event);
  const verifiedOnlyResult = computePegScore(
    verifiedOnlyEvents,
    effectiveTrackingStartSec,
    clockSec,
  );

  const eventSetSha256 = digest(EVENT_SET_DIGEST_DOMAIN, {
    assetId,
    clockSec,
    trackingStartSec,
    effectiveTrackingStartSec,
    events: classifiedEvents.map(({ event, evidenceClass }) => ({
      evidenceClass,
      ...event,
    })),
  });
  const summaryPayload = {
    schemaVersion: 1 as const,
    assetId,
    clockSec,
    trackingStartSec,
    effectiveTrackingStartSec,
    eventCount: coverageEvents.length,
    eventSetSha256,
    classes,
    hasUnprovenancedLegacyBackfill:
      classes["legacy-backfill-unprovenanced"].eventCount > 0,
    legacyInclusive: {
      disposition: "score-preserving" as const,
      result: legacyInclusiveResult,
    },
    verifiedOnlyDiagnostic: {
      disposition: "diagnostic-only" as const,
      omittedClasses: [...VERIFIED_ONLY_OMITTED_CLASSES],
      result: verifiedOnlyResult,
    },
  };

  return SafetyScoreV9PegProvenanceSummarySchema.parse({
    ...summaryPayload,
    contentSha256: digest(SUMMARY_DIGEST_DOMAIN, summaryPayload),
  });
}

/**
 * Converts the in-memory scoring event set into compact private V9 evidence.
 * Raw events are consumed here and are never part of the returned record.
 */
export function captureSafetyScoreV9PegProvenanceById(
  input: CaptureSafetyScoreV9PegProvenanceInput,
  source: SafetyScoreV9PegProvenanceSource,
): SafetyScoreV9PegProvenanceById {
  const clockSec = SafeTimestampSchema.parse(input.clockSec);
  if (SafeTimestampSchema.parse(source.clockSec) !== clockSec) {
    throw new Error(
      "[safety-score-v9-peg-provenance] Peg event source clock does not match the exact fixed input",
    );
  }

  const provenanceById: SafetyScoreV9PegProvenanceById = {};
  for (const [assetId, pegSummary] of Object.entries(input.pegDataById).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    if (pegSummary.id !== assetId) {
      throw new Error(
        `[safety-score-v9-peg-provenance] Peg summary key ${assetId} does not match row ${pegSummary.id}`,
      );
    }
    provenanceById[assetId] = buildSafetyScoreV9PegProvenanceSummary({
      assetId,
      events: source.eventsByCoin.get(assetId) ?? [],
      trackingStartSec: pegSummary.historyCoverage?.startedAt ?? null,
      clockSec,
      expectedLegacyInclusive: projectSafetyScoreV9PegSummary(pegSummary),
    });
  }
  return provenanceById;
}

export function buildSafetyScoreV9PegProvenanceSeedCacheEntry(input: {
  sourceGeneration: string;
  clockSec: number;
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity;
  pegProvenanceById: SafetyScoreV9PegProvenanceById;
}): {
  key: string;
  value: string;
  storedBytes: number;
} {
  const safetyScoreIdentity =
    SafetyScoreV8PublicationIdentitySchema.parse(
      input.safetyScoreIdentity,
    );
  const pegProvenanceById =
    SafetyScoreV9PegProvenanceByIdSchema.parse(
      Object.fromEntries(
        Object.entries(input.pegProvenanceById).sort(
          ([left], [right]) => compareText(left, right),
        ),
      ),
    );
  const payload = {
    schemaVersion: 1 as const,
    kind: "safety-score-v9-peg-provenance-exact-seed" as const,
    sourceGeneration: input.sourceGeneration,
    clockSec: input.clockSec,
    safetyScoreIdentity,
    pegProvenanceById,
  };
  const seed = SafetyScoreV9PegProvenanceSeedSchema.parse({
    ...payload,
    contentSha256: digest(EXACT_SEED_DIGEST_DOMAIN, payload),
  });
  const value = stableJsonStringifyV1(seed);
  const storedBytes = new TextEncoder().encode(value).byteLength;
  if (storedBytes > EXACT_SEED_MAX_BYTES) {
    throw new Error(
      `Exact V9 peg-provenance seed is ${storedBytes} bytes; maximum is ${EXACT_SEED_MAX_BYTES}`,
    );
  }
  return {
    key: SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
    value,
    storedBytes,
  };
}

export function parseSafetyScoreV9PegProvenanceSeed(
  value: unknown,
): SafetyScoreV9PegProvenanceSeed {
  const parsed =
    typeof value === "string" ? parseJson(value) : null;
  if (parsed && !parsed.ok) {
    throw new Error(
      `Malformed exact V9 peg-provenance seed: ${parsed.message}`,
    );
  }
  return SafetyScoreV9PegProvenanceSeedSchema.parse(
    parsed?.ok ? parsed.value : value,
  );
}
