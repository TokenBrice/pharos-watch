import { z } from "zod";
import { FreshnessAssessmentSchema, FreshnessStatusSchema } from "@pharos/contracts/api-meta";
import { PsiConditionBandSchema } from "./stability";

const nullableUsd = z.number().finite().nonnegative().nullable();
export const HomepageCohortSchema = z.object({
  ts: z.number().finite(),
  usdt: nullableUsd,
  usdc: nullableUsd,
  sky: nullableUsd,
  others: nullableUsd,
  nonUsd: nullableUsd,
  total: nullableUsd,
});

/** Every verdict names its served generation, assessment and effective budgets. */
const HomepageLaneAssessmentSchema = FreshnessAssessmentSchema.extend({
  source: z.string(),
  reason: z.string().nullable(),
  warning: z.string().nullable(),
});
export const HomepageLaneMetaSchema = z.union([
  HomepageLaneAssessmentSchema.extend({
    updatedAt: z.number().finite().nonnegative(),
    ageSeconds: z.number().finite().nonnegative(),
    status: FreshnessStatusSchema,
  }),
  HomepageLaneAssessmentSchema.extend({
    updatedAt: z.null(),
    ageSeconds: z.null(),
    status: z.enum(["stale", "unknown"]),
    reason: z.string(),
  }),
]).refine((meta) => meta.status === "fresh" || !!meta.reason, "Non-fresh lanes require a reason");

export const HomepageHistorySchema = z.object({
  rows: z.array(HomepageCohortSchema),
  sources: z.object({
    total: HomepageLaneMetaSchema,
    usdt: HomepageLaneMetaSchema,
    usdc: HomepageLaneMetaSchema,
    usds: HomepageLaneMetaSchema,
    dai: HomepageLaneMetaSchema,
  }),
});

export const HomepageHeroSnapshotSchema = z.object({
  asOfISO: z.string().nullable(),
  totalUsd: nullableUsd,
  nonUsdUsd: nullableUsd,
  nonUsdShare: z.number().finite().nonnegative().nullable(),
  supplyUnavailableCount: z.number().int().nonnegative(),
  supplyObservedCount: z.number().int().nonnegative(),
  supplyExpectedCount: z.number().int().nonnegative(),
  supplyMissingCount: z.number().int().nonnegative(),
  cohort: HomepageCohortSchema,
  history: HomepageHistorySchema.optional(),
});

export const HomepageSnapshotSchema = z.object({
  market: z.object({
    data: HomepageHeroSnapshotSchema.omit({ history: true }).nullable(),
    meta: HomepageLaneMetaSchema,
  }),
  psi: z.object({
    data: z.object({ score: z.number().finite(), band: PsiConditionBandSchema, computedAt: z.number().finite().nonnegative() }).nullable(),
    meta: HomepageLaneMetaSchema,
  }),
  incidents: z.object({
    data: z.object({ activeDepegCount: z.number().int().nonnegative() }).nullable(),
    meta: HomepageLaneMetaSchema,
  }),
}).refine(
  (snapshot) => Object.values(snapshot).every((lane) => lane.data !== null || !!lane.meta.reason),
  "Unavailable lanes require a reason",
);

export type HomepageHeroSnapshot = z.output<typeof HomepageHeroSnapshotSchema>;
export type HomepageHeroCohort = z.output<typeof HomepageCohortSchema>;
export type HomepageLaneMeta = z.output<typeof HomepageLaneMetaSchema>;
export type HomepageHistory = z.output<typeof HomepageHistorySchema>;
export type HomepageSnapshot = z.output<typeof HomepageSnapshotSchema>;
