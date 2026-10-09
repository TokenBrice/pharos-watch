import { z } from "zod";
import {
  DepegPrimaryTrustSchema,
  NominalPriceReferenceSchema,
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
} from "./core";

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
  priceSource: z.string().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  /**
   * Original per-asset price observation clock; null means unknown. Absent on
   * legacy captures also means unknown, never the analytics/cache/NAV clock.
   */
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
