import { type DepegAuditVerdict, DepegAuditVerdictSchema } from "./depeg-audit";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";
import { z } from "zod";
import { DepegPrimaryTrustSchema, NominalPriceReferenceSchema, PriceConfidenceSchema, PriceObservedAtModeSchema } from "./price";

export const DepegTimestampSchema = z.number().int().nonnegative();

export const DEPEG_EVENT_CLOSE_REASON_VALUES = [
  "recovered-primary",
  "recovered-dex",
  "recovered-native",
  "coverage-lost-supply",
  "superseded-direction",
  "orphan-tracking-removed",
] as const;

/** Trusted off-peg/at-par intervals; the remaining event span is unknown. */
export const DepegPriceCoverageSchema = z.object({
  intervals: z.array(z.tuple([DepegTimestampSchema, DepegTimestampSchema])),
  atParIntervals: z.array(z.tuple([DepegTimestampSchema, DepegTimestampSchema])).optional(),
  lastObservationKind: z.enum(["trusted-off-peg", "trusted-at-par", "blind"]).optional(),
  lastTrustedObservationAt: DepegTimestampSchema.nullable(),
  gapStartedAt: DepegTimestampSchema.nullable(),
}).strict().superRefine((coverage, ctx) => {
  for (const intervals of [coverage.intervals, coverage.atParIntervals ?? []]) {
    let previousEnd = -1;
    for (const [start, end] of intervals) {
      if (end < start || start < previousEnd || coverage.lastTrustedObservationAt == null || end > coverage.lastTrustedObservationAt) {
        ctx.addIssue({ code: "custom", message: "Trusted price intervals must be ordered and bounded by the last observation" });
      }
      previousEnd = end;
    }
  }
});
export type DepegPriceCoverage = z.infer<typeof DepegPriceCoverageSchema>;

/**
 * Chronology invariant shared by the public depeg surfaces and the V9
 * peg-provenance parser: a closed event must end after it starts. Negative
 * durations are impossible values, not data.
 */
export function refineDepegEventChronology(
  event: { startedAt: number; endedAt: number | null },
  ctx: z.RefinementCtx,
): void {
  if (event.endedAt != null && event.endedAt <= event.startedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "A closed event must end after it starts",
    });
  }
}

export const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  pegReference: z
    .object({
      valueUsd: z.number().positive(),
      /** Unscaled commodity reference; never the per-token peg value. */
      usdPerTroyOunce: z.number().finite().positive().optional(),
      source: z.enum(["median", "fx", "fallback"]),
      contributorCount: z.number().int().nonnegative(),
      asOf: z.number().int().positive(),
    })
    .nullable()
    .optional(),
  /**
   * True when the coin's peg reference is not authoritative (thin non-USD
   * peer group with no live FX fallback) — deviation is withheld rather than
   * shown as a self-referential ~0. Mirrors the detection engine's gate.
   */
  pegReferenceUnavailable: z.boolean().optional(),
  /**
   * True when no usable current price observation exists for the coin at all
   * (no price row, or a price the intake pipeline rejected). Deviation is then
   * unobserved rather than withheld: consumers must never read the null
   * deviation as "at peg".
   */
  currentPriceUnavailable: z.boolean().optional(),
  /**
   * True when current circulating supply is unavailable, so the live-event supply floor
   * cannot be assessed. Observed current deviation is independent of that floor;
   * `depegEventCoverageLimited` stays false for unknown supply.
   */
  currentSupplyUnavailable: z.boolean().optional(),
  depegEventCoverageLimited: z.boolean().optional(),
  pegScore: z.number().nullable(),
  /** Live quote used for current deviation and provenance; absent on legacy rows. */
  price: z.number().finite().positive().nullable().optional(),
  priceSource: z.string().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  nominalPriceReference: NominalPriceReferenceSchema.optional(),
  priceSyncedAt: z.number().nullable().optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  primaryTrust: DepegPrimaryTrustSchema.optional(),
  pegPct: z.number().nullable(),
  severityScore: z.number(),
  spreadPenalty: z.number(),
  eventCount: z.number(),
  worstDeviationBps: z.number().nullable(),
  activeDepeg: z.boolean(),
  lastEventAt: z.number().nullable(),
  trackingSpanDays: z.number(),
  /** Earliest observed history, without the PegScore age/audit/4-year clamp. */
  observationStartedAt: z.number().int().nonnegative().nullable().optional(),
  /** Blind time within scored events, excluded from both off-peg time and the known-time denominator. */
  unknownCoverageSeconds: z.number().finite().nonnegative().optional(),
  historyCoverage: z
    .object({
      startedAt: z.number().int().nonnegative(),
      source: z.enum(["audited-replay", "asset-age", "first-observation", "first-event"]),
      status: z.enum(["verified", "assumed"]),
    })
    .nullable()
    .optional(),
  recent90d: z
    .object({
      windowDays: z.literal(90),
      observedDays: z.number().nonnegative(),
      coverageLimited: z.boolean(),
      pegPct: z.number().min(0).max(100).nullable(),
      incidentCount: z.number().int().nonnegative(),
      thresholdCrossingCount: z.number().int().nonnegative(),
      worstDeviationBps: z.number().nullable(),
    })
    .nullable()
    .optional(),
  methodologyVersion: z.string(),
  dexPriceCheck: z
    .object({
      dexPrice: z.number(),
      dexDeviationBps: z.number(),
      agrees: z.boolean(),
      sourcePools: z.number(),
      sourceTvl: z.number(),
    })
    .nullable()
    .optional(),
});
export type PegSummaryCoin = z.infer<typeof PegSummaryCoinSchema>;

export type DepegDirection = "above" | "below";
export const DepegDirectionSchema = z.enum(["above", "below"]);

export interface DepegEventSearchEntry {
  slug: string;
  stablecoinId: DepegEvent["stablecoinId"];
  symbol: DepegEvent["symbol"];
  pegType: DepegEvent["pegType"];
  direction: DepegDirection;
  peakDeviationBps: DepegEvent["peakDeviationBps"];
  startedAt: DepegEvent["startedAt"];
  /** Reviewed audit verdict; absent when the ledger records none. */
  auditVerdict?: DepegAuditVerdict;
}

export const DepegEventCloseReasonSchema = z.enum(DEPEG_EVENT_CLOSE_REASON_VALUES);
export type DepegEventCloseReason = z.infer<typeof DepegEventCloseReasonSchema>;

const DepegEventObjectSchema = z.object({
  id: z.number(),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  startedAt: DepegTimestampSchema,
  endedAt: DepegTimestampSchema.nullable(),
  startPrice: z.number(),
  peakPrice: z.number().nullable(),
  recoveryPrice: z.number().nullable(),
  pegReference: z.number(),
  source: z.enum(["live", "backfill"]),
  /** Raw threshold-crossing rows grouped into this public incident. */
  constituentEventCount: z.number().int().positive().optional(),
  confirmationSources: z.string().nullable().optional().default(null),
  pendingReason: z.string().nullable().optional().default(null),
  closeReason: DepegEventCloseReasonSchema.nullable().optional().default(null),
  /** Present when the event's coin is absent from the tracked catalog; the row keeps its history as a retired coin. */
  retired: z.boolean().optional(),
  priceCoverage: DepegPriceCoverageSchema.nullable().optional(),
  provenance: z
    .object({
      sourceKind: z.string().nullable().optional(),
      replayRunId: z.string().nullable().optional(),
      replayVersion: z.string().nullable().optional(),
      sourcePriceProviders: z.array(z.string()).nullable().optional(),
      quoteMode: z.string().nullable().optional(),
      pegReferenceSource: z.string().nullable().optional(),
      supplySource: z.string().nullable().optional(),
      confirmationPolicy: z.string().nullable().optional(),
      confirmationPointCount: z.number().nullable().optional(),
      confidenceTier: z.string().nullable().optional(),
      auditVerdict: DepegAuditVerdictSchema.nullable().optional(),
      pegScoreEligible: z.boolean().nullable().optional(),
      updatedAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional()
    .default(null),
});
export const DepegEventSchema = DepegEventObjectSchema.superRefine(refineDepegEventChronology);
export type DepegEvent = z.infer<typeof DepegEventSchema>;

/** Build-time depeg archive written to data/depeg-events/*.json. */
export const DepegEventStoredSnapshotSchema = z.array(
  DepegEventObjectSchema
    .extend({
      slug: z.string().min(1),
    })
    .superRefine(refineDepegEventChronology),
);
export type DepegEventEntry = z.infer<typeof DepegEventStoredSnapshotSchema>[number];

export const DepegPendingIncidentSchema = z
  .object({
    stablecoinId: z.string(),
    symbol: z.string(),
    direction: DepegDirectionSchema,
    firstSeenAt: DepegTimestampSchema,
    lastSeenAt: DepegTimestampSchema,
    firstSeenBps: z.number(),
    lastSeenBps: z.number(),
    peakSeenBps: z.number(),
    reason: z.string(),
    ageSec: z.number(),
    expiresAt: DepegTimestampSchema,
    availableConfirmationCategories: z.array(z.string()),
    missingConfirmationCategories: z.array(z.string()),
  })
  .superRefine((incident, ctx) => {
    if (incident.lastSeenAt < incident.firstSeenAt) {
      ctx.addIssue({
        code: "custom",
        path: ["lastSeenAt"],
        message: "A pending incident cannot be last seen before it is first seen",
      });
    }
    // `expiresAt` is the effective expiry: `firstSeenAt` plus the base, extended
    // or severe limit that applies to the row's current evidence.
    if (incident.expiresAt <= incident.firstSeenAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A pending incident's expiry must fall after it is first seen",
      });
    }
  });

export type DepegPendingIncident = z.infer<typeof DepegPendingIncidentSchema>;

export const DepegEventsResponseSchema = z.object({
  events: z.array(DepegEventSchema),
  total: z.number(),
  totalExact: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
  pending: z.array(DepegPendingIncidentSchema).optional(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type DepegEventsResponse = z.infer<typeof DepegEventsResponseSchema>;

export const PegSummaryStatsSchema = z.object({
  activeDepegCount: z.number(),
  medianDeviationBps: z.number().nullable(),
  worstCurrent: z.object({ id: z.string(), symbol: z.string(), bps: z.number() }).nullable(),
  coinsAtPeg: z.number(),
  totalTracked: z.number(),
  depegEventsToday: z.number(),
  depegEventsYesterday: z.number(),
  fallbackPegRates: z.array(z.string()).optional(),
  fxPegRates: z.array(z.string()).optional(),
});
export type PegSummaryStats = z.infer<typeof PegSummaryStatsSchema>;

export const PegSummaryResponseSchema = z.object({
  coins: z.array(PegSummaryCoinSchema),
  summary: PegSummaryStatsSchema.nullable(),
  methodology: MethodologyEnvelopeSchema,
  /** Present when the 200 body carries retained analytics or missing cross-checks; names the reason. */
  degradedReason: z.string().min(1).optional(),
});
export type PegSummaryResponse = z.infer<typeof PegSummaryResponseSchema>;
