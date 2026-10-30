import { compareCodeUnits, sortedRecord } from "@shared/lib/compare";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import { z } from "zod";
import { parseJson } from "../json-parse";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS } from "./supply-attribution";

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY =
  "safety-score-v9:supply-attribution-source:v1";

/** One input-preparation cycle: every attribution run between two prepares can read the latest input. */
export const SOURCE_FIXED_INPUT_MAX_AGE_SEC = CRON_INTERVALS["prepare-safety-score-v9-input"];

const AggregateCirculatingByIdSchema = z.record(
  z.string(),
  z.object({
    circulating: z.record(z.string(), z.number().finite().nonnegative()),
    observedAtSec: z.number().int().nonnegative().nullable(),
  }).strict(),
);
const ChainCirculatingByIdSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({ current: z.number().finite().nonnegative() }).strict(),
  ),
);
const NavPriceByIdSchema = z.record(z.string(), z.strictObject({
  priceUsd: z.number().finite().positive(), sourceId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(), confidence: z.enum(["high", "medium", "low", "unknown"]),
}));

/**
 * The deployment-supply-census projection (PLAN §4.6). The attribution cohort
 * is the reviewed 10-asset allowlist; the census exists for the *open* gap
 * population across the whole active registry, so its denominator (aggregate
 * circulating), provider chain rows and reference prices travel here instead of
 * being re-read from the 1 MiB native input. Additive and optional: a source
 * without it keeps the attribution-only cohort.
 */
const DeploymentSupplyCensusProjectionSchema = z
  .strictObject({
    activeAssetIds: z.array(z.string().min(1)),
    aggregateCirculatingById: AggregateCirculatingByIdSchema,
    chainCirculatingById: ChainCirculatingByIdSchema,
    navPriceById: NavPriceByIdSchema,
    // The peg reference of the compiler input's `pegDataById`, the census's one
    // fallback unit value when the economic-supply NAV authority has no entry
    // (135 of 392 assets). Only usable rows travel: absence means unavailable,
    // never 1.
    pegReferenceById: z.record(z.string(), z.strictObject({
      valueUsd: z.number().finite().positive(),
      asOf: z.number().int().nonnegative(),
    })),
  });

const SafetyScoreV9SupplyAttributionSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-supply-attribution-source"),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    sourceGeneration: z.string().min(1),
    registryFingerprint: Sha256Schema,
    clockSec: z.number().int().nonnegative(),
    activeAssetIds: z.array(z.string().min(1)),
    aggregateCirculatingById: AggregateCirculatingByIdSchema,
    chainCirculatingById: ChainCirculatingByIdSchema,
    navPriceById: NavPriceByIdSchema.default({}),
    censusProjection: DeploymentSupplyCensusProjectionSchema.optional(),
  })
  .strict();

export type SafetyScoreV9SupplyAttributionSource = z.infer<
  typeof SafetyScoreV9SupplyAttributionSourceSchema
>;
export type SafetyScoreV9SupplyAttributionInput = Pick<
  SafetyScoreV9SupplyAttributionSource,
  | "baseInputGenerationId"
  | "sourceGeneration"
  | "registryFingerprint"
  | "clockSec"
  | "activeAssetIds"
  | "aggregateCirculatingById"
  | "chainCirculatingById"
> & Partial<Pick<SafetyScoreV9SupplyAttributionSource, "navPriceById">>;

export function buildSafetyScoreV9SupplyAttributionSource(
  input: Readonly<SafetyScoreV9CompilerInput>,
): SafetyScoreV9SupplyAttributionSource {
  const activeAssetIdSet = new Set(input.activeAssetIds);
  const activeAssetIds = SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
    (assetId) => activeAssetIdSet.has(assetId),
  ).sort();
  // Census population: every active asset that carries the audited aggregate
  // (the share denominator). An asset without one can never conserve a
  // partition, so it must not spend a cohort slot.
  const censusAssetIds = [...new Set(input.activeAssetIds)]
    .filter(assetId => input.aggregateCirculatingById[assetId] !== undefined)
    .sort(compareCodeUnits);

  return SafetyScoreV9SupplyAttributionSourceSchema.parse({
    schemaVersion: 1,
    kind: "safety-score-v9-supply-attribution-source",
    baseInputGenerationId: input.baseInputGenerationId,
    sourceGeneration: input.sourceGeneration,
    registryFingerprint: input.registryFingerprint,
    clockSec: input.clockSec,
    activeAssetIds,
    navPriceById: sortedRecord(Object.fromEntries(activeAssetIds.flatMap(assetId => {
      const price = input.navPriceById?.[assetId];
      return price ? [[assetId, price]] : [];
    }))),
    aggregateCirculatingById: sortedRecord(
      Object.fromEntries(
        activeAssetIds.flatMap((assetId) => {
          const row = input.aggregateCirculatingById[assetId];
          return row ? [[assetId, row] as const] : [];
        }),
      ),
    ),
    chainCirculatingById: sortedRecord(
      Object.fromEntries(
        activeAssetIds.map((assetId) => [
          assetId,
          sortedRecord(input.chainCirculatingById[assetId] ?? {}),
        ]),
      ),
    ),
    censusProjection: {
      activeAssetIds: censusAssetIds,
      aggregateCirculatingById: sortedRecord(
        Object.fromEntries(censusAssetIds.flatMap((assetId) => {
          const row = input.aggregateCirculatingById[assetId];
          return row ? [[assetId, row] as const] : [];
        })),
      ),
      chainCirculatingById: sortedRecord(
        Object.fromEntries(censusAssetIds.map((assetId) => [
          assetId,
          sortedRecord(input.chainCirculatingById[assetId] ?? {}),
        ])),
      ),
      navPriceById: sortedRecord(Object.fromEntries(censusAssetIds.flatMap(assetId => {
        const price = input.navPriceById?.[assetId];
        return price ? [[assetId, price] as const] : [];
      }))),
      pegReferenceById: sortedRecord(Object.fromEntries(censusAssetIds.flatMap(assetId => {
        const pegReference = input.pegDataById?.[assetId]?.pegReference;
        if (pegReference === null || pegReference === undefined) return [];
        if (!Number.isFinite(pegReference.valueUsd) || pegReference.valueUsd <= 0 ||
          !Number.isSafeInteger(pegReference.asOf) || pegReference.asOf < 0) return [];
        return [[assetId, { valueUsd: pegReference.valueUsd, asOf: pegReference.asOf }] as const];
      }))),
    },
  });
}

/** The census input surface: the whole active population, never the attribution allowlist. */
export interface SafetyScoreV9DeploymentSupplyCensusSourceView {
  readonly activeAssetIds: readonly string[];
  readonly aggregateCirculatingById: SafetyScoreV9SupplyAttributionSource["aggregateCirculatingById"];
  readonly chainCirculatingById: SafetyScoreV9SupplyAttributionSource["chainCirculatingById"];
  readonly navPriceById: SafetyScoreV9SupplyAttributionSource["navPriceById"];
  readonly pegReferenceById: Record<string, { readonly valueUsd: number; readonly asOf: number }>;
}

/**
 * Selects the population the census enumerates. `null` means the source carries
 * no projection: a source that predates the census schema has no population
 * data at all, so the lane must skip by name
 * (`deployment-supply-census-projection-missing`) instead of measuring the
 * 10-asset attribution allowlist — that fallback made a projection-less source
 * indistinguishable from a gap-free population (2026-10-30 incident).
 */
export function deploymentSupplyCensusSourceView(
  source: Readonly<SafetyScoreV9SupplyAttributionSource>,
): SafetyScoreV9DeploymentSupplyCensusSourceView | null {
  return source.censusProjection ?? null;
}

export function serializeSafetyScoreV9SupplyAttributionSource(
  source: SafetyScoreV9SupplyAttributionSource,
): string {
  return stableJsonStringifyV1(
    SafetyScoreV9SupplyAttributionSourceSchema.parse(source),
  );
}

export function parseSafetyScoreV9SupplyAttributionSource(
  value: unknown,
): SafetyScoreV9SupplyAttributionSource {
  const parsed = typeof value === "string"
    ? parseJson(value, { onFailure: () => undefined })
    : { ok: true as const, value };
  if (!parsed.ok) {
    throw new Error(`Malformed V9 supply-attribution source: ${parsed.message}`);
  }
  return SafetyScoreV9SupplyAttributionSourceSchema.parse(parsed.value);
}
