import { createHash } from "node:crypto";

import { PYS_MAX_SOURCE_RISK_PENALTY } from "@shared/lib/yield-scoring";
import { z } from "zod";

export const YIELD_OUTCOME_DATASET_SCHEMA_VERSION = 1 as const;

export const YIELD_OUTCOME_COHORTS = [
  "canonical-holder",
  "direct-evidence",
  "external-opportunity",
  "modeled-proxy",
] as const;

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/, "must be a privacy-safe identifier");
const StablecoinIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a canonical stablecoin id");
const EpochSecondsSchema = z.number().int().nonnegative().safe();
const PublishedPysSchema = z.number().finite().min(0).max(100).nullable();
const CohortSchema = z.enum(YIELD_OUTCOME_COHORTS);

const YieldOutcomeGenerationSchema = z
  .object({
    generationId: SafeIdentifierSchema,
    publishedAt: EpochSecondsSchema,
    methodologyVersion: SafeIdentifierSchema,
  })
  .strict();

const YieldOutcomeRankingObservationSchema = z
  .object({
    generationId: SafeIdentifierSchema,
    stablecoinId: StablecoinIdSchema,
    sourceKey: SafeIdentifierSchema,
    apy30d: z.number().finite(),
    publishedPys: PublishedPysSchema,
    safetyScore: z.number().finite().min(0).max(100).nullable(),
    apyVarianceScore: z.number().finite().min(0).max(1),
    benchmarkRate: z.number().finite().nullable(),
    sourceRiskPenalty: z.number().finite().min(1).max(PYS_MAX_SOURCE_RISK_PENALTY).nullable(),
    scalingFactor: z.number().finite().positive(),
    cohorts: z
      .array(CohortSchema)
      .max(YIELD_OUTCOME_COHORTS.length)
      .refine((values) => new Set(values).size === values.length, "cohorts must be unique")
      .default([]),
  })
  .strict();

const YieldOutcomeHistoryObservationSchema = z
  .object({
    generationId: SafeIdentifierSchema,
    stablecoinId: StablecoinIdSchema,
    sourceKey: SafeIdentifierSchema,
    observedAt: EpochSecondsSchema,
    apy30d: z.number().finite(),
    publishedPys: PublishedPysSchema,
  })
  .strict();

export const YieldOutcomeDatasetSchema = z
  .object({
    schemaVersion: z.literal(YIELD_OUTCOME_DATASET_SCHEMA_VERSION),
    generations: z.array(YieldOutcomeGenerationSchema).min(1),
    rankingObservations: z.array(YieldOutcomeRankingObservationSchema).min(1),
    historyObservations: z.array(YieldOutcomeHistoryObservationSchema).min(1),
  })
  .strict()
  .superRefine((dataset, context) => {
    const generationIds = new Set<string>();
    for (const [index, generation] of dataset.generations.entries()) {
      if (generationIds.has(generation.generationId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate generationId: ${generation.generationId}`,
          path: ["generations", index, "generationId"],
        });
      }
      generationIds.add(generation.generationId);
    }

    const rankingKeys = new Set<string>();
    for (const [index, observation] of dataset.rankingObservations.entries()) {
      if (!generationIds.has(observation.generationId)) {
        context.addIssue({
          code: "custom",
          message: `unknown generationId: ${observation.generationId}`,
          path: ["rankingObservations", index, "generationId"],
        });
      }
      const key = `${observation.generationId}\0${observation.stablecoinId}\0${observation.sourceKey}`;
      if (rankingKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "duplicate generation/stablecoin/source ranking observation",
          path: ["rankingObservations", index],
        });
      }
      rankingKeys.add(key);
    }

    const historyKeys = new Set<string>();
    for (const [index, observation] of dataset.historyObservations.entries()) {
      if (!generationIds.has(observation.generationId)) {
        context.addIssue({
          code: "custom",
          message: `unknown generationId: ${observation.generationId}`,
          path: ["historyObservations", index, "generationId"],
        });
      }
      const key = [
        observation.generationId,
        observation.stablecoinId,
        observation.sourceKey,
        observation.observedAt,
      ].join("\0");
      if (historyKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "duplicate generation/stablecoin/source/time history observation",
          path: ["historyObservations", index],
        });
      }
      historyKeys.add(key);
    }
  });

export type YieldOutcomeCohort = (typeof YIELD_OUTCOME_COHORTS)[number];
export type YieldOutcomeDataset = z.infer<typeof YieldOutcomeDatasetSchema>;
export type YieldOutcomeGeneration = z.infer<typeof YieldOutcomeGenerationSchema>;
export type YieldOutcomeRankingObservation = z.infer<typeof YieldOutcomeRankingObservationSchema>;
export type YieldOutcomeHistoryObservation = z.infer<typeof YieldOutcomeHistoryObservationSchema>;

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function normalizeYieldOutcomeDataset(dataset: YieldOutcomeDataset): YieldOutcomeDataset {
  return {
    schemaVersion: YIELD_OUTCOME_DATASET_SCHEMA_VERSION,
    generations: [...dataset.generations].sort(
      (left, right) => left.publishedAt - right.publishedAt || compareText(left.generationId, right.generationId),
    ),
    rankingObservations: dataset.rankingObservations
      .map((observation) => ({ ...observation, cohorts: [...observation.cohorts].sort(compareText) }))
      .sort(
        (left, right) =>
          compareText(left.generationId, right.generationId) ||
          compareText(left.stablecoinId, right.stablecoinId) ||
          compareText(left.sourceKey, right.sourceKey),
      ),
    historyObservations: [...dataset.historyObservations].sort(
      (left, right) =>
        left.observedAt - right.observedAt ||
        compareText(left.generationId, right.generationId) ||
        compareText(left.stablecoinId, right.stablecoinId) ||
        compareText(left.sourceKey, right.sourceKey),
    ),
  };
}

export function parseYieldOutcomeDataset(input: unknown): YieldOutcomeDataset {
  return normalizeYieldOutcomeDataset(YieldOutcomeDatasetSchema.parse(input));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function digestYieldOutcomeDataset(dataset: YieldOutcomeDataset): string {
  const normalized = normalizeYieldOutcomeDataset(dataset);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex");
}
